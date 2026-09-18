// Display-only baseline. Runs alongside Jev so you can see where it agrees or
// disagrees. It NEVER decides the move that gets played.
//
// Features and weights are the standard 4-feature set (aggregate height, holes,
// bumpiness, lines cleared), which is a strong and cheap Tetris controller.

import { COLS, ROWS } from '../engine/pieces.js'

const W = {
  aggregateHeight: -0.510066,
  linesCleared: 0.760666,
  holes: -0.35663,
  bumpiness: -0.184483,
}

/** Height of each column measured from the floor to its highest filled cell. */
export function columnHeights(board) {
  const heights = new Array(COLS).fill(0)
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      if (board[y][x]) {
        heights[x] = ROWS - y
        break
      }
    }
  }
  return heights
}

/**
 * Depth of the deepest single-column well: an open column whose neighbours on
 * both sides are taller (the field edge counts as a wall). A well 4+ deep turns
 * the next I piece into a quad, so keeping one is how you load a bulk attack.
 */
export function wellDepth(board) {
  const heights = columnHeights(board)
  let best = 0
  for (let x = 0; x < COLS; x++) {
    const left = x === 0 ? ROWS : heights[x - 1]
    const right = x === COLS - 1 ? ROWS : heights[x + 1]
    const d = Math.min(left, right) - heights[x]
    if (d > best) best = d
  }
  return best
}

/** Empty cells with at least one filled cell somewhere above them. */
export function countHoles(board) {
  let holes = 0
  for (let x = 0; x < COLS; x++) {
    let seenBlock = false
    for (let y = 0; y < ROWS; y++) {
      if (board[y][x]) seenBlock = true
      else if (seenBlock) holes++
    }
  }
  return holes
}

export function features(board, lines) {
  const heights = columnHeights(board)
  const aggregateHeight = heights.reduce((a, b) => a + b, 0)
  let bumpiness = 0
  for (let x = 0; x < COLS - 1; x++) bumpiness += Math.abs(heights[x] - heights[x + 1])
  return { aggregateHeight, holes: countHoles(board), bumpiness, linesCleared: lines }
}

/** Higher is better. */
export function evaluate(board, lines) {
  const f = features(board, lines)
  return (
    W.aggregateHeight * f.aggregateHeight +
    W.linesCleared * f.linesCleared +
    W.holes * f.holes +
    W.bumpiness * f.bumpiness
  )
}

/** The landing the baseline would pick, or null. */
export function bestLanding(landings) {
  let best = null
  let bestScore = -Infinity
  for (const l of landings) {
    const s = evaluate(l.board, l.lines)
    if (s > bestScore) {
      bestScore = s
      best = l
    }
  }
  return best
}
