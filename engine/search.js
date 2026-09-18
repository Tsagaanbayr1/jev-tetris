// Every placement a piece can actually reach, and the inputs that get it there.
//
// Unlike placements.js (straight-down drops only), this is a breadth-first
// search over the piece's real state space: move left/right, rotate CW / CCW /
// 180 (with kicks), step down, and sonic-drop to the floor. So it finds tucks
// under overhangs and every kind of spin, T-spins included.
//
// Each result carries the shortest input path from spawn, which is what lets the
// bot's piece visibly travel to where it chose rather than teleporting.

import { ROWS, BUFFER, cellsAt } from './pieces.js'
import { collides, tryRotate, detectSpin, clearFullRows } from './engine.js'

const MOVES = ['left', 'right', 'cw', 'ccw', '180', 'down', 'sonic']

function apply(board, s, move) {
  switch (move) {
    case 'left':
    case 'right': {
      const x = s.x + (move === 'left' ? -1 : 1)
      if (collides(board, s.type, s.rot, x, s.y)) return null
      return { ...s, x, rotated: null }
    }
    case 'down': {
      if (collides(board, s.type, s.rot, s.x, s.y + 1)) return null
      return { ...s, y: s.y + 1, rotated: null }
    }
    case 'sonic': {
      let y = s.y
      while (!collides(board, s.type, s.rot, s.x, y + 1)) y++
      if (y === s.y) return null
      return { ...s, y, rotated: null }
    }
    default: {
      const dir = move === 'cw' ? 1 : move === 'ccw' ? -1 : 2
      const r = tryRotate(board, s, dir)
      if (!r) return null
      return { ...r.piece, rotated: { kick: r.kick, dir } }
    }
  }
}

const keyOf = (s) => `${s.rot},${s.x},${s.y},${s.rotated ? s.rotated.kick : '-'}`

/**
 * All distinct lock positions reachable from `start` on `board`.
 * Returns [{ type, rot, x, y, cells, spin, path, board, lines, sig, id }].
 * Deduped by (resulting board, spin), keeping the shortest path.
 */
export function searchPlacements(board, start) {
  const s0 = { type: start.type, rot: start.rot, x: start.x, y: start.y, rotated: null }
  if (collides(board, s0.type, s0.rot, s0.x, s0.y)) return []

  const seen = new Map([[keyOf(s0), null]])
  const queue = [{ s: s0, path: [] }]
  const results = new Map()

  for (let qi = 0; qi < queue.length; qi++) {
    const { s, path } = queue[qi]

    // A resting state is a candidate lock position.
    if (collides(board, s.type, s.rot, s.x, s.y + 1)) {
      record(board, s, path, results)
    }

    for (const m of MOVES) {
      const n = apply(board, s, m)
      if (!n) continue
      const k = keyOf(n)
      if (seen.has(k)) continue
      seen.set(k, null)
      queue.push({ s: n, path: [...path, m] })
    }
  }

  return [...results.values()]
}

function record(board, s, path, results) {
  const cells = cellsAt(s.type, s.rot, s.x, s.y)
  // Locking entirely inside the hidden rows is a top-out, never a real option.
  if (cells.every(([, cy]) => cy < BUFFER)) return

  const spin = s.rotated ? detectSpin(board, s, s.rotated) : 'none'
  const placed = board.map((row) => row.slice())
  for (const [cx, cy] of cells) if (cy >= 0 && cy < ROWS) placed[cy][cx] = s.type
  const { board: after, rows } = clearFullRows(placed)

  let sig = ''
  for (const row of placed) for (const c of row) sig += c ? '1' : '0'
  const key = `${sig}|${spin}`
  const prev = results.get(key)
  if (prev && prev.path.length <= path.length) return

  results.set(key, {
    type: s.type,
    rot: s.rot,
    x: s.x,
    y: s.y,
    cells,
    spin,
    path,
    board: after, // lines already cleared: what the player is left with
    lines: rows.length,
    sig: key,
    id: `r${s.rot}x${s.x}y${s.y}${spin === 'none' ? '' : spin === 'mini' ? 'm' : 's'}`,
  })
}

/**
 * Shortest input path from the piece's CURRENT state to a specific lock
 * position (and spin), or null if it can no longer be reached.
 */
export function pathTo(board, from, target) {
  const all = searchPlacements(board, from)
  const exact = all.find(
    (r) => r.rot === target.rot && r.x === target.x && r.y === target.y && r.spin === target.spin
  )
  if (exact) return exact.path
  // The same cells via a different rotation state (S/Z/I symmetries) is fine
  // too, as long as the spin matches.
  const want = new Set(target.cells.map(([x, y]) => `${x},${y}`))
  const same = all.find(
    (r) => r.spin === target.spin && r.cells.every(([x, y]) => want.has(`${x},${y}`))
  )
  return same ? same.path : null
}
