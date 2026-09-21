// Versus decisions: turn a live position into one typed question for Jev.
//
// Same principle as ask.js, which measured it: Jev cannot judge Tetris boards
// from ASCII alone, but picks well when each option comes with its measured
// consequences. Here those consequences include what matters in a battle:
// lines sent, garbage cancelled, holes created, the well kept, the spin
// performed, and the combo / back-to-back chains each option continues.
//
// The objective teaches the versus strategy explicitly — survive first, no
// holes, attack in bulk (quads beat dribbles), hold is the reserve — because
// Jev cannot be assumed to know that singles send zero and waste the stack.
//
// HONEST SCOPE: with spins and hold, a piece can have 60-120 reachable
// placements. We keep the TOP_K most promising by battleScore and let Jev
// choose among those. So the shortlist is ours; the choice within it, and the
// trade-off between attacking and surviving, is Jev's.

import { SPAWN_X, SPAWN_Y, BUFFER, COLS } from '../engine/pieces.js'
import { collides, computeAttack } from '../engine/engine.js'
import { searchPlacements } from '../engine/search.js'
import { features, columnHeights, wellDepth } from './heuristic.js'
import { W, boardFeatures, scoreBoard, scoreMove, liftAfter, bestFollowUp } from './evaluate.js'

const TOP_K = 14

// The strategy below is compacted from published bots and player guides; see
// ai/STRATEGY.md for the sources.
const OBJECTIVE =
  'You are playing a real-time versus Tetris match. Choose where the current ' +
  'piece goes. `candidate_facts` gives the measured consequence of each option. ' +
  'Rules, in priority order:\n' +
  '\n' +
  '1. SURVIVE. Keep the stack low: `max_height` above 10 of 20 rows is risky, ' +
  'above 15 is near death. Defense = attack + lines cleared: lines you send ' +
  'first cancel `incoming_garbage` (`cancels_incoming`); garbage you do not ' +
  'cancel rises under your stack when you place without clearing.\n' +
  '2. NO HOLES. Never pick `holes_created` above 0 unless every option does or ' +
  'survival needs it. A hole costs more than most clears gain.\n' +
  '3. ATTACK IN BULK. Quads and T-spin doubles are the attack; keep ' +
  'back-to-back chains alive (`b2b_chain_after`). A single sends nothing and a ' +
  'double one line — while the board is safe they WASTE the stack ' +
  '(`wastes_stack`). Keep one deep well (`well_depth` 4+) for the next I, and ' +
  'do not spend a T without a T-spin.\n' +
  '4. FINISH. If `opponent_stack_height` is high, any attack may end the game.\n' +
  '\n' +
  '`strategy_rank` is where a Cold-Clear-style evaluation with one piece of ' +
  'lookahead ranks each option (1 = its favourite). It is strong advice, not ' +
  'a rule: overrule it only when the facts clearly favour another option. ' +
  'Reply with the option id.'

const ROT_NAME = ['flat', 'right-facing', 'upside-down', 'left-facing']
const SPIN_TEXT = { none: 'no spin', mini: 'spin (mini)', full: 'spin' }

// Shortlist ranking (and the fallback if a model cannot answer) comes from
// ai/evaluate.js: Cold Clear's evaluation, a versus garbage model, and one
// piece of lookahead. The earlier hand-tuned score (quad-seeking well bonus
// plus a wasted-clear penalty) topped out in 6/6 self-play games under
// 0.45 lines/piece of garbage; see test/selfplay.js.
const LOOKAHEAD = 12 // finalists re-ranked with the next piece's best follow-up

function describe(c) {
  const cols = c.cells.map(([x]) => x)
  const lo = Math.min(...cols)
  const hi = Math.max(...cols)
  const span = lo === hi ? `column ${lo}` : `columns ${lo}-${hi}`
  const spin = c.spin === 'none' ? '' : `, ${c.type}-${SPIN_TEXT[c.spin]}`
  return `${c.useHold ? 'hold, then ' : ''}${c.type} piece, ${ROT_NAME[c.rot]}, ${span}${spin}`
}

function spinLabel(c) {
  if (c.spin === 'none') return 'none'
  const kind = c.type === 'T' && c.spin === 'full' ? 'T-spin' : `${c.type}-spin mini`
  return c.lines ? `${kind} ${['', 'single', 'double', 'triple', 'quad'][c.lines]}` : kind
}

/** Where a freshly spawned piece of `type` starts (mirrors Game.spawn). */
function spawnState(board, type) {
  const p = { type, rot: 0, x: SPAWN_X[type], y: SPAWN_Y }
  if (collides(board, type, 0, p.x, p.y)) return null
  if (!collides(board, type, 0, p.x, p.y + 1)) p.y++
  return p
}

/**
 * All candidates for a position, priced, ranked and trimmed to TOP_K.
 * pos: { board, current: {type, rot, x, y}, hold, queue, canHold, combo, b2b, incoming }
 */
export function candidatesFor(pos) {
  const all = []
  const incoming = pos.incoming ?? 0
  const oppHeight = pos.opponent?.maxHeight ?? 0
  const baseHoles = features(pos.board, 0).holes
  const prev = { combo: pos.combo, b2b: pos.b2b }
  const stack = Math.max(...columnHeights(pos.board))
  const ctx = { incoming, oppHeight, danger: stack + incoming >= W.dangerHeight }

  const add = (list, useHold) => {
    for (const c of list) {
      const allClear = c.board.every((row) => row.every((v) => !v))
      const atk = computeAttack(pos, c.spin, c.lines, allClear)
      const sent = atk.sent + atk.surge // the total that actually leaves, as the engine sends it
      const f = features(c.board, c.lines)
      const heights = columnHeights(c.board)
      const well = wellDepth(c.board)
      const maxHeight = Math.max(...heights) // rows from the floor; 20 fills the field
      // Priority 1 of the objective: a cheap clear is only worth taking when
      // the stack is dangerous, garbage is pending, or it is an all clear.
      const dangerous = maxHeight >= 13 || incoming > 0 || allClear
      const wastesStack = c.lines > 0 && c.lines < 4 && c.spin === 'none' && !dangerous
      all.push({
        ...c,
        useHold,
        id: `${useHold ? 'h' : ''}${c.id}`,
        sent,
        surge: atk.surge,
        cancels: Math.min(sent, incoming),
        well,
        holesCreated: f.holes - baseHoles,
        wastesStack,
        comboAfter: atk.combo,
        b2bAfter: atk.b2b,
        allClear,
        holes: f.holes,
        bumpiness: f.bumpiness,
        maxHeight,
        score:
          scoreBoard(boardFeatures(c.board, liftAfter(c, atk, incoming))) +
          scoreMove({ ...c, allClear }, atk, prev, ctx),
      })
    }
  }

  add(searchPlacements(pos.board, pos.current), false)

  const alt = pos.hold ?? pos.queue[0]
  if (pos.canHold && alt && alt !== pos.current.type) {
    const s = spawnState(pos.board, alt)
    if (s) add(searchPlacements(pos.board, s), true)
  }

  all.sort((a, b) => b.score - a.score)

  // One piece of lookahead for the finalists: what the next piece can make of
  // the board each one leaves. Holding with an empty hold pulls queue[0] in, so
  // the piece after that is queue[1].
  const finalists = all.slice(0, LOOKAHEAD)
  for (const c of finalists) {
    const next = c.useHold && pos.hold == null ? pos.queue[1] : pos.queue[0]
    const follow = next ? bestFollowUp(c.board, next) : null
    c.score += W.lookahead * (follow ?? -5000) // no legal follow-up: a top-out
  }
  finalists.sort((a, b) => b.score - a.score)
  all.splice(0, finalists.length, ...finalists)

  const keep = all.slice(0, TOP_K)
  // Never hide the strongest attacks from Jev just because the board score
  // disliked them: that trade-off is exactly the one Jev should make.
  for (const c of [...all].sort((a, b) => b.sent - a.sent).slice(0, 3)) {
    if (c.sent > 0 && !keep.includes(c)) keep.push(c)
  }
  // Always show Jev one way to use hold: stashing a piece for later is a real
  // strategic option, and the trim must not silently take it away.
  const bestHold = all.find((c) => c.useHold)
  if (bestHold && !keep.includes(bestHold)) keep.push(bestHold)
  for (const c of keep) {
    c.label = describe(c)
    c.rank = all.indexOf(c) + 1 // 1 = the evaluation's favourite
  }
  return { candidates: keep, total: all.length, heuristic: all[0] ?? null }
}

function ascii(board) {
  return board
    .slice(BUFFER)
    .map((row) => row.map((c) => (c ? '#' : '.')).join(''))
    .join('\n')
}

export function buildBattleState(pos, candidates, opponent = null) {
  const facts = {}
  for (const c of candidates) {
    facts[c.id] = {
      strategy_rank: c.rank,
      lines_cleared: c.lines,
      lines_sent: c.sent,
      cancels_incoming: c.cancels,
      spin: spinLabel(c),
      holes: c.holes,
      holes_created: c.holesCreated,
      bumpiness: c.bumpiness,
      max_height: c.maxHeight,
      well_depth: c.well,
      combo_after: Math.max(0, c.comboAfter),
      b2b_chain_after: Math.max(0, c.b2bAfter),
      uses_hold: c.useHold,
      ...(c.wastesStack ? { wastes_stack: true } : {}),
      ...(c.surge > 0 ? { surge_released: c.surge } : {}),
      ...(c.allClear ? { all_clear: true } : {}),
    }
  }
  const state = {
    board: ascii(pos.board),
    board_legend: `'#' filled, '.' empty. ${COLS} columns, 20 rows, top row first.`,
    current_piece: pos.current.type,
    hold: pos.hold ?? 'empty',
    next_pieces: pos.queue.slice(0, 5).join(' '),
    incoming_garbage: pos.incoming ?? 0,
    combo: Math.max(0, pos.combo + 1),
    back_to_back_chain: Math.max(0, pos.b2b),
    candidate_facts: facts,
  }
  if (opponent) state.opponent_stack_height = opponent.maxHeight
  return state
}

export function buildBattleQuestions(candidates) {
  const criteria = {}
  for (const c of candidates) criteria[c.id] = c.label
  return { placement: { type: 'choice', instructions: OBJECTIVE, criteria } }
}

export function readBattleDecision(response, candidates) {
  const p = response?.answers?.placement ?? {}
  const chosen = candidates.find((c) => c.id === p.choice) ?? null
  return {
    chosen,
    confidence: p.confidence ?? null,
    probabilities: p.probabilities ?? null,
    latencyMs: response?.latencyMs ?? null,
  }
}
