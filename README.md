# Jev Tetris

A real-time Tetris match in the browser against **Jev**, TypeSafe's decision
model, or **Laya**, an open decision model running on your own machine — or
watch Jev and Laya play each other. Not a chat wrapper — a versus game with garbage, spins, combos
and back-to-back chains, where every move the opponent makes is a decision the
model makes, live, while the piece is falling.

Both games run in the browser in one animation loop, so your inputs never make a
network round trip. The server does one job: given a position, ask a model where
the piece goes.

```
┌─ browser ────────────────────────────────┐        ┌─ server ──────────────┐
│  left game  (you, or the Jev bot)        │        │  reachability search  │
│  right game (Laya or Jev bot)            │◀──────▶│  candidate shortlist  │
│  one animation frame drives both         │ /decide│  one typed question   │
└──────────────────────────────────────────┘ ?model └─────┬───────────┬─────┘
                                                          │           │
                                                  /v1/systemone  /v1/systemone
                                                          │           │
                                                  TypeSafe (Jev)  ai/laya_server.py
                                                                  (Laya, local)
```

## Setup

**Requirements:** Node 18+ (uses the built-in `fetch`, no npm dependencies). For
Laya: Python 3.9+ and ~1.5 GB free disk; an Apple Silicon GPU (MPS) or CUDA is
used automatically when present, otherwise CPU.

You can run either model alone or both. The server starts with whatever is
available, and the VS screen shows which models are online.

### 1. Jev (TypeSafe API)

```bash
cp .env.example .env      # then put your TypeSafe API key in .env
```

`.env` is git-ignored. The key stays on the server; the browser never sees it.
Without a key the server still runs, and Jev's moves fall back to the shortlist's
own pick (labelled `FALLBACK` on screen).

### 2. Laya (local, no key)

[Laya Multilingual](https://huggingface.co/convaiinnovations/laya-multilingual)
(Apache 2.0) runs in a small Python sidecar that serves the same `/v1/systemone`
request shape as Jev:

```bash
python3 -m venv .venv-laya
.venv-laya/bin/pip install laya
.venv-laya/bin/python ai/laya_server.py     # first run downloads the model (~640 MB)
```

It listens on `127.0.0.1:8090` (`LAYA_PORT`, `LAYA_MODEL`, `LAYA_DEVICE` override
it; the game server finds it via `LAYA_URL`). Leave it running.

### 3. Start the game — gaming mode (one command)

```bash
./play.sh                 # or: npm run play
```

This starts Laya and the game server in the background, waits until both are
healthy, and opens http://localhost:8081. It also sets up Laya's Python
environment on first run if `.venv-laya` is missing. For speed (macOS, no admin
rights needed):

- both processes run at the highest throughput and latency QoS tiers
  (`taskpolicy -t 0 -l 0`), so they are never throttled as background work;
- Laya uses every performance core for its CPU work and the GPU (MPS) for the
  model, with no cap on PyTorch's unified-memory use;
- `caffeinate` keeps the Mac and display awake for as long as the server runs;
- it warns if Low Power Mode is on or the Mac is on battery.

```bash
./play.sh --boost         # also raise CPU priority to the maximum (sudo renice; asks for your password)
./play.sh status          # what is running, Laya's latency so far
./play.sh stop            # or: npm run stop
```

Logs go to `.run/laya.log` and `.run/server.log` (git-ignored). More RAM does
not make Laya faster: it needs ~1.3 GB and is limited by GPU compute.

To run just the game server in the foreground instead: `npm start`.

After changing server-side code, restart `node server.js` — an old process on
8081 keeps serving the old code (`pkill -f "node server.js"`).

`npm test` runs the engine and AI test suites offline — no key, no model needed.

## Playing

Choose the match on the VS screen:

| Match | Left board | Right board |
| --- | --- | --- |
| You vs Laya | you (keyboard) | Laya |
| You vs Jev | you (keyboard) | Jev |
| Jev vs Laya | Jev | Laya |

Each bot has its own speed: 0.8–3.5 pieces per second, unlimited, or **MAX**,
where the whole route and drop happen in one frame as soon as the decision
arrives. Laya defaults to MAX (~9 pieces/s on an M1 Pro, bound by its ~85 ms
inference); Jev defaults to 1.8.

Under each bot's HOLD box is a **decision log**, newest on top: the move played,
whether it was pre-planned or how long it took, the top 3 options with their
probabilities (the chosen one marked ✓), the model's confidence, and how many of
the reachable placements it was shown.

## Controls

| Key | Action |
| --- | --- |
| `←` `→` | move |
| `↓` | soft drop |
| `Space` | hard drop |
| `↑` / `X` | rotate clockwise |
| `Z` / `Ctrl` | rotate counter-clockwise |
| `A` | rotate 180 |
| `C` / `Shift` | hold |
| `Esc` | pause |

Handling is configurable in `public/input.js` (DAS 167 ms, ARR 33 ms, SDF 6 —
competitive-client defaults).

## How Jev plays

The interesting part of this project is what it took to make a decision model
play well. Three findings shaped the design, each measured rather than assumed:

**1. Jev cannot judge a board from ASCII.** Given the grid alone, choices were
flat or confidently wrong — one test picked the *worst* candidate at 0.71
confidence. Given the *measured consequences* of each option (`lines_sent`,
`holes_created`, `well_depth`, `cancels_incoming`, `combo_after`, …), it picks
rank 1 of 8 at 0.66–0.87 confidence. So nothing in the code asks Jev "is this
board good?"; it asks "which of these outcomes do you want?" — with raw counts,
no weights supplied.

**2. The shortlist is code's job, the trade-off is Jev's.** With spins and hold,
a piece has 60–120 reachable lock positions. A reachability search (`engine/search.js`)
finds them all. An evaluation distilled from published bots (`ai/evaluate.js`:
Cold Clear's features and weights, a versus garbage model, and one piece of
lookahead), re-tuned by self-play, ranks them and keeps the best 14, always
preserving the strongest attacks and one hold option. Within that shortlist, Jev
decides — including whether to attack or survive — and sees each option's
`strategy_rank` as advice. The research behind it is compacted in
[`ai/STRATEGY.md`](ai/STRATEGY.md).

**3. Decisions can happen before they are needed.** The round trip to Jev is
300 ms–1.2 s (2.4 s cold), which would otherwise stall every piece. But the
queue is known in advance: the moment a placement is chosen, the *next* piece's
position is projected from it and asked about while the current piece is still
travelling (`public/predict.js`). When the next piece appears as projected —
checked by fingerprinting every input the decision depended on — the answer is
already in hand. When reality disagrees (garbage arrived, the piece mislanded),
the fingerprint misses and it asks fresh. A wasted request, never a wrong move.

The objective text (`ai/battle.js`) also teaches the strategy explicitly, since
a model can't be assumed to know that a single sends nothing and wastes the
stack: survive first (defense = attack + lines cleared), never create holes,
attack in bulk (quads and T-spins, keep back-to-back alive), keep a well, and
finish an opponent who is near the top.

## Rules implemented

Modelled on TETR.IO's Season 2 versus rules (`engine/rules.js` documents
sources and which values are unverified for ranked play):

- SRS+ kicks, 180° rotations, lock delay with 15 resets, refilled on a new lowest row
- T-spin detection (3-corner rule, TST exception), all-mini+ for other pieces
- Attack table by clear type, +1 back-to-back bonus, combo scaling
- Garbage: caps per placement, hole columns, cancel-on-attack, surge release
  when a long back-to-back chain breaks
- Clutch clears, lock out, block out, garbage top-out

## Layout

```
engine/     pure game logic — no timers, no DOM (pieces, rules, engine)
  search.js     BFS over the piece's real state space → every reachable landing
ai/         the model boundary
  jev.js        pooled keep-alive HTTPS client for /v1/systemone
  laya.js       Laya client + compact encoding that fits Laya's token budget
  laya_server.py  local /v1/systemone sidecar running Laya (Python)
  ask.js        solo play: state + facts + typed questions     (measured findings here)
  battle.js     versus: candidate shortlist, facts, objective, parsing
  evaluate.js   shortlist evaluation: Cold Clear features, garbage model, lookahead
  STRATEGY.md   the Tetris-bot research, compacted, with sources
  heuristic.js  display-only baseline, so you can see where Jev disagrees
public/     the browser game
  engine/…      the same engine modules, served to the client and shared
  bot.js        plays a model's choices back as real inputs (paced, or MAX)
  predict.js    prefetch projection (pure — runs in the browser and the tests)
  render.js     canvas rendering and effects
server.js   static files + POST /decide?model=jev|laya + GET /health
test/       engine rules, SRS kicks, spins, search, prefetch projection, live bench
```

## Tests and benchmarking

```bash
npm test                  # engine + AI suites, offline
node test/bench.js 40     # live: plays N pieces through the real API and reports
                          # agreement, attack, spins, latency percentiles
DECIDER=laya node test/bench.js 50   # the same with Laya (sidecar running)
node test/versus.js 150   # headless Jev vs Laya with garbage exchanged
node test/selfplay.js 300 10 0.2   # evaluator alone under garbage pressure, no model
node test/tune.js 26 0.25          # re-tune evaluation weights by self-play
```

Improving the evaluation improves both bots, so measure it offline first with
`test/selfplay.js` (held-out seeds: pass a different seed range), then confirm
with the models. The current weights, on 10 held-out seeds x 300 pieces:

| garbage per piece | previous evaluator | Cold Clear weights | tuned (current) |
| --- | --- | --- | --- |
| 0 | 6/10 died | 0/10 died | 0/10 died |
| 0.2 | 10/10 died, 191 sent | 6/10 died, 392 sent | **1/10 died, 786 sent** |
| 0.3 | 10/10 died, 87 sent | 8/10 died, 381 sent | **4/10 died, 468 sent** |

The test suite includes a proof of the prefetch invariants: it plays real games,
projects before each placement, and requires every non-null projection to match
the live position exactly — a projection that drifted would be a decision made
for the wrong board.

## Notes

- **The key is never in the client.** Jev is only ever called by `server.js`.
- A model's decisions are shown on screen with confidence and latency; when a request
  fails, the fallback (the shortlist's own top pick) is labelled `FALLBACK`, never
  passed off as the model's choice.
- No license file yet — all rights reserved by default. Open an issue if you'd
  like one.

## How Laya compares

Laya reads at most 256 tokens of instructions + options and 1024 in total. Jev's
battle payload is 442 + 285 + 1602 tokens, so Laya gets a compact encoding
(`ai/laya.js`): up to 10 options, each carrying its own facts next to its option
marker, and a one-line objective.

On its own Laya is close to uniform over its options and, measured, leans *away*
from the best one; labelling options with their rank, or showing fewer, made it
worse. So the strategy reaches Laya as a **prior**: the pick maximises
`log softmax(score / 150) + log p_laya`. A confident Laya can still overrule it
(it does on ~19% of moves); a near-uniform one defers. The decision log shows the
combined probabilities and notes when the strategy overruled Laya's own pick.
`LAYA_PRIOR_T=0` turns the prior off.

Measured on an M1 Pro (32 GB), before → after this evaluation work:

| | Jev | Laya |
| --- | --- | --- |
| decision latency | ~300 ms (network) | ~85 ms (MPS fp32) |
| solo, attack per piece | 0.19 → **0.37** (6 quads / 100) | 0.12, topped out at 141 → **0.34, survived 200** |
| confidence in its pick | 0.44 → 0.74 | ~0.1 alone; 0.6 with the prior |
| head-to-head, seed 4242 | won both times | lasted 109 → 146 pieces, sent 6 → 19 |

For Laya: CPU is ~160 ms, MPS autocast fp16/bf16 is *slower* (170–240 ms), and
`model.half()` crashes in MPS matmul — so it runs fp32 on MPS. More RAM does not
help; the model needs ~1.3 GB and is compute-bound. The sidecar warms up at start
and keeps the GPU warm through idle gaps (a cold first call took 0.8–4 s).
