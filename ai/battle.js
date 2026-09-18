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

const TOP_K = 14

const OBJECTIVE =
  'You are playing a real-time versus Tetris match against a human. Choose where ' +
  'the current piece goes. `candidate_facts` gives the measured consequence of ' +
  'each option. Choose with these priorities, in order:\n' +
  '\n' +
  '1. SURVIVE. Garbage sent to you (`incoming_garbage`) rises under your stack ' +
  'the moment you place a piece that clears nothing, unless your own attack ' +
  'cancels it first (`cancels_incoming`). When `incoming_garbage` is large or ' +
  '`max_height` would pass 15 of the 20 rows, take the clear that cancels the ' +
  'most or digs the stack down, even a small one. Dying with a perfect stack ' +
  'still loses the game.\n' +
  '2. DO NOT CREATE HOLES (`holes_created` above 0). A buried hole usually ' +
  'costs more than any clear gains; only accept one in service of priority 1.\n' +
  '3. ATTACK IN BULK, NOT DRIBBLES. A quad (4 lines at once) sends 4, a T-spin ' +
  'double sends 4, and every quad or spin in a row adds +1 to the next one ' +
  '(`b2b_chain_after`) and charges a surge released in bulk when the chain ' +
  'breaks; consecutive clears grow the attack too (`combo_after`). A single ' +
  'sends 0 and a double sends 1: taking those WASTES the rows you stacked — ' +
  'options that do this while the stack is safe are flagged `wastes_stack`. ' +
  'While no quad or spin is available, keep stacking: place pieces flat and ' +
  'clean (low `bumpiness`) and keep ONE column open as a deep well ' +
  '(`well_depth` 4+): the next I piece turns that well into a quad. If ' +
  '`opponent_stack_height` is already high, sending anything may finish them ' +
  'off — take the clear you have.\n' +
  '4. HOLD IS YOUR RESERVE. `uses_hold` stashes the current piece for later. ' +
  'Keep an I piece in hold, loaded for the next quad or to dig out of garbage; ' +
  'swap pieces only when it pays.\n' +
  '\n' +
  'Weigh attack, defense and board health as you judge best and reply with the ' +
  'option id.'

const ROT_NAME = ['flat', 'right-facing', 'upside-down', 'left-facing']
const SPIN_TEXT = { none: 'no spin', mini: 'spin (mini)', full: 'spin' }

// Battle scoring for the shortlist (and the fallback if Jev cannot answer).
// Different from the display baseline in heuristic.js on purpose: versus wants
// a board that can SEND — one deep well, and the patience to fill it with a
// quad — not the earliest available clear. A single removes a whole row, so
// under plain health scoring it always beats stacking; the wasted-clear
// penalty prices that opportunity cost back in, and only while the stack is
// actually safe (tall stack or pending garbage re-legalizes small clears).
const BW = {
  aggregateHeight: -0.51,
  holes: -1.0, // buried holes are closer to death in versus than in marathon
  bumpiness: -0.18,
  well: 0.5, // per row of the deepest well, up to 5: the quad loader
  wastedClear: -8, // a cheap clear while safe burns the well for ~nothing
}

function battleScore(c, attackW) {
  const f = features(c.board, 0)
  return (
    BW.aggregateHeight * f.aggregateHeight +
    BW.holes * f.holes +
    BW.bumpiness * f.bumpiness +
    BW.well * Math.min(5, c.well) +
    attackW * c.sent +
    (c.wastesStack ? BW.wastedClear : 0)
  )
}

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
  // Attack pricing for the shortlist. Attack is worth more when it doubles as
  // defense (cancels garbage that is about to rise) or as a kill (the opponent
  // is near topping out). The trade-off within the shortlist stays Jev's.
  const attackW =
    1.2 + (incoming > 0 ? 0.6 : 0) + (oppHeight >= 16 ? 1.0 : 0)

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
        score: battleScore({ ...c, sent, well, wastesStack }, attackW),
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
  for (const c of keep) c.label = describe(c)
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
