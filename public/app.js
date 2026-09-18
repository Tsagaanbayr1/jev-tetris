// Human vs Jev, in real time.
//
// Both games run here in one animation loop, so the human's keys are never
// delayed by the network. Jev's placements come from the server (/decide), and
// are then played back as real inputs by bot.js.
//
// Screens: VS intro -> countdown -> match -> result. The match stops the moment
// either player tops out: no more inputs, no more requests to Jev.

import { Game } from '/engine/engine.js'
import { randomSeed } from '/engine/rng.js'
import { setupCanvas, drawPlayer, Effects, CANVAS_W, CANVAS_H } from './render.js'
import { Input } from './input.js'
import { JevBot } from './bot.js'

const $ = (id) => document.getElementById(id)

const HUMAN = 'TSAGAANBAYAR'
const JEV = 'JEV'

const ctxHuman = setupCanvas($('c-human'), CANVAS_W, CANVAS_H)
const ctxJev = setupCanvas($('c-jev'), CANVAS_W, CANVAS_H)
const input = new Input()

let match = null // { human, jev, fxH, fxJ, bot, phase, startedAt, paused }

// --- screens -------------------------------------------------------------------

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('show', s.id === id)
}

function modal(id, on) {
  $(id).classList.toggle('show', on)
}

async function checkJev() {
  const el = $('jev-status')
  try {
    const res = await fetch('/health')
    const h = await res.json()
    el.textContent = `Jev is online · ${h.model}`
    el.className = 'vs-status ok'
  } catch {
    el.textContent = 'Jev is offline: start the server with  node server.js'
    el.className = 'vs-status bad'
  }
}

// --- match lifecycle ----------------------------------------------------------------

function newMatch() {
  const seed = randomSeed()
  // Same seed = the same piece sequence for both players, as in online versus.
  // Garbage holes come from separate streams.
  const human = new Game({ seed, garbageSeed: seed + 1 })
  const jev = new Game({ seed, garbageSeed: seed + 2 })
  const pps = Number($('jev-pps').value)

  match = {
    human,
    jev,
    fxH: new Effects(),
    fxJ: new Effects(),
    bot: new JevBot(jev, { pps, opponent: human, onDecision: showDecision }),
    phase: 'countdown',
    paused: false,
    elapsed: 0,
    pps,
    winner: null,
  }

  modal('result', false)
  modal('paused', false)
  $('think').textContent = ''
  show('match')
  countdown()
}

function countdown() {
  const el = $('countdown')
  const steps = ['3', '2', '1', 'GO!']
  let i = 0
  const tick = () => {
    if (!match || match.phase !== 'countdown') return
    el.innerHTML = `<span class="tick">${steps[i]}</span>`
    if (steps[i] === 'GO!') {
      match.phase = 'playing'
      input.reset()
      input.enabled = true
      setTimeout(() => (el.innerHTML = ''), 700)
      return
    }
    i++
    setTimeout(tick, 800)
  }
  tick()
}

function endMatch(loser) {
  if (match.phase !== 'playing') return
  match.phase = 'over'
  match.winner = loser === 'human' ? 'jev' : 'human'
  input.enabled = false
  match.human.softDropG = 0
  match.bot.stop()
  // A moment to see the final board before the result card covers it.
  setTimeout(showResult, 900)
}

function showResult() {
  const m = match
  const won = m.winner === 'human'
  $('r-kicker').textContent = won ? 'VICTORY' : 'DEFEAT'
  $('r-title').textContent = `${won ? HUMAN : JEV} WINS`
  $('r-title').className = `card-title ${m.winner}`

  const mins = Math.max(m.elapsed / 60000, 1e-9)
  const secs = Math.max(m.elapsed / 1000, 1e-9)
  const row = (label, f) => `<tr><td>${label}</td><td>${f(m.human)}</td><td>${f(m.jev)}</td></tr>`
  $('r-table').innerHTML = `
    <tr><th></th><th>${HUMAN}</th><th>${JEV}</th></tr>
    ${row('pieces', (g) => g.stats.pieces)}
    ${row('PPS', (g) => (g.stats.pieces / secs).toFixed(2))}
    ${row('attack', (g) => g.stats.attack)}
    ${row('APM', (g) => (g.stats.attack / mins).toFixed(1))}
    ${row('lines', (g) => g.stats.lines)}
    ${row('spins', (g) => g.stats.spins)}
    ${row('max combo', (g) => Math.max(0, g.stats.maxCombo))}
    ${row('max B2B', (g) => Math.max(0, g.stats.maxB2b))}
    <tr><td>time</td><td colspan="2">${clock(m.elapsed)}</td></tr>`
  modal('result', true)
}

function toMenu() {
  if (match) {
    match.phase = 'over'
    match.bot.stop()
  }
  match = null
  input.enabled = false
  modal('result', false)
  modal('paused', false)
  show('vs')
  checkJev()
}

function setPaused(on) {
  if (!match || match.phase !== 'playing') return
  match.paused = on
  input.enabled = !on
  input.reset()
  modal('paused', on)
}

// --- Jev's latest decision -----------------------------------------------------------

function showDecision(d) {
  const c = d.choice
  if (!c) {
    $('think').textContent = `no decision (${d.error ?? 'unknown error'}), dropping in place`
    return
  }
  const spin =
    c.spin === 'none' ? '' : c.type === 'T' && c.spin === 'full' ? ' T-spin' : ` ${c.type}-spin`
  const what = c.lines ? `${['', 'single', 'double', 'triple', 'quad'][c.lines]}${spin}` : spin.trim() || 'place'
  const conf = d.confidence == null ? '' : ` · conf ${d.confidence.toFixed(2)}`
  const lat = d.prefetched ? ' · pre-planned' : d.latencyMs == null ? '' : ` · ${d.latencyMs}ms`
  $('think').textContent =
    `${d.fallback ? 'FALLBACK · ' : ''}${c.useHold ? 'hold · ' : ''}${what}` +
    `${c.sent ? ` · sends ${c.sent}` : ''}${conf}${lat} · ${d.options}/${d.total} options`
}

// --- loop ----------------------------------------------------------------------------

function clock(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function statsHTML(g, elapsed) {
  const secs = Math.max(elapsed / 1000, 1e-9)
  const cell = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`
  return (
    cell('PPS', (g.stats.pieces / secs).toFixed(2)) +
    cell('APM', ((g.stats.attack / secs) * 60).toFixed(1)) +
    cell('sent', g.stats.attack) +
    cell('lines', g.stats.lines) +
    cell('B2B', Math.max(0, g.b2b)) +
    cell('combo', Math.max(0, g.combo))
  )
}

/** Deliver each game's events: effects, attacks to the opponent, top-out. */
function drain(game, fx, other, who, now) {
  for (const ev of game.events) {
    fx.push(ev, now)
    if (ev.type === 'attack') other.receive(ev.lines)
    if (ev.type === 'topout') endMatch(who)
  }
  game.events.length = 0
}

let last = performance.now()
let statsTimer = 0

function frame(now) {
  const dt = Math.min(now - last, 50) // a background tab must not fast-forward
  last = now
  const m = match

  if (m) {
    if (m.phase === 'playing' && !m.paused) {
      m.elapsed += dt
      const h = m.human

      input.update(dt, h)
      // Soft drop is SDF times gravity; a floor keeps it usable at low gravity.
      h.softDropG = input.softDropping ? Math.max(h.gravity * input.handling.sdf, 0.35) : 0
      h.update(dt)

      m.bot.update(dt, m.jev.time)
      m.jev.update(dt)

      drain(h, m.fxH, m.jev, 'human', now)
      if (m.phase === 'playing') drain(m.jev, m.fxJ, h, 'jev', now)

      $('clock').textContent = clock(m.elapsed)
      $('gravity-label').textContent = `gravity ${h.gravity.toFixed(3)} G`
    }

    m.fxH.step(dt)
    m.fxJ.step(dt)
    drawPlayer(ctxHuman, m.human, m.fxH, now, { dim: m.winner === 'jev' })
    drawPlayer(ctxJev, m.jev, m.fxJ, now, { dim: m.winner === 'human' })

    statsTimer += dt
    if (statsTimer > 200) {
      statsTimer = 0
      $('s-human').innerHTML = statsHTML(m.human, m.elapsed)
      $('s-jev').innerHTML = statsHTML(m.jev, m.elapsed)
    }
  }

  requestAnimationFrame(frame)
}

// --- controls ----------------------------------------------------------------------------

$('go').onclick = newMatch
$('rematch').onclick = newMatch
$('menu').onclick = toMenu
$('resume').onclick = () => setPaused(false)
$('forfeit').onclick = toMenu

window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const onVs = $('vs').classList.contains('show')
    const onResult = $('result').classList.contains('show')
    if (onVs || onResult) {
      e.preventDefault()
      newMatch()
    }
  }
  if (e.key === 'Escape' && match?.phase === 'playing') setPaused(!match.paused)
})

checkJev()
requestAnimationFrame(frame)
