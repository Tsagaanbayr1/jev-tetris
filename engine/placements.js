// Enumerate the legal hard-drop landings for a piece, and dedupe them by the
// board they produce.
//
// NOTE: this only considers straight-down landings. Tucks, spins and other
// manoeuvres that require sliding under an overhang are NOT enumerated, so Jev
// will never be offered a T-spin. That is a deliberate v1 simplification.

import { COLS, ROWS, BUFFER, cellsAt } from './pieces.js'

/** True if `type` at (rot, x, y) overlaps a wall, floor or filled cell. */
function collides(board, type, rot, x, y) {
  for (const [cx, cy] of cellsAt(type, rot, x, y)) {
    if (cx < 0 || cx >= COLS) return true
    if (cy >= ROWS) return true
    if (cy < 0) continue
    if (board[cy][cx]) return true
  }
  return false
}

/** Where the piece comes to rest when dropped from above, or null if blocked. */
function dropY(board, type, rot, x) {
  let y = -4 // fully above the board at every rotation
  if (collides(board, type, rot, x, y)) return null
  while (!collides(board, type, rot, x, y + 1)) y++
  return y
}

/** Board with the piece's cells written in. Does not clear lines. */
function withPiece(board, type, cells) {
  const next = board.map((row) => row.slice())
  for (const [cx, cy] of cells) {
    if (cy < 0 || cy >= ROWS) continue
    next[cy][cx] = type
  }
  return next
}

function signature(board) {
  let s = ''
  for (const row of board) for (const c of row) s += c ? '1' : '0'
  return s
}

/**
 * All distinct reachable landings for `type`, each as:
 *   { type, rot, x, y, cells, board, lines, label, id }
 * Deduped by resulting board, so equivalent placements appear once.
 */
export function enumerateLandings(board, type) {
  const seen = new Set()
  const out = []

  for (let rot = 0; rot < 4; rot++) {
    for (let x = -3; x < COLS + 3; x++) {
      const y = dropY(board, type, rot, x)
      if (y === null) continue

      const cells = cellsAt(type, rot, x, y)
      // Must come to rest inside the board, not floating in the buffer.
      if (cells.some(([, cy]) => cy < 0 || cy >= ROWS)) continue
      // Must actually be visible.
      if (!cells.some(([, cy]) => cy >= BUFFER)) continue

      const next = withPiece(board, type, cells)
      const sig = signature(next)
      if (seen.has(sig)) continue
      seen.add(sig)

      out.push({
        id: `r${rot}x${x}`,
        type,
        rot,
        x,
        y,
        cells,
        board: next,
        sig,
        lines: linesCleared(next),
        label: describe(type, rot, x, cells),
      })
    }
  }

  return out
}

const ROT_NAME = ['spawn/flat', 'right-facing', 'upside-down', 'left-facing']

function describe(type, rot, x, cells) {
  const cols = cells.map(([cx]) => cx)
  const lo = Math.min(...cols)
  const hi = Math.max(...cols)
  const span = lo === hi ? `column ${lo}` : `columns ${lo}-${hi}`
  return `${type} piece, ${ROT_NAME[rot]}, occupying ${span}`
}

/** How many lines the landing clears. */
export function linesCleared(board) {
  return board.filter((row) => row.every((c) => c)).length
}
