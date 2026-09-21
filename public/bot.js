// Jev's hands. For each new piece: send the position to /decide, then play the
// chosen placement back as real inputs (move, rotate, soft drop, hard drop) at a
// visible pace, so its piece travels and spins exactly like a human's would.
// Never by assigning a position — the renderer only ever draws what the inputs
// did, which is why even MAX speed is watched rather than blinked past.
//
// Gravity keeps running while Jev thinks. The route is therefore re-planned from
// wherever the piece actually is when the answer arrives, not from spawn.
//
// SPEED: the decision round trip is the slow part, but it does not have to sit
// between two pieces. The queue is known in advance, so the moment a placement
// is chosen, the NEXT piece's position is projected from it and asked about
// while the current piece is still travelling. When the next piece really
// appears as projected (checked with a fingerprint of everything the decision
// depends on), the answer is already in hand and play is continuous. When
// reality disagrees (an attack arrived, the piece mislanded), the fingerprint
// misses and we ask fresh — a wasted request, never a wrong move.

// Relative, like predict.js: the browser resolves these to /engine/... and the
// same specifiers let test/bot.test.js drive this module under Node.
import { pathTo } from '../engine/search.js'
import { ROWS } from '../engine/pieces.js'
import { keyOf, projectAfter } from './predict.js'

/** Height of the tallest column, in rows from the floor. */
function stackHeight(board) {
  const top = board.findIndex((row) => row.some((c) => c))
  return top < 0 ? 0 : ROWS - top
}

const STEP_MS = 40 // one input every 40 ms: fast, but you can follow it
const SONIC_G = 2 // soft-drop speed while sliding down to a tuck or spin
// Superhuman: no piece-per-second limit, one input per frame (60/s — several
// times what a hand can hold), and a fast but still drawn-out descent instead
// of a teleport. Every move the bot makes is a real input that the renderer
// draws, so the piece is seen crossing, spinning and falling into place.
const RUSH_G = 4 // rows per frame while falling home in superhuman mode

export class JevBot {
  // superhuman: MAX speed with the animations kept — the route runs an input a
  // frame and the piece drops home fast rather than blinking into position.
  constructor(game, { pps = 1.2, superhuman = false, model = 'jev', opponent = null, onDecision = () => {} } = {}) {
    this.superhuman = superhuman
    this.game = game
    this.url = `/decide?model=${encodeURIComponent(model)}` // which decider plays this board
    this.opponent = opponent
    this.minPieceMs = pps > 0 ? 1000 / pps : 0
    // 0 ms between inputs still only spends ONE input per update() call (the
    // method returns after each one), which is one per frame.
    this.stepMs = superhuman ? 0 : STEP_MS
    this.sonicG = superhuman ? RUSH_G : SONIC_G
    this.onDecision = onDecision
    this.state = 'idle' // idle | thinking | acting
    this.token = -1 // which piece a request belongs to
    this.actions = []
    this.stepTimer = 0
    this.pieceStart = 0
    this.last = null
    this.prefetch = null // { key, promise } for the next piece, if it was projected
    this.stopped = false
  }

  stop() {
    this.stopped = true
    this.prefetch = null
    this.game.softDropG = 0
  }

  update(dt, now) {
    const g = this.game
    if (this.stopped || g.gameOver || !g.current) return

    // A new piece has appeared (the previous one locked): ask about it.
    if (this.state === 'idle' || this.token !== g.stats.pieces) {
      this._ask(now)
      return
    }
    if (this.state !== 'acting') return

    const next = this.actions[0]
    if (next === undefined) return

    if (next === 'sonic') {
      // Slide down smoothly rather than teleporting, then carry on.
      g.softDropG = this.sonicG
      if (g.grounded) {
        g.softDropG = 0
        this.actions.shift()
      }
      return
    }

    if (next === 'fall') {
      // Superhuman landing: fall home fast but visibly, then lock on arrival.
      if (!g.grounded) {
        g.softDropG = this.sonicG
        return
      }
      g.softDropG = 0
      this.actions.shift()
      g.hardDrop() // already at the floor: this only locks it
      this.state = 'idle'
      return
    }

    this.stepTimer += dt
    if (this.stepTimer < this.stepMs) return

    if (next === 'hard') {
      // Pace limit: never place faster than the chosen pieces-per-second.
      if (now - this.pieceStart < this.minPieceMs) return
      this.actions.shift()
      g.hardDrop()
      this.state = 'idle'
      return
    }

    this.stepTimer = 0
    this.actions.shift()
    this._input(next)
  }

  _input(next) {
    const g = this.game
    switch (next) {
      case 'hold':
        g.holdPiece()
        this._plan() // the held-in piece needs its own route
        break
      case 'left': g.move(-1); break
      case 'right': g.move(1); break
      case 'cw': g.rotate(1); break
      case 'ccw': g.rotate(-1); break
      case '180': g.rotate(2); break
      case 'down': g.stepDown(); break
    }
  }

  /** The live position, in exactly the shape /decide expects. */
  _position() {
    const g = this.game
    return {
      board: g.board,
      current: g.current,
      hold: g.hold,
      queue: g.queue,
      canHold: g.canHold,
      combo: g.combo,
      b2b: g.b2b,
      incoming: g.incoming,
      opponent: this.opponent ? { maxHeight: stackHeight(this.opponent.board) } : null,
    }
  }

  async _ask(now) {
    const g = this.game
    this.state = 'thinking'
    this.token = g.stats.pieces
    this.pieceStart = now
    this.actions = []
    this.choice = null
    g.softDropG = 0 // a fresh piece falls at gravity, not at the last one's speed
    const token = this.token

    const body = this._position()
    const key = keyOf(body)
    const pf = this.prefetch
    this.prefetch = null

    let d
    if (pf && pf.key === key) {
      // Decided in advance while the previous piece was still travelling.
      try {
        d = await pf.promise
      } catch (err) {
        d = { choice: null, error: err.message, fallback: true }
      }
      d.prefetched = true
    } else {
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        d = await res.json()
        if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      } catch (err) {
        d = { choice: null, error: err.message, fallback: true }
      }
    }

    // The piece locked on its own (or the match ended) while we waited.
    if (this.stopped || g.gameOver || token !== g.stats.pieces) return

    this.last = d
    this.onDecision(d)
    this.choice = d.choice
    if (!d.choice) {
      this.actions = [this._terminal()] // nothing usable came back: just drop it
    } else {
      if (d.choice.useHold) this.actions = ['hold']
      else this._plan()
      this._prefetchNext(d.choice)
    }
    this.stepTimer = STEP_MS // first input goes out immediately
    this.state = 'acting'
  }

  /**
   * Project the position the NEXT piece will appear in, assuming `choice`
   * lands where it was told to, and ask about it now. Returns null (and
   * prefetches nothing) whenever the outcome cannot be predicted exactly.
   */
  _prefetchNext(choice) {
    const g = this.game
    const oppHeight = this.opponent ? stackHeight(this.opponent.board) : null
    const pos = projectAfter(g, choice, oppHeight)
    if (!pos) return
    const key = keyOf(pos)
    const promise = fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pos),
    }).then(async (res) => {
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`)
      return d
    })
    promise.catch(() => {}) // never an unhandled rejection if it goes unused
    this.prefetch = { key, promise }
  }

  /**
   * How the route ends. A hard drop snaps the piece to the floor and locks it;
   * superhuman instead falls home a few rows a frame and locks on landing, so
   * the descent is part of the animation rather than a teleport that skips it.
   */
  _terminal() {
    return this.superhuman ? 'fall' : 'hard'
  }

  /** Route from where the piece is NOW to the chosen placement. */
  _plan() {
    const g = this.game
    const c = this.choice
    const path = c && g.current ? pathTo(g.board, g.current, c) : null
    // Unreachable now (it fell past a tuck while Jev was thinking): drop it
    // where it stands rather than stall.
    this.actions = [...(path ?? []), this._terminal()]
  }
}