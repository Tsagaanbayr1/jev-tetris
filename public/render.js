// Canvas drawing for one player's field: board, ghost, falling piece, hold,
// next queue, incoming-garbage meter and short-lived effects.
//
// Everything here only READS game state. Effects are driven by the events the
// engine emits (lock, clear, spin, garbage...), so the renderer never has to
// guess what happened between frames.

import { CELLS, COLS, ROWS, BUFFER, cellsAt } from '/engine/pieces.js'

export const CELL = 28
const VIS = ROWS - BUFFER
export const FIELD_W = COLS * CELL
export const FIELD_H = VIS * CELL
const SIDE = 4.2 * CELL // hold / next column width
const METER = 10 // garbage meter width
const GAP = 10

// Two rows of headroom above the field, where pieces spawn, so a new piece is
// seen whole rather than poking in from off-screen.
const HEAD = 2 * CELL

export const CANVAS_W = SIDE + GAP + METER + 4 + FIELD_W + GAP + SIDE
export const CANVAS_H = HEAD + FIELD_H + 2 // + a hair for the border

export const COLOR = {
  I: '#3fd0e6', O: '#f2d24b', T: '#b26cf0',
  S: '#63d65f', Z: '#f0606d', J: '#5b7ff0', L: '#f29d4a',
  G: '#6d7480', // garbage
}

/** Size a canvas for the device pixel ratio and return a 1:1 context. */
export function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

function block(ctx, px, py, size, color, alpha = 1) {
  ctx.globalAlpha = alpha
  ctx.fillStyle = color
  ctx.fillRect(px + 1, py + 1, size - 2, size - 2)
  // a soft top-left highlight gives the blocks a little depth
  ctx.globalAlpha = alpha * 0.28
  ctx.fillStyle = '#fff'
  ctx.fillRect(px + 1, py + 1, size - 2, 3)
  ctx.fillRect(px + 1, py + 1, 3, size - 2)
  ctx.globalAlpha = alpha * 0.25
  ctx.fillStyle = '#000'
  ctx.fillRect(px + 1, py + size - 4, size - 2, 3)
  ctx.globalAlpha = 1
}

function ghost(ctx, px, py, size, color) {
  ctx.globalAlpha = 0.22
  ctx.fillStyle = color
  ctx.fillRect(px + 1, py + 1, size - 2, size - 2)
  ctx.globalAlpha = 0.55
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.strokeRect(px + 2, py + 2, size - 4, size - 4)
  ctx.globalAlpha = 1
}

/** Draw a piece's spawn orientation centred in a box. */
function mini(ctx, type, x, y, w, h, alpha = 1) {
  if (!type) return
  const cells = CELLS[type][0]
  const xs = cells.map((c) => c[0])
  const ys = cells.map((c) => c[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const spanX = Math.max(...xs) - minX + 1
  const spanY = Math.max(...ys) - minY + 1
  const size = Math.min(CELL * 0.72, (w - 10) / spanX, (h - 10) / spanY)
  const ox = x + (w - spanX * size) / 2
  const oy = y + (h - spanY * size) / 2
  for (const [cx, cy] of cells) {
    block(ctx, ox + (cx - minX) * size, oy + (cy - minY) * size, size, COLOR[type], alpha)
  }
}

// --- effects -------------------------------------------------------------------

/**
 * Per-player effect state. `push(event)` is fed from game.events; `draw` fades
 * each effect out over its lifetime.
 */
export class Effects {
  constructor() {
    this.items = []
    this.shake = 0
    this.rise = 0 // garbage just rose: board slides up from this many px
  }

  push(ev, now) {
    switch (ev.type) {
      case 'clear':
        this.items.push({ kind: 'flash', rows: ev.rows, t0: now, life: 220 })
        break
      case 'hardDrop':
        this.items.push({ kind: 'trail', cells: ev.cells, from: ev.fromY, t0: now, life: 160, color: COLOR[ev.piece] })
        break
      case 'callout':
        this.items.push({ kind: 'text', lines: ev.lines, t0: now, life: 1400, tone: ev.tone })
        break
      case 'garbageIn':
        this.shake = Math.min(10, 3 + ev.lines * 1.2)
        this.rise = ev.lines * CELL
        break
      case 'attack':
        this.items.push({ kind: 'sent', lines: ev.lines, t0: now, life: 900 })
        break
    }
  }

  step(dt) {
    this.shake = Math.max(0, this.shake - dt * 0.03)
    this.rise = Math.max(0, this.rise - dt * 0.9)
  }
}

// --- field -------------------------------------------------------------------

/**
 * Draw one player's full panel: hold | meter | field | next.
 * `game` is an engine Game; `fx` its Effects; `now` a ms clock.
 */
export function drawPlayer(ctx, game, fx, now, { dim = false } = {}) {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
  ctx.save()
  ctx.translate(0, HEAD) // everything below is laid out from the field's top edge

  const fieldX = SIDE + GAP + METER + 4
  const sx = (Math.random() - 0.5) * fx.shake
  const sy = (Math.random() - 0.5) * fx.shake

  // --- hold
  ctx.fillStyle = '#8b97a8'
  ctx.font = '600 11px ui-sans-serif, -apple-system, sans-serif'
  ctx.fillText('HOLD', 4, 14)
  panelBox(ctx, 0, 22, SIDE, SIDE * 0.72)
  mini(ctx, game.hold, 0, 22, SIDE, SIDE * 0.72, game.canHold ? 1 : 0.35)

  // --- next
  const nx = fieldX + FIELD_W + GAP
  ctx.fillStyle = '#8b97a8'
  ctx.fillText('NEXT', nx + 4, 14)
  const slot = SIDE * 0.62
  panelBox(ctx, nx, 22, SIDE, slot * 5 + 8)
  for (let i = 0; i < 5; i++) mini(ctx, game.queue[i], nx, 26 + i * slot, SIDE, slot)

  // --- garbage meter: pending lines, red once they are ready to enter
  const mx = SIDE + GAP
  ctx.fillStyle = '#0a0d12'
  ctx.fillRect(mx, 0, METER, FIELD_H)
  let my = FIELD_H
  for (const g of game.garbageQueue ?? []) {
    const h = Math.min(my, g.lines * CELL)
    const ready = game.time >= g.readyAt // garbage timing runs on game time
    ctx.fillStyle = ready ? '#f0606d' : '#f2b84b'
    ctx.fillRect(mx + 1, my - h + 1, METER - 2, h - 2)
    my -= h
    if (my <= 0) break
  }

  // --- the field itself
  ctx.save()
  ctx.translate(fieldX + sx, sy)
  ctx.beginPath()
  ctx.rect(0, -HEAD, FIELD_W, FIELD_H + HEAD) // the headroom is drawable too
  ctx.clip()

  ctx.fillStyle = '#080b10'
  ctx.fillRect(0, 0, FIELD_W, FIELD_H)
  ctx.strokeStyle = '#131a23'
  ctx.lineWidth = 1
  for (let x = 1; x < COLS; x++) line(ctx, x * CELL + 0.5, 0, x * CELL + 0.5, FIELD_H)
  for (let y = 1; y < VIS; y++) line(ctx, 0, y * CELL + 0.5, FIELD_W, y * CELL + 0.5)

  // garbage rising: the whole stack slides up into place
  const rise = fx.rise
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = game.board[y][x]
      if (!c) continue
      const py = (y - BUFFER) * CELL + rise
      if (py + CELL < -HEAD) continue
      block(ctx, x * CELL, py, CELL, COLOR[c] ?? COLOR.G, dim ? 0.55 : 1)
    }
  }

  const p = game.current
  if (p && !game.gameOver) {
    const color = COLOR[p.type]
    const gy = game.ghostY()
    for (const [cx, cy] of cellsAt(p.type, p.rot, p.x, gy)) {
      if (cy >= BUFFER) ghost(ctx, cx * CELL, (cy - BUFFER) * CELL, CELL, color)
    }
    // Smooth fall: draw the piece part-way to the next row, but only when it
    // really can fall, so it never visually sinks into the stack.
    const frac = game.fallFraction()
    // Fade toward white as lock delay runs out, like modern clients do.
    const lockFade = game.lockProgress()
    for (const [cx, cy] of cellsAt(p.type, p.rot, p.x, p.y)) {
      const py = (cy - BUFFER + frac) * CELL
      if (py + CELL <= -HEAD) continue
      block(ctx, cx * CELL, py, CELL, color)
      if (lockFade > 0) {
        ctx.globalAlpha = lockFade * 0.35
        ctx.fillStyle = '#fff'
        ctx.fillRect(cx * CELL + 1, py + 1, CELL - 2, CELL - 2)
        ctx.globalAlpha = 1
      }
    }
  }

  // effects inside the field
  for (const it of fx.items) {
    const k = 1 - (now - it.t0) / it.life
    if (k <= 0) continue
    if (it.kind === 'flash') {
      ctx.globalAlpha = k * 0.85
      ctx.fillStyle = '#ffffff'
      for (const r of it.rows) ctx.fillRect(0, (r - BUFFER) * CELL, FIELD_W, CELL)
      ctx.globalAlpha = 1
    } else if (it.kind === 'trail') {
      // a short streak from where the piece was dropped down to where it landed
      ctx.globalAlpha = k * 0.35
      ctx.fillStyle = it.color
      const top = (it.from - BUFFER) * CELL
      for (const cx of new Set(it.cells.map(([x]) => x))) {
        const low = Math.min(...it.cells.filter(([x]) => x === cx).map(([, y]) => y))
        const h = (low - BUFFER) * CELL - top
        if (h > 0) ctx.fillRect(cx * CELL + 3, top, CELL - 6, h)
      }
      ctx.globalAlpha = 1
    }
  }

  // game-over veil
  if (game.gameOver) {
    ctx.fillStyle = 'rgba(8, 11, 16, 0.55)'
    ctx.fillRect(0, 0, FIELD_W, FIELD_H)
  }

  ctx.restore()

  // field border (outside the clip so it never shakes off-screen)
  ctx.strokeStyle = '#2a3542'
  ctx.lineWidth = 1
  ctx.strokeRect(fieldX + 0.5, 0.5, FIELD_W, FIELD_H)

  // callouts: spin names, B2B, combo, all clear, under the hold box
  let ty = SIDE * 0.72 + 60
  const recent = fx.items.filter((it) => it.kind === 'text' && now - it.t0 < it.life).slice(-3)
  for (const it of recent) {
    const k = 1 - (now - it.t0) / it.life
    const a = Math.min(1, k * 3)
    const slide = (1 - Math.min(1, (now - it.t0) / 120)) * 12
    ctx.globalAlpha = a
    ctx.textAlign = 'right'
    it.lines.forEach((text, i) => {
      ctx.fillStyle = i === 0 ? toneColor(it.tone) : '#e6edf5'
      ctx.font = i === 0 ? '800 15px ui-sans-serif, -apple-system, sans-serif' : '700 12px ui-sans-serif, -apple-system, sans-serif'
      ctx.fillText(text, SIDE - 2 + slide, ty + i * 17)
    })
    ctx.textAlign = 'left'
    ctx.globalAlpha = 1
    ty += it.lines.length * 17 + 14
  }

  // lines sent: a brief "+N" over the meter
  for (const it of fx.items) {
    if (it.kind !== 'sent') continue
    const t = (now - it.t0) / it.life
    if (t >= 1) continue
    ctx.globalAlpha = 1 - t
    ctx.fillStyle = '#f2b84b'
    ctx.font = '800 20px ui-sans-serif, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`+${it.lines}`, fieldX + FIELD_W / 2, FIELD_H * 0.35 - t * 40)
    ctx.textAlign = 'left'
    ctx.globalAlpha = 1
  }

  ctx.restore()
  fx.items = fx.items.filter((it) => now - it.t0 < it.life)
}

function toneColor(tone) {
  return { spin: '#b26cf0', quad: '#3fd0e6', clear: '#f2d24b', combo: '#63d65f' }[tone] ?? '#e6edf5'
}

function panelBox(ctx, x, y, w, h) {
  ctx.fillStyle = '#0d1219'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = '#1f2833'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}
