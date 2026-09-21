// Offline strength test for the shortlist evaluator — no model calls.
//
// Plays the shortlist's own top pick (what the bots fall back to, and the
// ordering both models choose from) under steady garbage pressure, across
// several seeds, and reports survival and attack. Use it to compare evaluator
// changes: a stronger shortlist makes Jev and Laya stronger too.
//
//   node test/selfplay.js [pieces] [seeds] [garbagePerPiece]

import { Game } from '../engine/engine.js'
import { candidatesFor } from '../ai/battle.js'
import { pathTo } from '../engine/search.js'
import { columnHeights } from '../ai/heuristic.js'

const N = Number(process.argv[2] ?? 300)
const SEEDS = Number(process.argv[3] ?? 6)
const PRESSURE = Number(process.argv[4] ?? 0.45) // incoming garbage lines per piece
const PPS = 1.8

function play(game, c) {
  if (c.useHold) game.holdPiece()
  for (const step of pathTo(game.board, game.current, c) ?? []) {
    if (step === 'left') game.move(-1)
    else if (step === 'right') game.move(1)
    else if (step === 'cw') game.rotate(1)
    else if (step === 'ccw') game.rotate(-1)
    else if (step === '180') game.rotate(2)
    else if (step === 'down') game.stepDown()
    else if (step === 'sonic') while (game.stepDown()) {}
  }
  game.hardDrop()
}

/** Play `seeds` games; returns per-seed rows. `from` offsets the seeds (held-out sets). */
export function selfplay({ pieces = 300, seeds = 6, pressure = 0.45, from = 1 } = {}) {
  const rows = []
  let ms = 0
  let decisions = 0
  for (let seed = from; seed < from + seeds; seed++) {
    const g = new Game({ seed, garbageSeed: seed + 100 })
    let owed = 0
    let heightSum = 0
    for (let i = 0; i < pieces && !g.gameOver; i++) {
      // An opponent sending `pressure` lines per piece, in chunks of 3+ like real attacks.
      owed += pressure
      if (owed >= 3) {
        g.receive(Math.floor(owed))
        owed -= Math.floor(owed)
      }
      const pos = {
        board: g.board, current: g.current, hold: g.hold, queue: g.queue, canHold: g.canHold,
        combo: g.combo, b2b: g.b2b, incoming: g.incoming ?? 0, opponent: null,
      }
      const t = performance.now()
      const { heuristic } = candidatesFor(pos)
      ms += performance.now() - t
      decisions++
      if (!heuristic) break
      play(g, heuristic)
      // Advance the clock (garbage delay, gravity ramp) WITHOUT running gravity: a real
      // bot moves the next piece at once, but update() would let it fall and lock at
      // spawn first once gravity ramps up — which stacked towers in long games.
      g.time += 1000 / PPS
      g.events.length = 0
      heightSum += Math.max(...columnHeights(g.board))
    }
    const s = g.stats
    rows.push({ seed, pieces: s.pieces, dead: g.gameOver, sent: s.attack, app: s.attack / Math.max(1, s.pieces),
      quads: s.quads, spins: s.spins, avgH: heightSum / Math.max(1, s.pieces) })
  }
  rows.msPerDecision = ms / Math.max(1, decisions)
  return rows
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = selfplay({ pieces: N, seeds: SEEDS, pressure: PRESSURE })
  console.log(`selfplay: ${N} pieces x ${SEEDS} seeds, garbage ${PRESSURE}/piece`)
  console.log('seed  pieces  died  sent   APP   quads spins  avgH')
  for (const r of rows) {
    console.log(`${String(r.seed).padStart(4)} ${String(r.pieces).padStart(7)} ${r.dead ? ' yes' : '  no'}` +
      ` ${String(r.sent).padStart(5)} ${r.app.toFixed(2).padStart(5)} ${String(r.quads).padStart(6)}` +
      ` ${String(r.spins).padStart(5)} ${r.avgH.toFixed(1).padStart(5)}`)
  }
  const sum = (k) => rows.reduce((a, r) => a + (typeof r[k] === 'boolean' ? +r[k] : r[k]), 0)
  console.log(`TOTAL  pieces ${sum('pieces')}  deaths ${sum('dead')}/${SEEDS}  sent ${sum('sent')}` +
    `  APP ${(sum('sent') / Math.max(1, sum('pieces'))).toFixed(3)}  quads ${sum('quads')}  spins ${sum('spins')}` +
    `  avgH ${(sum('avgH') / SEEDS).toFixed(1)}  shortlist ${rows.msPerDecision.toFixed(1)} ms/decision`)
}
