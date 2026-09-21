"""Local stand-in for TypeSafe's /v1/systemone, backed by Laya Multilingual.

Laya (convaiinnovations/laya-multilingual) is an open, non-autoregressive typed
decision model: same request shape as Jev (state + typed questions), same answer
shape (choice + probabilities + confidence). It runs on this machine, so there is
no API key and no network round trip.

    python ai/laya_server.py            # listens on 127.0.0.1:8090
    LAYA_PORT=9000 LAYA_MODEL=/path/to/checkpoint python ai/laya_server.py

POST /v1/systemone  { state, questions }  ->  { model, answers, usage }
GET  /health        ->  { ok, model, device }
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("USE_TF", "0")  # a TensorFlow probe can deadlock model construction
# Let the Metal backend use as much unified memory as it wants (no PyTorch cap).
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")

import torch  # noqa: E402
import laya  # noqa: E402

MODEL = os.environ.get("LAYA_MODEL", "convaiinnovations/laya-multilingual")
PORT = int(os.environ.get("LAYA_PORT", "8090"))

print(f"loading {MODEL} ...", flush=True)
agent = laya.load(MODEL, device=os.environ.get("LAYA_DEVICE"))
# One model, one device: requests are serialised rather than racing on it.
lock = threading.Lock()

# Measured on an M1 Pro: MPS fp32 ~90 ms, CPU ~160 ms, MPS autocast fp16/bf16
# SLOWER (170-240 ms), model.half() crashes in MPS matmul. So: fp32 on MPS.
# What does cost time is a cold GPU: the first call after a few idle seconds
# took 0.8-4 s. So warm up at start, then keep the GPU busy while idle.
WARM = {"state": {"piece": "T", "next": "I O S Z L"},
        "questions": {"q": {"type": "choice", "instructions": "Pick the best placement.",
                            "criteria": {f"o{i}": f"T, sent 0, holes +0, height {i}, bump 3, well 2" for i in range(8)}}}}
last_request = WARM
last_used = time.monotonic()


def predict(state, questions):
    with lock, torch.inference_mode():
        return agent.predict(state, questions)


def keep_warm():
    while True:
        time.sleep(1.0)
        # Only in real idle gaps: a warm-up run holds the lock and would delay a live request.
        if time.monotonic() - last_used > 2.0:
            try:
                predict(last_request["state"], last_request["questions"])
            except Exception:
                pass


for _ in range(5):
    predict(WARM["state"], WARM["questions"])
threading.Thread(target=keep_warm, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "model": MODEL, "device": str(agent.device)})
        self._json(404, {"detail": "not found"})

    def do_POST(self):
        global last_request, last_used
        if self.path != "/v1/systemone":
            return self._json(404, {"detail": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            started = time.perf_counter()
            out = predict(req["state"], req["questions"])
            last_request, last_used = req, time.monotonic()
            out["model"] = MODEL
            out["inferenceMs"] = round((time.perf_counter() - started) * 1000, 1)
            self._json(200, out)
        except (KeyError, ValueError, TypeError) as e:
            self._json(400, {"detail": str(e)})
        except Exception as e:  # keep serving; the game falls back on a 5xx
            self._json(500, {"detail": f"{type(e).__name__}: {e}"})

    def log_message(self, *args):  # the game server already logs every decision
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Laya on http://127.0.0.1:{PORT}  ({MODEL}, {agent.device})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
