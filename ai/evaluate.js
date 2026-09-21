// Position + move evaluation for the versus shortlist, distilled from published
// Tetris bots (sources and the compact strategy are in ai/STRATEGY.md).
//
//   board terms  Cold Clear's `Standard` weights: cavities, overhangs, covered
//                cells, row transitions, bumpiness (well excluded), height bands,
//                well depth by column, T-spin-double slots.
//   move terms   Cold Clear's clear-type table (singles/doubles punished, quads
//                and T-spins rewarded, a T spent without a spin costs), plus
//                back-to-back and combo garbage.
//   versus       garbage that will rise is added to the board BEFORE it is
//                judged ("defend = attack + lines cleared"), and attack is worth
//                more when the opponent is close to topping out.
//   lookahead    one piece, drop-only (Yiyuan Lee's scheme): each finalist is
//                scored with the best follow-up placement of the next piece.
//
// Units are Cold Clear's. Weights start from Cold Clear's defaults; the ones
// marked TUNED were re-fitted by self-play for this engine and this shallow
// (one-piece) search — test/tune.js, then checked on 10 held-out seeds with
// test/selfplay.js (0.2 garbage/piece: deaths 6/10 -> 1/10, lines sent 392 -> 786).

import { COLS, ROWS, BUFFER, CELLS } from '../engine/pieces.js'
import { collides, clearFullRows, computeAttack } from '../engine/engine.js'

export const W = {
  // board
  height: -39, // tallest column
  topHalf: -150, // per column-row above row 10
  topQuarter: -511, // per column-row above row 15
  cavity: -269, // TUNED (Cold Clear: -173)
  cavitySq: -3,
  overhang: -55, // TUNED (-34)
  overhangSq: -1,
  covered: -17, // filled cells stacked over the topmost hole of a column
  coveredSq: -1,
  rowTransitions: -5.4, // TUNED (-5)
  bumpiness: -24,
  bumpinessSq: -7,
  wellDepth: 57, // per row, capped at WELL_CAP
  wellColumn: [20, 23, 20, 50, 59, 21, 59, 10, -10, 24],
  tslot: [8, 148, 192, 407], // a ready T-spin-double slot, by lines it would clear
  backToBack: 52, // holding a live B2B chain
  // move
  b2bClear: 104,
  clear: [0, -283, -198, -115, 771], // TUNED (x2: [0, -143, -100, -58, 390])
  tspin: [0, 50, 168, 247], // TUNED ([0, 121, 410, 602]: a shallow search rarely sets them up)
  miniTspin: [0, -158, -93],
  perfectClear: 999,
  comboGarbage: 150, // per garbage line the combo adds
  wastedT: -152, // a T piece used without a T-spin clear
  moveTime: -3, // per input, a hair toward simpler routes
  // versus
  cancel: 120, // per incoming line cancelled
  killAttack: 150, // per line sent while the opponent is near the top
  lookahead: 1.43, // TUNED (0.9) weight of the next piece's best follow-up
  // Under pressure (stack + pending garbage at least this tall) the small-clear
  // penalties are dropped: a single that digs out beats a quad you never live to make.
  dangerHeight: 8,
}
const WELL_CAP = 6

/** Column heights from the floor (visible + buffer rows). */
function heightsOf(board) {
  const h = new Array(COLS).fill(0)
  for (let x = 0; x < COLS; x++) {
    for (let y = 0; y < ROWS; y++) {
      if (board[y][x]) {
        h[x] = ROWS - y
        break
      }
    }
  }
  return h
}

/**
 * The best T-spin double/triple slot on the board: the lines a T dropped and
 * spun into it would clear (0 if no slot). Pattern (stem at column x, row y):
 *   roof   one of (x-1, y-2) / (x+1, y-2) filled — the overhang
 *   upper  (x-1..x+1, y-1) empty, the rest of the row filled -> clears
 *   lower  (x, y) empty, (x-1, y) and (x+1, y) filled   -> clears if the rest is full
 * and column x open from the top so the T can arrive.
 */
function tslotLines(board, heights) {
  let best = 0
  for (let x = 1; x < COLS - 1; x++) {
    const top = ROWS - heights[x] // first filled row in column x (or ROWS)
    for (let y = Math.max(BUFFER + 2, top - 3); y < Math.min(ROWS, top + 1); y++) {
      if (board[y][x] || board[y - 1][x]) continue
      if (!board[y][x - 1] || !board[y][x + 1]) continue
      if (board[y - 1][x - 1] || board[y - 1][x + 1]) continue
      const roofL = !!board[y - 2][x - 1]
      const roofR = !!board[y - 2][x + 1]
      if (roofL === roofR) continue
      let open = true
      for (let yy = 0; yy < y - 1 && open; yy++) if (board[yy][x]) open = false
      if (!open) continue
      let lines = 0
      if (board[y].every((c, cx) => cx === x || c)) lines++
      if (board[y - 1].every((c, cx) => Math.abs(cx - x) <= 1 || c)) lines++
      if (lines > best) best = lines
    }
  }
  return best
}

/**
 * Board features. `lift` rows of garbage are assumed to rise first (flat rows
 * with one hole each), which is what the board will face after this placement.
 */
export function boardFeatures(board, lift = 0) {
  const h = heightsOf(board).map((v) => v + lift)
  const max = Math.max(...h)

  let cavity = 0
  let overhang = 0
  let covered = 0
  for (let x = 0; x < COLS; x++) {
    let seen = false
    let aboveTopHole = 0
    let foundHole = false
    for (let y = 0; y < ROWS; y++) {
      if (board[y][x]) {
        seen = true
        if (!foundHole) aboveTopHole++
      } else if (seen) {
        // Reachable from the side (a neighbour column is below it): an overhang
        // a piece can slide under. Otherwise a sealed cavity.
        const cellH = ROWS - y
        const lh = x > 0 ? h[x - 1] - lift : ROWS
        const rh = x < COLS - 1 ? h[x + 1] - lift : ROWS
        if (lh < cellH || rh < cellH) overhang++
        else cavity++
        if (!foundHole) {
          foundHole = true
          covered += aboveTopHole
        }
      }
    }
  }
  // Rising garbage adds one hole per row, each under everything above it.
  cavity += lift

  let rowTransitions = 0
  for (let y = BUFFER; y < ROWS; y++) {
    const row = board[y]
    if (row.every((c) => !c)) continue
    let prev = true // walls count as filled
    for (let x = 0; x < COLS; x++) {
      const f = !!row[x]
      if (f !== prev) rowTransitions++
      prev = f
    }
    if (!prev) rowTransitions++
  }

  // The well is the lowest column; bumpiness is measured around it.
  let wellCol = 0
  for (let x = 1; x < COLS; x++) if (h[x] < h[wellCol]) wellCol = x
  const lw = wellCol > 0 ? h[wellCol - 1] : ROWS
  const rw = wellCol < COLS - 1 ? h[wellCol + 1] : ROWS
  const wellDepth = Math.max(0, Math.min(lw, rw) - h[wellCol])

  let bumpiness = 0
  let bumpinessSq = 0
  let prev = -1
  for (let x = 0; x < COLS; x++) {
    if (x === wellCol) continue
    if (prev >= 0) {
      const d = Math.abs(h[x] - h[prev])
      bumpiness += d
      bumpinessSq += d * d
    }
    prev = x
  }

  let topHalf = 0
  let topQuarter = 0
  for (const v of h) {
    topHalf += Math.max(0, v - 10)
    topQuarter += Math.max(0, v - 15)
  }

  return {
    heights: h, maxHeight: max, cavity, overhang, covered, rowTransitions,
    wellCol, wellDepth, bumpiness, bumpinessSq, topHalf, topQuarter,
    tslot: lift ? 0 : tslotLines(board, h),
  }
}

export function scoreBoard(f) {
  const well = Math.min(WELL_CAP, f.wellDepth)
  return (
    W.height * f.maxHeight +
    W.topHalf * f.topHalf +
    W.topQuarter * f.topQuarter +
    W.cavity * f.cavity + W.cavitySq * f.cavity * f.cavity +
    W.overhang * f.overhang + W.overhangSq * f.overhang * f.overhang +
    W.covered * f.covered + W.coveredSq * f.covered * f.covered +
    W.rowTransitions * f.rowTransitions +
    W.bumpiness * f.bumpiness + W.bumpinessSq * f.bumpinessSq +
    W.wellDepth * well + (well > 0 ? W.wellColumn[f.wellCol] : 0) +
    W.tslot[f.tslot]
  )
}

/**
 * Value of the move itself: clear type, chains, T usage, versus context.
 * c: { type, spin, lines, path, allClear }, atk: computeAttack result,
 * prev: { combo, b2b }, ctx: { incoming, oppHeight }
 */
export function scoreMove(c, atk, prev, ctx) {
  let v = 0
  const full = c.spin === 'full'
  if (c.lines) {
    if (full) v += W.tspin[c.lines] ?? 0
    else if (c.spin === 'mini') v += W.miniTspin[c.lines] ?? 0
    else v += ctx.danger && c.lines < 4 ? 0 : W.clear[c.lines]
    if ((full || c.lines === 4) && prev.b2b >= 0) v += W.b2bClear
    // The garbage the combo adds on top of the same clear with no combo running.
    const plain = computeAttack({ combo: -1, b2b: prev.b2b }, c.spin, c.lines, c.allClear)
    v += W.comboGarbage * Math.max(0, atk.sent - plain.sent)
  }
  if (c.allClear) v += W.perfectClear
  if (c.type === 'T' && !(full && c.lines)) v += W.wastedT
  if (atk.b2b >= 0) v += W.backToBack
  v += W.moveTime * (c.path?.length ?? 0)
  const sent = atk.sent + atk.surge
  v += W.cancel * Math.min(sent, ctx.incoming)
  if (ctx.oppHeight >= 14) v += W.killAttack * sent
  return v
}

/** Garbage still rising after this move: what is not cancelled, only if nothing cleared. */
export function liftAfter(c, atk, incoming) {
  if (c.lines) return 0
  return Math.max(0, Math.min(8, incoming - (atk.sent + atk.surge)))
}

/** Straight hard-drop placements (every rotation x column) — cheap, for lookahead. */
export function dropPlacements(board, type) {
  const out = []
  for (let rot = 0; rot < 4; rot++) {
    if (type === 'O' && rot > 0) break
    const cells = CELLS[type][rot]
    const minDx = Math.min(...cells.map(([dx]) => dx))
    const maxDx = Math.max(...cells.map(([dx]) => dx))
    for (let x = -minDx; x < COLS - maxDx; x++) {
      let y = 0
      if (collides(board, type, rot, x, y)) continue
      while (!collides(board, type, rot, x, y + 1)) y++
      const placed = board.map((row) => row.slice())
      let buried = true
      for (const [dx, dy] of cells) {
        placed[y + dy][x + dx] = type
        if (y + dy >= BUFFER) buried = false
      }
      if (buried) continue // locking in the hidden rows is a top-out
      const { board: after, rows } = clearFullRows(placed)
      out.push({ board: after, lines: rows.length, type })
    }
  }
  return out
}

/** Best board the next piece can make from `board` (drop-only), or null. */
export function bestFollowUp(board, type) {
  let best = -Infinity
  for (const p of dropPlacements(board, type)) {
    const v = scoreBoard(boardFeatures(p.board)) + (p.lines ? W.clear[p.lines] : 0) +
      (p.type === 'T' ? W.wastedT : 0)
    if (v > best) best = v
  }
  return best === -Infinity ? null : best
}
