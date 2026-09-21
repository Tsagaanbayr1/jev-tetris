// Headless Jev vs Laya: the same pipeline the browser bots use, turn by turn.
// Both boards get the same piece sequence; attacks are exchanged as garbage,
// and each piece advances that player's clock by 1/PPS so garbage delay applies.
//
//   node test/versus.js [maxPiecesEach]      (needs ai/laya_server.py running)

import { Game } from '../engine/engine.js'
import { JevClient } from '../ai/jev.js'
import { LayaClient, buildLayaDecision, combineWithPrior } from '../ai/laya.js'
import { candidatesFor, buildBattleState, buildBattleQuestions, readBattleDecision } from '../ai/battle.js'
import { pathTo } from '../engine/search.js'
import { columnHeights } from '../ai/heuristic.js'

const MAX = Number(process.argv[2] ?? 150)
const PPS = 1.8
const seed = Number(process.env.SEED ?? 4242)

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

const players = [
  { name: 'Jev', model: 'jev', client: new JevClient(), game: new Game({ seed, garbageSeed: seed + 1 }), fallbacks: 0 },
  { name: 'Laya', model: 'laya', client: new LayaClient(), game: new Game({ seed, garbageSeed: seed + 2 }), fallbacks: 0 },
]

async function turn(me, them) {
  const g = me.game
  const pos = {
    board: g.board, current: g.current, hold: g.hold, queue: g.queue, canHold: g.canHold,
    combo: g.combo, b2b: g.b2b, incoming: g.incoming ?? 0,
    opponent: { maxHeight: Math.max(...columnHeights(them.game.board)) },
  }
  const found = candidatesFor(pos)
  if (!found.candidates.length) return
  const { candidates, state, questions } = me.model === 'laya'
    ? buildLayaDecision(pos, found.candidates)
    : { candidates: found.candidates, state: buildBattleState(pos, found.candidates, pos.opponent),
        questions: buildBattleQuestions(found.candidates) }
  let pick = null
  try {
    let response = await me.client.ask(state, questions, { timeoutMs: 8000, retries: 1 })
    if (me.model === 'laya') response = combineWithPrior(response, candidates)
    pick = readBattleDecision(response, candidates).chosen
  } catch {}
  if (!pick) { me.fallbacks++; pick = found.heuristic }
  play(g, pick)
  // Advance the clock (garbage delay, gravity ramp) WITHOUT running gravity: a real
  // bot moves the next piece at once, but update() would let it fall and lock at
  // spawn first once gravity ramps up — which stacked towers in long games.
  g.time += 1000 / PPS
  for (const ev of g.events) if (ev.type === 'attack') them.game.receive(ev.lines)
  g.events.length = 0
}

console.log(`Jev vs Laya · seed ${seed} · up to ${MAX} pieces each`)
for (let i = 0; i < MAX; i++) {
  for (const [me, them] of [[players[0], players[1]], [players[1], players[0]]]) {
    if (!me.game.gameOver) await turn(me, them)
  }
  if (players.some((p) => p.game.gameOver)) break
  if ((i + 1) % 25 === 0) {
    console.log(`  piece ${i + 1}: ` + players.map((p) =>
      `${p.name} sent ${p.game.stats.attack} height ${Math.max(...columnHeights(p.game.board))}`).join(' | '))
  }
}
const winner = players.find((p) => !p.game.gameOver && players.some((q) => q.game.gameOver))
console.log('\n' + (winner ? `${winner.name.toUpperCase()} WINS` : `no top-out within ${MAX} pieces`))
for (const p of players) {
  const s = p.game.stats
  console.log(`${p.name.padEnd(5)} pieces ${s.pieces}  lines ${s.lines}  sent ${s.attack}  received ${s.received}` +
    `  quads ${s.quads}  spins ${s.spins}  fallbacks ${p.fallbacks}  p50 ${p.client.stats().p50}ms`)
}
