// Keyboard handling for the human player, modelled on competitive clients.
//
//   DAS  delayed auto shift: how long a held direction waits before repeating
//   ARR  auto repeat rate: time between repeats once DAS has charged (0 = the
//        piece teleports to the wall)
//   SDF  soft drop factor: soft drop speed as a multiple of gravity
//        (Infinity = the piece drops to the floor instantly, without locking)
//
// Direction keys follow "last pressed wins": holding left then tapping right
// moves right, and releasing right resumes the charged left.

export const DEFAULT_HANDLING = { das: 167, arr: 33, sdf: 6 }

export const DEFAULT_KEYS = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  softDrop: ['ArrowDown'],
  hardDrop: ['Space'],
  rotateCW: ['ArrowUp', 'KeyX'],
  rotateCCW: ['KeyZ', 'ControlLeft', 'ControlRight'],
  rotate180: ['KeyA'],
  hold: ['KeyC', 'ShiftLeft', 'ShiftRight'],
}

export class Input {
  constructor({ keys = DEFAULT_KEYS, handling = DEFAULT_HANDLING } = {}) {
    this.handling = { ...handling }
    this.codeToAction = new Map()
    for (const [action, codes] of Object.entries(keys)) {
      for (const code of codes) this.codeToAction.set(code, action)
    }
    this.enabled = false
    this.reset()

    this._down = (e) => this._onKey(e, true)
    this._up = (e) => this._onKey(e, false)
    window.addEventListener('keydown', this._down)
    window.addEventListener('keyup', this._up)
    // Losing focus while a key is held would leave it stuck down forever.
    window.addEventListener('blur', () => this.reset())
  }

  reset() {
    this.held = new Set()
    this.dirStack = [] // held directions, most recent last
    this.dasTimer = 0
    this.arrTimer = 0
    this.charged = false
    this.pending = [] // one-shot actions queued since the last update
  }

  _onKey(e, down) {
    const action = this.codeToAction.get(e.code)
    if (!action) return
    e.preventDefault()
    if (!this.enabled) return

    if (down) {
      if (e.repeat || this.held.has(action)) return // the OS repeat is ignored; DAS/ARR is ours
      this.held.add(action)
      if (action === 'left' || action === 'right') {
        this.dirStack = this.dirStack.filter((d) => d !== action)
        this.dirStack.push(action)
        this.dasTimer = 0
        this.arrTimer = 0
        this.charged = false
        this.pending.push(action) // the initial tap moves immediately
      } else if (action !== 'softDrop') {
        this.pending.push(action)
      }
    } else {
      this.held.delete(action)
      if (action === 'left' || action === 'right') {
        const wasActive = this.dirStack.at(-1) === action
        this.dirStack = this.dirStack.filter((d) => d !== action)
        // Releasing the active direction hands control back to the other one,
        // still charged, so a held opposite key keeps sliding.
        if (wasActive && this.dirStack.length) {
          this.arrTimer = 0
        }
      }
    }
  }

  get softDropping() {
    return this.enabled && this.held.has('softDrop')
  }

  /** Apply everything that happened since the last frame to `game`. */
  update(dt, game) {
    if (!this.enabled) {
      this.pending = []
      return
    }

    for (const action of this.pending) {
      switch (action) {
        case 'left': game.move(-1); break
        case 'right': game.move(1); break
        case 'rotateCW': game.rotate(1); break
        case 'rotateCCW': game.rotate(-1); break
        case 'rotate180': game.rotate(2); break
        case 'hold': game.holdPiece(); break
        case 'hardDrop': game.hardDrop(); break
      }
    }
    this.pending = []

    const dir = this.dirStack.at(-1)
    if (dir) {
      const dx = dir === 'left' ? -1 : 1
      const { das, arr } = this.handling
      if (!this.charged) {
        this.dasTimer += dt
        if (this.dasTimer >= das) {
          this.charged = true
          this.arrTimer = arr // repeat right away once DAS completes
        }
      }
      if (this.charged) {
        if (arr <= 0) {
          while (game.move(dx)) {} // ARR 0: straight to the wall
        } else {
          this.arrTimer += dt
          while (this.arrTimer >= arr) {
            this.arrTimer -= arr
            if (!game.move(dx)) {
              this.arrTimer = 0
              break
            }
          }
        }
      }
    }
  }
}
