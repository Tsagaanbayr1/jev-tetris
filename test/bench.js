// Headless run of Jev's versus pipeline, exactly as the game uses it: search
// every reachable placement (spins and hold included), shortlist, ask Jev, then
// replay the chosen input path through the real engine.
//
// Measures whether Jev plays competently, how much it attacks, and how often it
// agrees with the shortlist's own top pick. No opponent, so no garbage.
//
//   node test/bench.js [pieces] [--verbose]

import { Game } from '../engine/engine.js'
import { JevClient } from '../ai/jev.js'
import {
  candidatesFor, buildBattleState, buildBattleQuestions, readBattleDecision,
} from '../ai/battle.js'
import { pathTo } from '../engine/search.js'

const N = Number(process.argv[2] ?? 40)
const VERBOSE = process.argv.includes('--verbose')
const seed = Number(process.env.SEED ?? 12345)

/** Play `c` for real: hold if chosen, walk its path, hard drop. */
function play(game, c) {
  if (c.useHold) game.holdPiece()
  const path = pathTo(game.board, game.current, c) ?? []
  for (const step of path) {
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

async function main() {
  const jev = new JevClient()
  const game = new Game({ seed })
  let agreed = 0
  let fallbacks = 0
  let sumConf = 0
  let spins = 0

  console.log(`bench: ${N} pieces, seed ${seed}, model ${jev.model}`)
  console.log('piece  type  move           sends  spin   conf    ms  agree  opts')
  console.log('-'.repeat(70))

  for (let i = 0; i < N && !game.gameOver; i++) {
    const pos = {
      board: game.board, current: game.current, hold: game.hold, queue: game.queue,
      canHold: game.canHold, combo: game.combo, b2b: game.b2b, incoming: 0,
    }
    const { candidates, total, heuristic } = candidatesFor(pos)
    if (!candidates.length) break

    let d = null
    try {
      const response = await jev.ask(buildBattleState(pos, candidates), buildBattleQuestions(candidates))
      d = readBattleDecision(response, candidates)
    } catch (err) {
      if (VERBOSE) console.log(`  ! ${err.message}`)
    }
    const pick = d?.chosen ?? heuristic
    if (!d?.chosen) fallbacks++
    else sumConf += d.confidence ?? 0
    if (pick.id === heuristic.id) agreed++
    if (pick.spin !== 'none' && pick.lines) spins++

    if (VERBOSE || i < 25) {
      console.log(
        [
          String(i + 1).padStart(5),
          pick.type.padEnd(5),
          pick.id.padEnd(14),
          String(pick.sent).padStart(5),
          pick.spin.padStart(5),
          (d?.confidence != null ? d.confidence.toFixed(2) : ' -- ').padStart(6),
          String(d?.latencyMs ?? '--').padStart(5),
          (pick.id === heuristic.id ? 'yes' : 'no').padStart(6),
          `${candidates.length}/${total}`.padStart(7),
        ].join(' ')
      )
    }

    play(game, pick)
    game.events.length = 0
  }

  const st = jev.stats()
  const pieces = game.stats.pieces
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a')
  console.log('\n' + '='.repeat(70))
  console.log(`pieces ${pieces}   lines ${game.stats.lines}   attack sent ${game.stats.attack}` +
    `   (${(game.stats.attack / Math.max(1, pieces)).toFixed(2)} per piece)`)
  console.log(`spin clears ${spins}   quads ${game.stats.quads}   max combo ${Math.max(0, game.stats.maxCombo)}` +
    `   max B2B ${Math.max(0, game.stats.maxB2b)}   top out ${game.gameOver ? 'YES' : 'no'}`)
  console.log(`agrees with shortlist's top pick ${pct(agreed, pieces)}   fallbacks ${fallbacks}` +
    `   mean conf ${(sumConf / Math.max(1, pieces - fallbacks)).toFixed(2)}`)
  console.log(`latency p50 ${st.p50}ms  p90 ${st.p90}ms  max ${st.max}ms  (n=${st.n})`)
}

main().catch((err) => {
  console.error('bench failed:', err)
  process.exit(1)
})
