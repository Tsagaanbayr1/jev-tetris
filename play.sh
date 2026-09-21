#!/usr/bin/env bash
# Gaming mode: run Laya and the game server in the background at full speed.
#
#   ./play.sh            start everything (or restart it) and open the game
#   ./play.sh --boost    same, plus top CPU priority via sudo renice (asks for your password)
#   ./play.sh status     what is running, and Laya's latency so far
#   ./play.sh stop       stop everything
#
# What "full speed" means here (macOS, no admin rights needed):
#   - both processes run at the highest throughput + latency QoS tiers (taskpolicy),
#     so macOS never parks them on efficiency cores or throttles them as background work;
#   - Laya uses every performance core for its CPU work and the GPU (MPS) for the model,
#     with no cap on how much unified memory PyTorch may take;
#   - caffeinate keeps the Mac (and display) awake for as long as the server runs.
# More RAM does not make Laya faster: it needs ~1.3 GB and is limited by GPU compute.

set -euo pipefail
cd "$(dirname "$0")"

RUN=.run
PORT=${PORT:-8081}
LAYA_PORT=${LAYA_PORT:-8090}
PY=.venv-laya/bin/python
mkdir -p "$RUN"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

pid_alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

stop_all() {
  for name in caffeinate server laya; do
    if [ -f "$RUN/$name.pid" ]; then
      kill "$(cat "$RUN/$name.pid")" 2>/dev/null || true
      rm -f "$RUN/$name.pid"
    fi
  done
  # Also copies started by hand (nohup node server.js ...), which would hold the ports.
  pkill -f "node server.js" 2>/dev/null || true
  pkill -f "ai/laya_server.py" 2>/dev/null || true
  sleep 1
}

wait_for() { # url seconds
  for _ in $(seq 1 "$2"); do
    curl -sf "$1" >/dev/null && return 0
    sleep 1
  done
  return 1
}

status() {
  for name in laya server caffeinate; do
    if pid_alive "$name"; then echo "  $name: running (pid $(cat "$RUN/$name.pid"))"
    else echo "  $name: stopped"; fi
  done
  if curl -sf "http://localhost:$PORT/health" >/dev/null; then
    curl -s "http://localhost:$PORT/health" | node -e '
      const h = JSON.parse(require("fs").readFileSync(0, "utf8")).models
      for (const [k, v] of Object.entries(h))
        console.log(`  ${k}: ${v.ok ? "online" : "offline — " + v.error}${v.n ? ` · ${v.n} decisions, p50 ${v.p50} ms, p90 ${v.p90} ms` : ""}`)'
  fi
}

start() {
  local boost=$1

  command -v node >/dev/null || { echo "node is not installed (need Node 18+)"; exit 1; }
  if [ ! -x "$PY" ]; then
    say "Setting up Laya's Python environment (one time)..."
    python3 -m venv .venv-laya
    .venv-laya/bin/pip install -q laya
  fi

  if pmset -g 2>/dev/null | grep -qE 'lowpowermode\s+1'; then
    echo "warning: Low Power Mode is ON — it slows the GPU. Turn it off in System Settings > Battery."
  fi
  if ! pmset -g batt 2>/dev/null | grep -q "AC Power"; then
    echo "note: on battery — plug in for the most consistent speed."
  fi

  say "Stopping anything already running..."
  stop_all

  local cores
  cores=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu)

  say "Starting Laya on :$LAYA_PORT ($cores performance cores + GPU)..."
  LAYA_PORT=$LAYA_PORT LAYA_THREADS=$cores \
    nohup taskpolicy -t 0 -l 0 "$PY" ai/laya_server.py > "$RUN/laya.log" 2>&1 &
  echo $! > "$RUN/laya.pid"
  # First run downloads the model (~640 MB); after that this takes ~10-20 s.
  if ! wait_for "http://127.0.0.1:$LAYA_PORT/health" 600; then
    echo "Laya did not start — see $RUN/laya.log"; tail -5 "$RUN/laya.log"; exit 1
  fi

  say "Starting the game server on :$PORT..."
  PORT=$PORT LAYA_URL="http://127.0.0.1:$LAYA_PORT" \
    nohup taskpolicy -t 0 -l 0 node server.js > "$RUN/server.log" 2>&1 &
  echo $! > "$RUN/server.pid"
  if ! wait_for "http://localhost:$PORT/health" 30; then
    echo "Game server did not start — see $RUN/server.log"; tail -5 "$RUN/server.log"; exit 1
  fi

  # Keep the Mac and display awake for exactly as long as the game server runs.
  nohup caffeinate -dimsu -w "$(cat "$RUN/server.pid")" > /dev/null 2>&1 &
  echo $! > "$RUN/caffeinate.pid"

  if [ "$boost" = 1 ]; then
    say "Raising CPU priority (sudo)..."
    sudo renice -n -20 -p "$(cat "$RUN/laya.pid")" "$(cat "$RUN/server.pid")" >/dev/null
  fi

  say "Gaming mode on."
  status
  echo "  logs: $RUN/laya.log, $RUN/server.log · stop with ./play.sh stop"
  open "http://localhost:$PORT" 2>/dev/null || true
}

case "${1:-start}" in
  start) start 0 ;;
  --boost|boost) start 1 ;;
  stop) stop_all; say "Stopped." ;;
  status) status ;;
  *) echo "usage: ./play.sh [start|--boost|status|stop]"; exit 1 ;;
esac
