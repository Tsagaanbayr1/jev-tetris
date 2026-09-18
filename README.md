# Jev Tetris

A real-time Tetris match you play in the browser against **Jev**, TypeSafe's
decision model. Not a chat wrapper — a versus game with garbage, spins, combos
and back-to-back chains, where every move the opponent makes is a decision the
model makes, live, while the piece is falling.

Both games run in the browser in one animation loop, so your inputs never make a
network round trip. The server does one job: given a position, ask Jev where the
piece goes.

```
┌─ browser ────────────────────────────────┐        ┌─ server ──────────────┐
│  your game (input → engine)              │        │  reachability search  │
│  Jev's game (decision → real inputs)     │◀──────▶│  candidate shortlist  │
│  one animation frame drives both         │ /decide│  one typed question   │
└──────────────────────────────────────────┘        └──────────┬────────────┘
                                                          /v1/systemone
                                                               │
                                                        TypeSafe (Jev)
```

## Quick start

Node 18+ (uses the built-in `fetch`). No dependencies to install.

```bash
cp .env.example .env      # then put your TypeSafe API key in it
npm start                 # → http://localhost:8081
```

The API key stays on the server; the browser never sees it. `npm test` runs the
engine and AI test suites offline — no key needed.

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
competitive-client defaults). Jev's speed is set on the VS screen: 0.8 to 3.5
pieces per second, or unlimited.

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
finds them all; a quad-seeking score keeps the best 14, always preserving the
strongest attacks and one hold option. Within that shortlist, Jev decides —
including whether to attack or survive.

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
stack: survive first, never create holes, attack in bulk (quads over dribbles),
keep a well for the next I piece, and hold is your reserve.

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
  ask.js        solo play: state + facts + typed questions     (measured findings here)
  battle.js     versus: candidate shortlist, facts, objective, parsing
  heuristic.js  display-only baseline, so you can see where Jev disagrees
public/     the browser game
  engine/…      the same engine modules, served to the client and shared
  bot.js        plays Jev's choices back as real inputs at a visible pace
  predict.js    prefetch projection (pure — runs in the browser and the tests)
  render.js     canvas rendering and effects
server.js   static files + POST /decide + GET /health
test/       engine rules, SRS kicks, spins, search, prefetch projection, live bench
```

## Tests and benchmarking

```bash
npm test                  # engine + AI suites, offline
node test/bench.js 40     # live: plays N pieces through the real API and reports
                          # agreement, attack, spins, latency percentiles
```

The test suite includes a proof of the prefetch invariants: it plays real games,
projects before each placement, and requires every non-null projection to match
the live position exactly — a projection that drifted would be a decision made
for the wrong board.

## Notes

- **The key is never in the client.** Jev is only ever called by `server.js`.
- Jev's decisions are shown on screen with confidence and latency; when a request
  fails, the fallback (the shortlist's own top pick) is labelled `FALLBACK`, never
  passed off as the model's choice.
- No license file yet — all rights reserved by default. Open an issue if you'd
  like one.
