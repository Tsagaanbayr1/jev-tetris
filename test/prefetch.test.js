// The prefetch in bot.js only helps if its projection is exact: a projected
// position whose key matches the live one must BE the live one, or Jev would
// act on a decision made for a different board. So here we play real games,
// project before each chosen placement, play it through the real engine, and
// require every non-null projection to match the next live position exactly.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Game } from '../engine/engine.js'
import { candidatesFor } from '../ai/battle.js'
import { pathTo } from '../engine/search.js'
import { keyOf, projectAfter } from '../public/predict.js'

/** Play `c` for real, exactly as the bot does: hold if chosen, walk its path. */
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

/** The live position, in the same shape `keyOf` fingerprints. */
function livePosition(game) {
  return {
    board: game.board,
    current: game.current,
    hold: game.hold,
    queue: game.queue,
    canHold: game.canHold,
    combo: game.combo,
    b2b: game.b2b,
    incoming: game.incoming,
  }
}

test('prefetch projections match the real next position', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const game = new Game({ seed })
    let projected = 0
    let cleared = 0

    for (let i = 0; i < 40 && !game.gameOver; i++) {
      const { heuristic } = candidatesFor(livePosition(game))
      if (!heuristic) break

      const before = keyOf(livePosition(game)) // must not match the projection
      const next = projectAfter(game, heuristic)
      if (heuristic.lines > 0) cleared++

      play(game, heuristic)
      if (game.gameOver) break

      if (next) {
        projected++
        const after = keyOf(livePosition(game))
        assert.notEqual(after, before, 'board must have changed after a lock')
        assert.equal(
          after,
          keyOf(next),
          `seed ${seed} piece ${i}: projected position diverged from reality`
        )
      }
    }
    assert.ok(projected > 10, `seed ${seed}: too few projections exercised`)
    assert.ok(cleared > 0, `seed ${seed}: no line clears happened`)
  }
})

test('projection skips exactly when garbage is about to rise', () => {
  const game = new Game({ seed: 99 })
  game.receive(4) // pending garbage: a non-clearing lock would raise it

  for (let i = 0; i < 12 && !game.gameOver; i++) {
    const { heuristic } = candidatesFor(livePosition(game))
    const next = projectAfter(game, heuristic)

    if (heuristic.lines === 0) {
      // Garbage queued, nothing cleared: unpredictable, must refuse.
      assert.equal(next, null, 'must not project a rise')
    } else {
      // A clearing lock never raises garbage; sent lines cancel it, front
      // batch first, exactly as the engine will.
      assert.ok(next, 'a clearing lock with garbage queued is predictable')
    }

    play(game, heuristic)
    if (game.gameOver) break
  }
})