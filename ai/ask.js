// Turn a game position into the state + typed questions sent to Jev.
//
// KEY FINDING (measured; reproduce with `node test/bench.js 50`). Three ways to
// describe a candidate landing, and only the third works:
//
//   1. move geometry only  -> flat distribution (~0.16, runner-up 0.15). The
//      argmax is a coin flip and play collapses.
//   2. + resulting board   -> decisive but WRONG. In a controlled 8-candidate
//      test spread across the heuristic's quality range it picked rank 2, 2 and
//      4 of 8 at 0.06-0.11 confidence — and once chose the heuristic's WORST
//      candidate at 0.71. Jev cannot read board quality out of the ASCII grid.
//   3. + measured facts    -> rank 1/8 at 0.66-0.87 confidence, three seeds in a
//      row. Over 50 pieces this is 14-16 lines, 80% agreement, no top-out.
//
// So we hand Jev the measured CONSEQUENCES of each option and let it do the
// trade-off itself. The facts are raw counts, not a score: no weights are
// supplied and nothing tells it which feature matters more. That judgement is
// Jev's. Criteria still describe pure geometry.

const LEGEND =
  "'#' is a filled cell, '.' is empty. 10 columns, 20 rows, top row first. " +
  'Row 1 is the top of the playfield, row 20 is the floor.'

const OBJECTIVE =
  'Choose where to drop the current piece. It falls straight down and lands in ' +
  'the position you pick.\n' +
  '`candidate_results` shows the board AFTER each option lands. ' +
  '`candidate_facts` gives measured consequences for each option: ' +
  '`lines_cleared` (higher is better), `holes` (lower is better — a hole is an ' +
  'empty cell with filled cells above it, and it is hard to clear), ' +
  '`bumpiness` (lower is better — unevenness across neighbouring columns), and ' +
  '`total_height` (lower is better).\n' +
  'Weigh these consequences as you judge best for the long-term health of the ' +
  'board and reply with the option id.'

import { features } from './heuristic.js'

/** ASCII of the VISIBLE field only (buffer rows are hidden from the player). */
export function asciiVisible(board, buffer) {
  return board
    .slice(buffer)
    .map((row) => row.map((c) => (c ? '#' : '.')).join(''))
    .join('\n')
}

export function buildState(game, { landings = [], buffer, queuePreview = 5 } = {}) {
  const state = {
    current_board: asciiVisible(game.board, buffer),
    board_legend: LEGEND,
    current_piece: game.current?.type ?? null,
    next_pieces: game.queue.slice(0, queuePreview).join(' '),
    hold: game.hold ?? 'empty',
    lines_cleared_so_far: game.lines,
  }

  if (landings.length) {
    const results = {}
    const facts = {}
    for (const l of landings) {
      results[l.id] = asciiVisible(l.board, buffer)
      const f = features(l.board, l.lines)
      facts[l.id] = {
        lines_cleared: l.lines,
        holes: f.holes,
        bumpiness: f.bumpiness,
        total_height: f.aggregateHeight,
      }
    }
    state.candidate_results = results
    state.candidate_facts = facts
  }
  return state
}

/**
 * Questions for one decision. `placement` is the real decision; the others are
 * free extras (questions are evaluated in parallel, so they add no latency).
 */
export function buildQuestions(landings) {
  const criteria = {}
  for (const l of landings) criteria[l.id] = l.label

  return {
    placement: {
      type: 'choice',
      instructions: OBJECTIVE,
      criteria,
    },
    board_is_dangerous: {
      type: 'noul',
      instructions:
        'The board is in a dangerous state: the stack is tall enough that the ' +
        'next few pieces risk a top-out.',
    },
  }
}

/** Parse a Jev response into a decision. */
export function readDecision(response, landings) {
  const answers = response?.answers ?? {}
  const placement = answers.placement ?? {}
  const byId = new Map(landings.map((l) => [l.id, l]))

  const chosen = byId.get(placement.choice) ?? null
  return {
    landing: chosen,
    chosenId: placement.choice ?? null,
    valid: chosen !== null,
    confidence: placement.confidence ?? null,
    probabilities: placement.probabilities ?? null,
    dangerous: answers.board_is_dangerous?.noul ?? null,
    latencyMs: response?.latencyMs ?? null,
    usage: response?.usage ?? null,
  }
}
