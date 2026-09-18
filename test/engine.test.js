import { test } from 'node:test'
import assert from 'node:assert/strict'

import { COLS, ROWS, BUFFER, CELLS, kicksFor, cellsAt, TYPES } from '../engine/pieces.js'
import { Game, detectSpin, computeAttack, emptyBoard } from '../engine/engine.js'
import { TIMING } from '../engine/rules.js'
import { searchPlacements, pathTo } from '../engine/search.js'
import { enumerateLandings } from '../engine/placements.js'

const BOTTOM = ROWS - 1

function fillRow(board, y, except = []) {
  for (let x = 0; x < COLS; x++) board[y][x] = except.includes(x) ? null : 'X'
}

/** A game with an empty board and a chosen current piece. */
function gameWith(type, rot, x, y) {
  const g = new Game({ seed: 1 })
  g.board = emptyBoard()
  g.current = { type, rot, x, y }
  g.events.length = 0
  return g
}

/** The classic T-spin double slot at columns 3-5 on the bottom two rows. */
function tsdBoard() {
  const b = emptyBoard()
  fillRow(b, BOTTOM, [4])
  fillRow(b, BOTTOM - 1, [3, 4, 5])
  for (let x = 0; x <= 3; x++) b[BOTTOM - 2][x] = 'X' // the roof over the slot
  return b
}

// --- geometry ---------------------------------------------------------------

test('every piece has four rotation states with four cells', () => {
  for (const t of TYPES) {
    assert.equal(CELLS[t].length, 4, `${t} state count`)
    for (let r = 0; r < 4; r++) assert.equal(CELLS[t][r].length, 4, `${t} rot ${r}`)
  }
})

test('cellsAt agrees with the rotation tables', () => {
  assert.deepEqual(cellsAt('O', 0, 4, 0), [[4, 0], [5, 0], [4, 1], [5, 1]])
  assert.deepEqual(cellsAt('I', 1, 3, 0), [[5, 0], [5, 1], [5, 2], [5, 3]])
})

// --- kicks (SRS+) -------------------------------------------------------------

test('JLSTZ kicks are standard SRS (y flipped for screen coords)', () => {
  // 0->R published as (0,0) (-1,0) (-1,+1) (0,-2) (-1,-2) with +y up.
  assert.deepEqual(kicksFor('T', 0, 1), [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]])
})

test('I kicks are the SRS+ left/right-symmetric set, not standard SRS', () => {
  // SRS+ 0->R is (+1,0) (-2,0) (-2,-1) (+1,+2) with +y up.
  assert.deepEqual(kicksFor('I', 0, 1), [[0, 0], [1, 0], [-2, 0], [-2, 1], [1, -2]])
  assert.deepEqual(kicksFor('I', 0, 3), [[0, 0], [-1, 0], [2, 0], [2, 1], [-1, -2]])
})

test('180 rotation uses its own kick table', () => {
  assert.deepEqual(kicksFor('T', 0, 2), [[0, 0], [0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]])
  assert.deepEqual(kicksFor('I', 1, 3), [[0, 0], [1, 0]])
  assert.deepEqual(kicksFor('O', 0, 2), [[0, 0]])
})

test('T rotates off the floor by kicking up-left', () => {
  const g = gameWith('T', 0, 3, BOTTOM - 1)
  assert.equal(g.rotate(1), true)
  assert.deepEqual({ rot: g.current.rot, x: g.current.x, y: g.current.y }, { rot: 1, x: 2, y: BOTTOM - 2 })
})

test('rotate 180 flips the piece', () => {
  const g = gameWith('T', 0, 3, 20)
  assert.equal(g.rotate(2), true)
  assert.equal(g.current.rot, 2)
})

// --- bag ---------------------------------------------------------------------

test('the bag yields every piece once per 7', () => {
  const g = new Game({ seed: 42 })
  g.bag = []
  g.queue = []
  const drawn = []
  for (let i = 0; i < 700; i++) {
    g._fillQueue()
    drawn.push(g.queue.shift())
  }
  for (let i = 0; i < drawn.length; i += 7) {
    assert.equal(new Set(drawn.slice(i, i + 7)).size, 7, `bag ${i / 7}`)
  }
})

test('the same seed gives both players the same pieces', () => {
  const a = new Game({ seed: 99, garbageSeed: 1 })
  const b = new Game({ seed: 99, garbageSeed: 2 })
  assert.equal(a.current.type, b.current.type)
  assert.deepEqual(a.queue, b.queue)
})

// --- time: gravity and lock delay -----------------------------------------------

test('gravity moves the piece down over time, and it locks after lock delay', () => {
  const g = new Game({ seed: 3 })
  const y0 = g.current.y
  for (let i = 0; i < 60; i++) g.update(1000 / 60) // one second at 0.02 G = 1.2 rows
  assert.equal(g.current.y, y0 + 1)

  g.current.y = g.ghostY() // put it on the floor
  const before = g.stats.pieces
  g.update(TIMING.lockDelay - 20)
  assert.equal(g.stats.pieces, before, 'not locked yet')
  g.update(40)
  assert.equal(g.stats.pieces, before + 1, 'locked once lock delay ran out')
})

test('moving on the ground resets lock delay, but only 15 times', () => {
  const g = gameWith('T', 0, 3, BOTTOM - 1)
  for (let i = 0; i < 15; i++) {
    g.update(400)
    g.move(i % 2 ? 1 : -1)
  }
  assert.equal(g.stats.pieces, 0, '15 resets keep it alive')
  g.move(1)
  g.update(1)
  assert.equal(g.stats.pieces, 1, 'out of resets: locks on the next touch')
})

// --- clears -------------------------------------------------------------------

test('completing a row clears it and shifts everything down', () => {
  const g = gameWith('I', 1, 1, BOTTOM - 3)
  fillRow(g.board, BOTTOM, [3])
  g.hardDrop()
  assert.equal(g.stats.lines, 1)
  assert.equal(g.board[BOTTOM][3], 'I')
  assert.equal(g.board[BOTTOM - 3][3], null)
})

// --- spins ----------------------------------------------------------------------

test('T-spin: both front corners plus a back corner is a full spin', () => {
  const b = emptyBoard()
  b[30][3] = 'X' // front-left (T rot 0 points up)
  b[30][5] = 'X' // front-right
  b[32][3] = 'X' // back-left
  const t = { type: 'T', rot: 0, x: 3, y: 30 }
  assert.equal(detectSpin(b, t, { kick: 0, dir: 1 }), 'full')
})

test('T-spin: one front corner is a mini', () => {
  const b = emptyBoard()
  b[30][3] = 'X'
  b[32][3] = 'X'
  b[32][5] = 'X'
  const t = { type: 'T', rot: 0, x: 3, y: 30 }
  assert.equal(detectSpin(b, t, { kick: 0, dir: 1 }), 'mini')
})

test('T-spin mini upgrades to full when the rotation used the (1, 2 down) kick', () => {
  const b = emptyBoard()
  // rot 1 points right: front corners are (x+2, y) and (x+2, y+2)
  b[30][5] = 'X' // one front corner
  b[30][3] = 'X'
  b[32][3] = 'X'
  const t = { type: 'T', rot: 1, x: 3, y: 30 }
  assert.equal(detectSpin(b, t, { kick: 0, dir: 1 }), 'mini')
  // kick 4 of 0->R is (-1, +2): the TST / fin kick
  assert.equal(detectSpin(b, t, { kick: 4, dir: 1 }), 'full')
})

test('no spin without a rotation as the last action', () => {
  const b = emptyBoard()
  b[30][3] = 'X'
  b[30][5] = 'X'
  b[32][3] = 'X'
  assert.equal(detectSpin(b, { type: 'T', rot: 0, x: 3, y: 30 }, null), 'none')
})

test('all-spin: a non-T piece that cannot move after rotating is a mini spin', () => {
  const b = emptyBoard()
  // S rot 0 at (4, 30) occupies (5,30) (6,30) (4,31) (5,31). Box it in.
  for (const [x, y] of [[4, 30], [7, 30], [3, 31], [6, 31], [5, 29], [6, 29], [4, 32], [5, 32]]) b[y][x] = 'X'
  const s = { type: 'S', rot: 0, x: 4, y: 30 }
  assert.equal(detectSpin(b, s, { kick: 0, dir: 1 }), 'mini')
  assert.equal(detectSpin(emptyBoard(), s, { kick: 0, dir: 1 }), 'none', 'free to move: no spin')
})

// --- attack ------------------------------------------------------------------------

const fresh = { combo: -1, b2b: -1 }

test('attack table: double 1, triple 2, quad 4, T-spin double 4, single 0', () => {
  assert.equal(computeAttack(fresh, 'none', 1).sent, 0)
  assert.equal(computeAttack(fresh, 'none', 2).sent, 1)
  assert.equal(computeAttack(fresh, 'none', 3).sent, 2)
  assert.equal(computeAttack(fresh, 'none', 4).sent, 4)
  assert.equal(computeAttack(fresh, 'full', 1).sent, 2)
  assert.equal(computeAttack(fresh, 'full', 2).sent, 4)
  assert.equal(computeAttack(fresh, 'full', 3).sent, 6)
  assert.equal(computeAttack(fresh, 'mini', 2).sent, 1)
})

test('back-to-back adds one line to the second difficult clear in a row', () => {
  const first = computeAttack(fresh, 'none', 4)
  assert.equal(first.b2b, 0)
  const second = computeAttack({ combo: -1, b2b: first.b2b }, 'full', 2)
  assert.equal(second.sent, 5, 'TSD 4 + B2B 1')
})

test('combo scales attack, and a long combo of singles still sends', () => {
  // third consecutive clear (combo 2): a double sends floor(1 * 1.5) = 1
  assert.equal(computeAttack({ combo: 1, b2b: -1 }, 'none', 2).sent, 1)
  // quad at combo 4: floor(4 * 2) = 8
  assert.equal(computeAttack({ combo: 3, b2b: -1 }, 'none', 4).sent, 8)
  // singles at combo 4: ln(1 + 1.25 * 4) = 1.79 -> 1
  assert.equal(computeAttack({ combo: 3, b2b: -1 }, 'none', 1).sent, 1)
})

test('breaking a B2B chain of 4+ releases a surge', () => {
  const r = computeAttack({ combo: -1, b2b: 5 }, 'none', 1)
  assert.equal(r.surge, 5)
  assert.equal(r.b2b, -1)
  assert.equal(computeAttack({ combo: -1, b2b: 3 }, 'none', 1).surge, 0, 'too short to surge')
})

test('an all clear adds 5 lines', () => {
  assert.equal(computeAttack(fresh, 'none', 2, true).sent, 1 + 5)
})

// --- garbage -----------------------------------------------------------------------

test('garbage waits out its delay, then rises on a lock that clears nothing', () => {
  const g = new Game({ seed: 5 })
  g.receive(3)
  g.hardDrop() // too soon: garbage is still travelling
  assert.equal(g.board[BOTTOM].filter((c) => c === 'G').length, 0)

  g.update(TIMING.garbageDelay + 1)
  g.hardDrop()
  const rows = g.board.slice(ROWS - 3)
  for (const row of rows) {
    assert.equal(row.filter((c) => c === 'G').length, COLS - 1, 'one hole per row')
  }
  const holes = rows.map((row) => row.indexOf(null))
  assert.equal(new Set(holes).size, 1, 'rows from one attack share the hole column')
  assert.equal(g.incoming, 0)
})

test('your own attack cancels incoming garbage before anything is sent', () => {
  const g = new Game({ seed: 5 })
  g.board[BOTTOM][0] = 'X' // not an all clear
  g.receive(3)
  g._attack('I', 'none', 4) // a quad: 4 lines
  assert.equal(g.incoming, 0, 'all 3 incoming lines cancelled')
  assert.equal(g.stats.cancelled, 3)
  const sent = g.events.filter((e) => e.type === 'attack')
  assert.deepEqual(sent.map((e) => e.lines), [1], 'only the remainder is sent')
})

test('no more than 8 garbage rows rise in one placement', () => {
  const g = new Game({ seed: 5 })
  g.receive(12)
  g.update(TIMING.garbageDelay + 1)
  g.hardDrop()
  const garbageRows = g.board.filter((row) => row.includes('G')).length
  assert.equal(garbageRows, 8)
  assert.equal(g.incoming, 4)
})

// --- top out --------------------------------------------------------------------------

test('a blocked spawn tops the player out', () => {
  const g = new Game({ seed: 7 })
  for (let y = BUFFER - 3; y < ROWS; y++) fillRow(g.board, y, [y % COLS])
  g.lastCleared = false
  g.spawn()
  assert.equal(g.gameOver, true)
  assert.ok(g.events.some((e) => e.type === 'topout'))
})

// --- move search ------------------------------------------------------------------------

test('the search finds the T-spin double, and its path performs one', () => {
  const board = tsdBoard()
  const start = { type: 'T', rot: 0, x: 3, y: BUFFER - 1 }
  const found = searchPlacements(board, start).filter((c) => c.spin === 'full' && c.lines === 2)
  assert.ok(found.length >= 1, 'a full T-spin double is reachable')

  // Replay the path through the real engine and check it really is a TSD.
  const g = gameWith('T', 0, 3, BUFFER - 1)
  g.board = tsdBoard()
  const c = found[0]
  for (const step of c.path) {
    if (step === 'left') g.move(-1)
    else if (step === 'right') g.move(1)
    else if (step === 'cw') g.rotate(1)
    else if (step === 'ccw') g.rotate(-1)
    else if (step === '180') g.rotate(2)
    else if (step === 'down') g.stepDown()
    else if (step === 'sonic') while (g.stepDown()) {}
  }
  g.hardDrop()
  const lock = g.events.find((e) => e.type === 'lock')
  assert.equal(lock.spin, 'full')
  assert.equal(g.stats.lines, 2)
  assert.ok(g.events.some((e) => e.type === 'callout' && e.lines[0] === 'T-SPIN DOUBLE'))
})

test('pathTo re-plans from where the piece is now', () => {
  const board = emptyBoard()
  const start = { type: 'L', rot: 0, x: 3, y: BUFFER - 1 }
  const target = searchPlacements(board, start).find((c) => c.rot === 1 && c.x === 7)
  const fallen = { ...start, y: BUFFER + 5 }
  const path = pathTo(board, fallen, target)
  assert.ok(Array.isArray(path) && path.length > 0)
})

test('I on an empty board has 17 distinct placements', () => {
  const found = searchPlacements(emptyBoard(), { type: 'I', rot: 0, x: 3, y: BUFFER - 1 })
  assert.equal(found.length, 17)
})

// --- straight-drop enumerator (used by the headless bench) ------------------------------

test('the drop enumerator finds the 4-line I drop into a deep well', () => {
  const board = emptyBoard()
  for (let x = 0; x < COLS; x++) {
    if (x === 4) continue
    for (let y = ROWS - 4; y < ROWS; y++) board[y][x] = 'X'
  }
  const tetris = enumerateLandings(board, 'I').filter((l) => l.lines === 4)
  assert.equal(tetris.length, 1)
})
