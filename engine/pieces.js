// Tetromino geometry and SRS rotation data.
//
// Rotation states are 0 / R(1) / 2 / L(3). Each piece lives in a bounding box
// (4x4 for I, 2x2 for O, 3x3 for the rest) and `states[r]` gives the box rows as
// strings, row 0 at the top, 'X' = filled.
//
// KICK TABLES ARE IN SCREEN COORDINATES (y grows downward), because that is what
// the board uses. The published SRS tables use +y up, so every y here is the
// negation of the published value. Verified against harddrop.com/wiki/SRS.

export const COLS = 10
// 20 visible rows under a 20-row hidden buffer, as in online versus: garbage can
// push a stack up into the buffer without topping out straight away.
export const ROWS = 40
export const BUFFER = 20

const DEFS = {
  I: {
    size: 4,
    spawnX: 3,
    states: [
      ['....', 'XXXX', '....', '....'],
      ['..X.', '..X.', '..X.', '..X.'],
      ['....', '....', 'XXXX', '....'],
      ['.X..', '.X..', '.X..', '.X..'],
    ],
  },
  O: {
    size: 2,
    spawnX: 4,
    states: [
      ['XX', 'XX'],
      ['XX', 'XX'],
      ['XX', 'XX'],
      ['XX', 'XX'],
    ],
  },
  T: {
    size: 3,
    spawnX: 3,
    states: [
      ['.X.', 'XXX', '...'],
      ['.X.', '.XX', '.X.'],
      ['...', 'XXX', '.X.'],
      ['.X.', 'XX.', '.X.'],
    ],
  },
  S: {
    size: 3,
    spawnX: 3,
    states: [
      ['.XX', 'XX.', '...'],
      ['.X.', '.XX', '..X'],
      ['...', '.XX', 'XX.'],
      ['X..', 'XX.', '.X.'],
    ],
  },
  Z: {
    size: 3,
    spawnX: 3,
    states: [
      ['XX.', '.XX', '...'],
      ['..X', '.XX', '.X.'],
      ['...', 'XX.', '.XX'],
      ['.X.', 'XX.', 'X..'],
    ],
  },
  J: {
    size: 3,
    spawnX: 3,
    states: [
      ['X..', 'XXX', '...'],
      ['.XX', '.X.', '.X.'],
      ['...', 'XXX', '..X'],
      ['.X.', '.X.', 'XX.'],
    ],
  },
  L: {
    size: 3,
    spawnX: 3,
    states: [
      ['..X', 'XXX', '...'],
      ['.X.', '.X.', '.XX'],
      ['...', 'XXX', 'X..'],
      ['XX.', '.X.', '.X.'],
    ],
  },
}

export const TYPES = Object.keys(DEFS)

// CELLS[type][rot] -> [[dx, dy], ...] offsets from the bounding box origin.
export const CELLS = {}
export const SPAWN_X = {}
// Pieces spawn in the two rows just above the visible field, then drop one row
// straight away if they can (guideline behaviour), so they appear at the top.
export const SPAWN_Y = BUFFER - 2

for (const [type, def] of Object.entries(DEFS)) {
  SPAWN_X[type] = def.spawnX
  CELLS[type] = def.states.map((rows) => {
    const out = []
    rows.forEach((row, dy) => {
      [...row].forEach((ch, dx) => {
        if (ch === 'X') out.push([dx, dy])
      })
    })
    return out
  })
}

/** Absolute board coordinates of a piece's cells. */
export function cellsAt(type, rot, x, y) {
  return CELLS[type][rot].map(([dx, dy]) => [x + dx, y + dy])
}

// --- wall kicks -------------------------------------------------------------
// Keyed "from>to". Screen coords, y down.

const KICKS_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
}

// SRS+ (TETR.IO's default kickset): the I piece uses left/right-symmetric kicks
// instead of standard SRS. Source: Triangle.js, a replay-accurate TETR.IO
// engine (github.com/halp1/triangle), converted from +y up to screen coords.
const KICKS_I = {
  '0>1': [[0, 0], [1, 0], [-2, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [2, 1], [-1, -2]],
}

// 180-degree rotation, TETR.IO's own table (same source, same conversion).
const KICKS_180 = {
  '0>2': [[0, 0], [0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]],
  '1>3': [[0, 0], [1, 0], [1, -2], [1, -1], [0, -2], [0, -1]],
  '2>0': [[0, 0], [0, 1], [-1, 1], [1, 1], [-1, 0], [1, 0]],
  '3>1': [[0, 0], [-1, 0], [-1, -2], [-1, -1], [0, -2], [0, -1]],
}

const KICKS_I_180 = {
  '0>2': [[0, 0], [0, -1]],
  '1>3': [[0, 0], [1, 0]],
  '2>0': [[0, 0], [0, 1]],
  '3>1': [[0, 0], [-1, 0]],
}

/** Ordered kick tests for a rotation transition. O never kicks. */
export function kicksFor(type, from, to) {
  if (type === 'O') return [[0, 0]]
  const key = `${from}>${to}`
  if ((to - from + 4) % 4 === 2) return (type === 'I' ? KICKS_I_180 : KICKS_180)[key]
  return (type === 'I' ? KICKS_I : KICKS_JLSTZ)[key] ?? [[0, 0]]
}

/** The two corners of a T that its nub points between, per rotation. */
export const T_FRONT = {
  0: [[0, 0], [2, 0]], // points up
  1: [[2, 0], [2, 2]], // points right
  2: [[0, 2], [2, 2]], // points down
  3: [[0, 0], [0, 2]], // points left
}
