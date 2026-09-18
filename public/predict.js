// Projection for Jev's prefetch: the position the NEXT piece will appear in,
// assuming the chosen placement lands where it was told to.
//
// Pure — no DOM, no fetch — so the exact code that prefetches in the browser
// (bot.js) also runs in the Node tests (test/prefetch.test.js). Anything the
// projection cannot predict exactly (garbage about to rise, a blocked spawn)
// yields null: the caller then skips the prefetch and asks fresh instead.

import { ROWS, SPAWN_X, SPAWN_Y } from '../engine/pieces.js'
import { collides, computeAttack, clearFullRows } from '../engine/engine.js'

/** Where a freshly spawned piece of `type` starts (mirrors Game.spawn). */
export function spawnState(board, type) {
  const p = { type, rot: 0, x: SPAWN_X[type], y: SPAWN_Y }
  if (collides(board, type, 0, p.x, p.y)) return null
  if (!collides(board, type, 0, p.x, p.y + 1)) p.y++
  return p
}

/**
 * Fingerprint of everything a decision depends on. A prefetched answer is only
 * used if the live position when the next piece appears has this same key.
 */
export function keyOf(pos) {
  return JSON.stringify([
    pos.board,
    pos.current.type,
    pos.hold,
    pos.canHold,
    pos.combo,
    pos.b2b,
    pos.incoming,
    pos.queue.slice(0, 8),
  ])
}

/**
 * The position after `choice` locks, with the next piece spawned — or null if
 * the outcome is not predictable. `game` is the live Game the choice came from;
 * `opponentHeight` (or null) is only advisory context for the decision.
 */
export function projectAfter(game, choice, opponentHeight = null) {
  // Garbage rises on a lock that clears nothing, and its hole columns come
  // from the garbage RNG: predicting that board is guesswork. Skip.
  if (choice.lines === 0 && game.garbageQueue.length) return null

  const placed = game.board.map((row) => row.slice())
  for (const [x, y] of choice.cells) {
    if (y >= 0 && y < ROWS) placed[y][x] = choice.type
  }
  const { board, rows } = clearFullRows(placed)
  const lines = rows.length
  const allClear = board.every((row) => row.every((c) => !c))
  const atk = computeAttack({ combo: game.combo, b2b: game.b2b }, choice.spin, lines, allClear)

  // Sent lines cancel pending garbage, front batch first, as the engine does.
  let left = atk.sent + atk.surge
  const garbage = game.garbageQueue.map((b) => ({ ...b }))
  while (left > 0 && garbage.length) {
    const n = Math.min(left, garbage[0].lines)
    garbage[0].lines -= n
    left -= n
    if (garbage[0].lines === 0) garbage.shift()
  }

  // Hold bookkeeping: stashing the current piece brings the held one in, and
  // an empty hold pulls the replacement out of the queue right away.
  let hold = game.hold
  const queue = game.queue.slice()
  if (choice.useHold) {
    hold = game.current.type
    if (game.hold == null) queue.shift()
  }
  // The next piece's own spawn then consumes the queue head, exactly as
  // Game.spawn does — the queue the next decision sees has it removed.
  const type = queue.shift()

  const current = spawnState(board, type)
  if (!current) return null // the spawn would be blocked: not predictable
  return {
    board,
    current,
    hold,
    queue,
    canHold: true, // the lock always restores hold
    combo: atk.combo,
    b2b: atk.b2b,
    incoming: garbage.reduce((a, b) => a + b.lines, 0),
    opponent: opponentHeight == null ? null : { maxHeight: opponentHeight },
  }
}