// Real-time Tetris for versus play. Pure logic: no rendering and no timers of
// its own. The caller advances it with update(dt), which keeps it testable and
// lets the browser drive both players from one animation frame.
//
// Board is ROWS x COLS, row 0 at the top; the first BUFFER rows are hidden.
// Cell values are piece letters, 'G' for garbage, or null.
//
// What happens between frames is reported through `events` (lock, clear,
// callout, attack, garbageIn, topout...), which the UI drains for effects and
// the match uses to route attacks to the opponent.

import {
  COLS, ROWS, BUFFER, TYPES,
  SPAWN_X, SPAWN_Y, cellsAt, kicksFor, T_FRONT,
} from './pieces.js'
import {
  TIMING, BASE_ATTACK, B2B_BONUS, ALL_CLEAR, ALL_CLEAR_B2B,
  SURGE_AT, comboAttack, GARBAGE,
} from './rules.js'
import { mulberry32 } from './rng.js'

const FRAME = 1000 / 60

// --- pure helpers (shared with the move search) ------------------------------

/** True if `type` at (rot, x, y) overlaps a wall, the floor, or a filled cell. */
export function collides(board, type, rot, x, y) {
  for (const [cx, cy] of cellsAt(type, rot, x, y)) {
    if (cx < 0 || cx >= COLS || cy >= ROWS) return true
    if (cy < 0) continue
    if (board[cy][cx]) return true
  }
  return false
}

/**
 * Rotate with kicks. dir: 1 = CW, -1 = CCW, 2 = 180.
 * Returns { piece, kick } where kick is the index of the test that passed, or
 * null if every test is blocked.
 */
export function tryRotate(board, p, dir) {
  if (p.type === 'O') return null // rotating an O changes nothing
  const to = (p.rot + dir + 4) % 4
  const kicks = kicksFor(p.type, p.rot, to)
  for (let i = 0; i < kicks.length; i++) {
    const [dx, dy] = kicks[i]
    if (!collides(board, p.type, to, p.x + dx, p.y + dy)) {
      return { piece: { type: p.type, rot: to, x: p.x + dx, y: p.y + dy }, kick: i }
    }
  }
  return null
}

/** Cannot move one cell in any direction: the all-spin test. */
function immobile(board, p) {
  return (
    collides(board, p.type, p.rot, p.x - 1, p.y) &&
    collides(board, p.type, p.rot, p.x + 1, p.y) &&
    collides(board, p.type, p.rot, p.x, p.y - 1) &&
    collides(board, p.type, p.rot, p.x, p.y + 1)
  )
}

/**
 * Spin type for a piece whose last successful action was a rotation.
 * `rotated` = { kick, dir }. Returns 'none' | 'mini' | 'full'.
 *
 * TETR.IO Season 2 "All-Mini+":
 *   T pieces use the 3-corner rule: 3+ corners filled is a spin, full when both
 *   corners the T points at are filled or when the rotation used the (+-1, 2
 *   down) kick (the TST / fin exception), otherwise mini. A T that fails the
 *   corner test but cannot move still counts as a mini.
 *   Every other piece is a mini spin when it cannot move in any direction.
 */
export function detectSpin(board, p, rotated) {
  if (!rotated) return 'none'
  const stuck = immobile(board, p)
  if (p.type !== 'T') return stuck ? 'mini' : 'none'
  const corner = tCorners(board, p, rotated)
  return corner !== 'none' ? corner : stuck ? 'mini' : 'none'
}

function tCorners(board, p, rotated) {
  const filled = (dx, dy) => {
    const cx = p.x + dx
    const cy = p.y + dy
    if (cx < 0 || cx >= COLS || cy >= ROWS) return true
    if (cy < 0) return false
    return !!board[cy][cx]
  }
  const corners = [[0, 0], [2, 0], [0, 2], [2, 2]].filter(([dx, dy]) => filled(dx, dy)).length
  if (corners < 3) return 'none'
  const front = T_FRONT[p.rot].filter(([dx, dy]) => filled(dx, dy)).length
  if (front === 2) return 'full'
  const from = (p.rot - rotated.dir + 8) % 4
  const [dx, dy] = kicksFor('T', from, p.rot)[rotated.kick] ?? [0, 0]
  if (Math.abs(dx) === 1 && dy === 2) return 'full'
  return 'mini'
}

/** Remove full rows. Returns { board, rows } with the indices that cleared. */
export function clearFullRows(board) {
  const rows = []
  const kept = []
  board.forEach((row, y) => (row.every((c) => c) ? rows.push(y) : kept.push(row)))
  while (kept.length < ROWS) kept.unshift(new Array(COLS).fill(null))
  return { board: kept, rows }
}

/**
 * Lines a clear sends, and the combo / B2B counters after it. Pure, so the bot
 * can price every candidate the same way the game will.
 *   combo: -1 = no chain running; b2b: -1 = no back-to-back running
 *   mult: the garbage multiplier (rises late in a match)
 * Returns { sent, surge, combo, b2b }; `surge` is released B2B charge.
 */
export function computeAttack({ combo, b2b }, spin, lines, allClear = false, mult = 1) {
  if (lines === 0) return { sent: 0, surge: 0, combo: -1, b2b }
  const nextCombo = combo + 1
  const difficult = lines === 4 || spin !== 'none'

  let nextB2b
  let surge = 0
  if (difficult) {
    nextB2b = b2b + 1
  } else {
    // Breaking a long back-to-back chain releases it all at once.
    if (b2b >= SURGE_AT && !allClear) surge = Math.floor(b2b * mult)
    nextB2b = -1
  }
  // The bonus comes from the chain as it stood; an all clear then adds to it.
  const bonus = difficult && nextB2b > 0 ? B2B_BONUS : 0
  if (allClear) nextB2b = Math.max(b2b, -1) + ALL_CLEAR_B2B
  const base = BASE_ATTACK[spin][lines] + bonus
  let sent = Math.floor(comboAttack(base, nextCombo) * mult)
  if (allClear) sent += Math.floor(ALL_CLEAR * mult)
  return { sent, surge, combo: nextCombo, b2b: nextB2b }
}

export function emptyBoard() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(null))
}

const SPIN_NAME = { T: 'T-SPIN', S: 'S-SPIN', Z: 'Z-SPIN', L: 'L-SPIN', J: 'J-SPIN', I: 'I-SPIN', O: 'O-SPIN' }
const CLEAR_NAME = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD']

// --- the game -------------------------------------------------------------------

export class Game {
  /**
   * seed: piece sequence (share it between players for a fair match)
   * garbageSeed: hole columns for garbage this player receives
   */
  constructor({ seed = 1, garbageSeed = seed ^ 0x5bd1e995 } = {}) {
    this.rng = mulberry32(seed)
    this.garbageRng = mulberry32(garbageSeed)
    this.board = emptyBoard()
    this.bag = []
    this.queue = []
    this.hold = null
    this.canHold = true

    this.combo = -1 // -1 = no combo running; 0 = the first clear of a chain
    this.b2b = -1 // -1 = none; counts consecutive difficult clears after the first
    this.garbageQueue = [] // [{ lines, readyAt, hole }]
    this.garbageHole = null // column of the last batch, for messiness

    this.time = 0
    this.gravity = TIMING.gravityStart
    this.fallAccum = 0
    this.lockTimer = 0
    this.lockResets = 0
    this.lowestY = -Infinity
    this.softDropG = 0 // extra fall speed while soft drop is held (set by input)

    this.gameOver = false
    this.events = []
    this.stats = {
      pieces: 0, lines: 0, attack: 0, received: 0, cancelled: 0,
      spins: 0, quads: 0, allClears: 0, maxCombo: 0, maxB2b: 0,
    }

    this.current = null
    this.lastRotation = null // { kick, dir } if the last successful action rotated
    this.spawn()
  }

  // --- queue ----------------------------------------------------------------

  _fillQueue() {
    while (this.queue.length < 12) {
      if (this.bag.length === 0) {
        this.bag = [...TYPES]
        for (let i = this.bag.length - 1; i > 0; i--) {
          const j = Math.floor(this.rng() * (i + 1))
          ;[this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]
        }
      }
      this.queue.push(this.bag.pop())
    }
  }

  spawn(type = null) {
    this._fillQueue()
    if (!type) type = this.queue.shift()
    const p = { type, rot: 0, x: SPAWN_X[type], y: SPAWN_Y }
    this.current = p
    this.lastRotation = null
    this.fallAccum = 0
    this.lockTimer = 0
    this.lockResets = 0
    this.lowestY = p.y
    if (collides(this.board, p.type, p.rot, p.x, p.y)) {
      // Clutch clear: right after a line clear, the new piece is pushed up
      // until it fits instead of ending the game.
      if (this.lastCleared) {
        while (p.y > 0 && collides(this.board, p.type, p.rot, p.x, p.y)) p.y--
      }
      if (collides(this.board, p.type, p.rot, p.x, p.y)) {
        this._topOut('block out')
        return false
      }
    }
    // Guideline: drop one row immediately if nothing is in the way.
    if (!collides(this.board, p.type, p.rot, p.x, p.y + 1)) {
      p.y++
      this.lowestY = p.y
    }
    return true
  }

  // --- geometry -------------------------------------------------------------

  collides(type, rot, x, y) {
    return collides(this.board, type, rot, x, y)
  }

  get grounded() {
    const p = this.current
    return !!p && collides(this.board, p.type, p.rot, p.x, p.y + 1)
  }

  ghostY() {
    const p = this.current
    let y = p.y
    while (!collides(this.board, p.type, p.rot, p.x, y + 1)) y++
    return y
  }

  /** How far the piece is toward the next row, 0..1, for smooth drawing. */
  fallFraction() {
    if (!this.current || this.grounded) return 0
    return Math.min(0.999, this.fallAccum)
  }

  /** How far lock delay has run, 0..1, for the lock flash. */
  lockProgress() {
    if (!this.current || !this.grounded) return 0
    return Math.min(1, this.lockTimer / TIMING.lockDelay)
  }

  // --- actions --------------------------------------------------------------

  /** A successful move/rotate on the ground restarts lock delay, 15 times max. */
  _moved() {
    if (this.grounded || this.lockTimer > 0) {
      if (this.lockResets < TIMING.lockResets) {
        this.lockTimer = 0
        this.lockResets++
      }
    }
  }

  move(dx) {
    const p = this.current
    if (!p || this.gameOver) return false
    if (collides(this.board, p.type, p.rot, p.x + dx, p.y)) return false
    p.x += dx
    this.lastRotation = null
    this._moved()
    return true
  }

  /** dir: 1 = clockwise, -1 = counter-clockwise, 2 = 180. */
  rotate(dir) {
    const p = this.current
    if (!p || this.gameOver) return false
    const r = tryRotate(this.board, p, dir)
    if (!r) return false
    Object.assign(p, r.piece)
    this.lastRotation = { kick: r.kick, dir }
    this._moved()
    this._trackLowest()
    return true
  }

  /** One row down (gravity or soft drop). Returns false when resting. */
  stepDown() {
    const p = this.current
    if (!p || this.gameOver) return false
    if (collides(this.board, p.type, p.rot, p.x, p.y + 1)) return false
    p.y++
    this.lastRotation = null
    this._trackLowest()
    return true
  }

  /** Reaching a new lowest row gives the lock-reset allowance back. */
  _trackLowest() {
    const p = this.current
    if (p.y > this.lowestY) {
      this.lowestY = p.y
      this.lockResets = 0
      this.lockTimer = 0
    }
  }

  hardDrop() {
    const p = this.current
    if (!p || this.gameOver) return
    const fromY = p.y
    const y = this.ghostY()
    if (y > p.y) {
      p.y = y
      this.lastRotation = null // falling after a rotation cancels the spin
    }
    this.events.push({
      type: 'hardDrop', piece: p.type, fromY,
      cells: cellsAt(p.type, p.rot, p.x, p.y),
    })
    this.lock()
  }

  holdPiece() {
    const p = this.current
    if (!p || !this.canHold || this.gameOver) return false
    const stash = this.hold
    this.hold = p.type
    this.canHold = false
    this.current = null
    this.spawn(stash) // null -> next from the queue
    this.events.push({ type: 'hold' })
    return true
  }

  // --- time -----------------------------------------------------------------

  /** Advance by dt ms: gravity, soft drop, lock delay, gravity ramp. */
  update(dt) {
    if (this.gameOver || !this.current) return
    this.time += dt

    // Gravity ramps once margin time is over, so games cannot stall forever.
    if (this.time > TIMING.gravityMargin) {
      this.gravity =
        TIMING.gravityStart + ((this.time - TIMING.gravityMargin) / 1000) * TIMING.gravityIncrease
    }

    const g = this.gravity + this.softDropG
    this.fallAccum += g * (dt / FRAME)
    while (this.fallAccum >= 1) {
      this.fallAccum -= 1
      if (!this.stepDown()) {
        this.fallAccum = 0
        break
      }
    }

    if (this.grounded) {
      this.fallAccum = 0
      this.lockTimer += dt
      // Out of resets: lock the moment it touches down again.
      if (this.lockTimer >= TIMING.lockDelay || this.lockResets >= TIMING.lockResets) {
        this.lock()
      }
    } else {
      this.lockTimer = 0
    }
  }

  // --- locking --------------------------------------------------------------

  lock() {
    const p = this.current
    if (!p) return
    const spin = detectSpin(this.board, p, this.lastRotation)
    const cells = cellsAt(p.type, p.rot, p.x, p.y)

    for (const [cx, cy] of cells) {
      if (cy >= 0 && cy < ROWS) this.board[cy][cx] = p.type
    }
    this.current = null
    this.canHold = true
    this.stats.pieces++
    this.events.push({ type: 'lock', piece: p.type, cells, spin })

    // Lock out: the whole piece came to rest above the visible field.
    if (cells.every(([, cy]) => cy < BUFFER)) {
      this._topOut('lock out')
      return
    }

    const { board, rows } = clearFullRows(this.board)
    this.board = board
    const lines = rows.length
    this.lastCleared = lines > 0

    if (lines > 0) {
      this.events.push({ type: 'clear', rows: rows.slice(), lines })
      this.stats.lines += lines
      this._attack(p.type, spin, lines)
    } else {
      this.combo = -1
      if (spin !== 'none') this._callout(p.type, spin, 0, 0)
      this._takeGarbage()
      if (this.gameOver) return
    }

    this.spawn()
  }

  _attack(type, spin, lines) {
    const allClear = this.board.every((row) => row.every((c) => !c))
    const r = computeAttack(this, spin, lines, allClear, this.garbageMultiplier)
    this.combo = r.combo
    this.b2b = r.b2b
    const sent = r.sent + r.surge
    if (r.surge) this.events.push({ type: 'callout', lines: [`SURGE ×${r.surge}`], tone: 'quad' })
    this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo)
    this.stats.maxB2b = Math.max(this.stats.maxB2b, this.b2b)
    if (allClear) this.stats.allClears++
    if (spin !== 'none') this.stats.spins++
    if (lines === 4) this.stats.quads++

    this._callout(type, spin, lines, sent, allClear)

    // Attack cancels our own incoming garbage first; only the rest is sent.
    let left = sent
    while (left > 0 && this.garbageQueue.length) {
      const g = this.garbageQueue[0]
      const n = Math.min(left, g.lines)
      g.lines -= n
      left -= n
      this.stats.cancelled += n
      if (g.lines === 0) this.garbageQueue.shift()
    }
    if (left > 0) {
      this.stats.attack += left
      this.events.push({ type: 'attack', lines: left })
    }
  }

  _callout(type, spin, lines, sent, allClear = false) {
    const out = []
    let tone = 'clear'
    if (spin !== 'none') {
      out.push(`${spin === 'mini' && type === 'T' ? 'T-SPIN MINI' : SPIN_NAME[type]}${lines ? ' ' + CLEAR_NAME[lines] : ''}`)
      tone = 'spin'
    } else if (lines === 4) {
      out.push('QUAD')
      tone = 'quad'
    } else if (lines >= 1 && sent === 0 && this.combo < 1) {
      return // a plain single is not worth a callout
    } else if (lines >= 1) {
      out.push(CLEAR_NAME[lines])
    }
    if (this.b2b > 0 && lines > 0) out.push(`B2B ×${this.b2b}`)
    if (this.combo >= 1) {
      out.push(`${this.combo} COMBO`)
      if (tone === 'clear') tone = 'combo'
    }
    if (allClear) {
      out.unshift('ALL CLEAR')
      tone = 'clear'
    }
    if (out.length) this.events.push({ type: 'callout', lines: out, tone })
  }

  // --- garbage --------------------------------------------------------------

  /** Queue incoming garbage; it may enter after TIMING.garbageDelay. */
  receive(lines) {
    if (this.gameOver || lines <= 0) return
    this.garbageQueue.push({ lines, readyAt: this.time + TIMING.garbageDelay })
    this.stats.received += lines
  }

  /** On a lock that cleared nothing, ready garbage rises (8 rows at most). */
  _takeGarbage() {
    let budget = GARBAGE.capPerPlacement
    let risen = 0
    while (budget > 0 && this.garbageQueue.length && this.garbageQueue[0].readyAt <= this.time) {
      const g = this.garbageQueue[0]
      const n = Math.min(budget, g.lines)
      // A new attack usually gets a fresh hole column; rows inside one attack
      // usually share it.
      if (g.hole == null) {
        g.hole =
          this.garbageHole == null || this.garbageRng() < GARBAGE.messinessChange
            ? Math.floor(this.garbageRng() * COLS)
            : this.garbageHole
      }
      for (let i = 0; i < n; i++) {
        if (GARBAGE.messinessInner > 0 && this.garbageRng() < GARBAGE.messinessInner) {
          g.hole = Math.floor(this.garbageRng() * COLS)
        }
        this.garbageHole = g.hole
        // Anything in the top row is pushed out of the board: top out.
        if (this.board[0].some((c) => c)) {
          this._topOut('garbage')
          return
        }
        this.board.shift()
        const row = new Array(COLS).fill('G')
        row[g.hole] = null
        this.board.push(row)
      }
      g.lines -= n
      budget -= n
      risen += n
      if (g.lines === 0) this.garbageQueue.shift()
    }
    if (risen) this.events.push({ type: 'garbageIn', lines: risen })
  }

  _topOut(reason) {
    if (this.gameOver) return
    this.gameOver = true
    this.events.push({ type: 'topout', reason })
  }

  // --- views ----------------------------------------------------------------

  /** Attack scaling, 1 until three minutes in, then slowly rising. */
  get garbageMultiplier() {
    if (this.time <= TIMING.garbageMultMargin) return 1
    return 1 + ((this.time - TIMING.garbageMultMargin) / 1000) * TIMING.garbageMultIncrease
  }

  /** Pending garbage lines in total. */
  get incoming() {
    return this.garbageQueue.reduce((a, g) => a + g.lines, 0)
  }

  /** ASCII grid of the VISIBLE field only, top row first. */
  toAscii() {
    return this.board
      .slice(BUFFER)
      .map((row) => row.map((c) => (c ? '#' : '.')).join(''))
      .join('\n')
  }
}
