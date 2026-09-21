import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COLS, ROWS } from '../engine/pieces.js'
import { emptyBoard } from '../engine/engine.js'
import { boardFeatures, scoreBoard, scoreMove, dropPlacements, liftAfter, W } from '../ai/evaluate.js'
import { candidatesFor } from '../ai/battle.js'
import { Game } from '../engine/engine.js'

const BOTTOM = ROWS - 1

function fillRow(board, y, except = []) {
  for (let x = 0; x < COLS; x++) board[y][x] = except.includes(x) ? null : 'X'
}

test('a sealed hole is a cavity; a hole open to the side is an overhang', () => {
  const sealed = emptyBoard()
  fillRow(sealed, BOTTOM, [4])
  fillRow(sealed, BOTTOM - 1)
  const f = boardFeatures(sealed)
  assert.equal(f.cavity, 1)
  assert.equal(f.overhang, 0)
  assert.equal(f.covered, 1) // one filled cell over the topmost hole

  const open = emptyBoard()
  open[BOTTOM][3] = 'X' // column 3 filled on the floor
  open[BOTTOM - 1][4] = 'X' // a block hanging over column 4's floor cell; column 5 is empty
  assert.equal(boardFeatures(open).overhang, 1)
  assert.equal(boardFeatures(open).cavity, 0)
})

test('finds a T-spin double slot', () => {
  const b = emptyBoard()
  fillRow(b, BOTTOM, [4]) // lower row: only the stem cell open
  fillRow(b, BOTTOM - 1, [3, 4, 5]) // upper row: the 3-wide gap
  b[BOTTOM - 2][3] = 'X' // the overhang roof on one side
  assert.equal(boardFeatures(b).tslot, 2)
  b[BOTTOM - 2][3] = null
  assert.equal(boardFeatures(b).tslot, 0, 'no roof, no spin')
})

test('holes and height make a board worse; rising garbage is counted', () => {
  const clean = emptyBoard()
  fillRow(clean, BOTTOM, [9])
  const holed = emptyBoard()
  fillRow(holed, BOTTOM, [9])
  holed[BOTTOM - 1][9] = 'X' // covers the gap: a cavity
  assert.ok(scoreBoard(boardFeatures(clean)) > scoreBoard(boardFeatures(holed)))
  assert.ok(scoreBoard(boardFeatures(clean)) > scoreBoard(boardFeatures(clean, 4)), 'garbage lift hurts')
})

test('singles are penalised when safe, not under pressure; quads always pay', () => {
  const atk = { sent: 0, surge: 0, combo: 0, b2b: -1 }
  const single = { type: 'L', spin: 'none', lines: 1, path: [] }
  const prev = { combo: -1, b2b: -1 }
  assert.ok(scoreMove(single, atk, prev, { incoming: 0, oppHeight: 0, danger: false }) < 0)
  assert.ok(scoreMove(single, atk, prev, { incoming: 0, oppHeight: 0, danger: true }) >= 0)
  const quad = { type: 'I', spin: 'none', lines: 4, path: [] }
  assert.ok(scoreMove(quad, { sent: 4, surge: 0, combo: 0, b2b: 0 }, prev, { incoming: 0, oppHeight: 0 }) > 300)
})

test('garbage only lifts when nothing is cleared and it is not cancelled', () => {
  assert.equal(liftAfter({ lines: 0 }, { sent: 0, surge: 0 }, 3), 3)
  assert.equal(liftAfter({ lines: 0 }, { sent: 2, surge: 0 }, 3), 1)
  assert.equal(liftAfter({ lines: 2 }, { sent: 1, surge: 0 }, 3), 0)
})

test('drop placements cover every rotation and column and stay on the board', () => {
  const ps = dropPlacements(emptyBoard(), 'T')
  assert.equal(ps.length, 8 + 9 + 8 + 9) // T: 8 flat positions x2, 9 upright x2
  for (const p of ps) assert.equal(p.board.length, ROWS)
})

test('shortlist ranks are 1-based and the top pick is rank 1', () => {
  const g = new Game({ seed: 11 })
  const pos = { board: g.board, current: g.current, hold: g.hold, queue: g.queue, canHold: true, combo: -1, b2b: -1, incoming: 0 }
  const { candidates, heuristic } = candidatesFor(pos)
  assert.equal(heuristic.rank, 1)
  assert.ok(candidates.every((c) => Number.isInteger(c.rank) && c.rank >= 1))
  assert.ok(W.lookahead > 0)
})
