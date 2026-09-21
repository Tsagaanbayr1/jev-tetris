// Real-time versus: you vs a bot (Jev or Laya), or Jev vs Laya.
//
// Both games run here in one animation loop, so the human's keys are never
// delayed by the network. Jev's placements come from the server (/decide), and
// are then played back as real inputs by bot.js.
//
// Screens: VS intro -> countdown -> match -> result. The match stops the moment
// either player tops out: no more inputs, no more requests to Jev.

import { Game } from '/engine/engine.js'
import { randomSeed } from '/engine/rng.js'
import { setupCanvas, drawPlayer, Effects, CANVAS_W, CANVAS_H, LOG_BOX, COLOR } from './render.js'
import { Input } from './input.js'
import { JevBot } from './bot.js'

const $ = (id) => document.getElementById(id)

const HUMAN = 'TSAGAANBAYAR'

// Who plays each side. `left: null` is the human at the keyboard. Internally the
// left board is still `human` and the right board `jev`, whoever plays them.
const BOTS = {
  jev: { name: 'JEV', tag: 'BOT · jev-latest', blurb: 'Jev chooses every placement itself from the moves it can reach. Each choice goes through the TypeSafe API.' },
  laya: { name: 'LAYA', tag: 'BOT · laya-multilingual', blurb: 'Laya chooses every placement itself, spins included, from the moves it can reach. Each choice runs locally on the Laya Multilingual model.' },
}
const MODES = {
  'human-laya': { left: null, right: 'laya' },
  'human-jev': { left: null, right: 'jev' },
  'jev-laya': { left: 'jev', right: 'laya' },
}
const mode = () => MODES[$('mode').value] ?? MODES['human-laya']
const leftName = (md) => (md.left ? BOTS[md.left].name : HUMAN)
/** Each bot has its own speed setting; MAX drops pieces as fast as decisions arrive. */
function pace(model) {
  const v = $(`${model}-pps`).value
  return v === 'max' ? { pps: 0, turbo: true } : { pps: Number(v), turbo: false }
}

let ctxHuman, ctxJev

// Boards fill the window: the biggest scale at which both fit side by side,
// leaving room for the top bar, names, stats line, decision line and footer.
const CHROME_H = 210
const ARENA_GAP = 32
function fitBoards() {
  const byH = (window.innerHeight - CHROME_H) / CANVAS_H
  const byW = (window.innerWidth - ARENA_GAP - 24) / 2 / CANVAS_W
  const scale = Math.max(0.6, Math.min(byH, byW))
  ctxHuman = setupCanvas($('c-human'), CANVAS_W, CANVAS_H, scale)
  ctxJev = setupCanvas($('c-jev'), CANVAS_W, CANVAS_H, scale)
  for (const id of ['log-left', 'log-right']) {
    const st = $(id).style
    st.left = `${LOG_BOX.x * scale}px`
    st.top = `${LOG_BOX.y * scale}px`
    st.width = `${LOG_BOX.w * scale}px`
    st.height = `${LOG_BOX.h * scale}px`
    st.setProperty('--s', scale)
  }
}
fitBoards()
window.addEventListener('resize', fitBoards)
const input = new Input()

let match = null // { human, jev, fxH, fxJ, bot, phase, startedAt, paused }

// --- screens -------------------------------------------------------------------

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('show', s.id === id)
}

function modal(id, on) {
  $(id).classList.toggle('show', on)
}

/** Show who is playing on the VS screen and the match bar. */
function applyMode() {
  const md = mode()
  const L = md.left && BOTS[md.left]
  const R = BOTS[md.right]
  $('left-tag').textContent = L ? L.tag : 'HUMAN'
  $('left-name').textContent = leftName(md)
  $('left-blurb').hidden = !L
  $('left-blurb').textContent = L ? L.blurb : ''
  $('left-keys').hidden = !!L
  $('right-tag').textContent = R.tag
  $('right-name').textContent = R.name
  $('right-blurb').textContent = R.blurb
  $('bar-left').textContent = leftName(md)
  $('bar-left-role').textContent = L ? 'bot' : 'you'
  $('bar-right').textContent = R.name
  $('opt-jev').hidden = !(md.left === 'jev' || md.right === 'jev')
  $('opt-laya').hidden = !(md.left === 'laya' || md.right === 'laya')
  $('pname-left').textContent = leftName(md)
  $('pname-right').textContent = R.name
  document.title = `${L ? L.name[0] + L.name.slice(1).toLowerCase() : 'Tsagaanbayar'} vs ${R.name[0] + R.name.slice(1).toLowerCase()}`
  checkJev()
}

async function checkJev() {
  const el = $('jev-status')
  const md = mode()
  const needed = [md.left, md.right].filter(Boolean)
  const label = (k) => BOTS[k].name[0] + BOTS[k].name.slice(1).toLowerCase()
  try {
    const res = await fetch('/health')
    const h = await res.json()
    const down = needed.filter((k) => !h.models?.[k]?.ok)
    if (down.length) {
      el.textContent = down.map((k) => `${label(k)} is offline: ${h.models?.[k]?.error ?? 'unknown'}`).join(' · ')
      el.className = 'vs-status bad'
    } else {
      el.textContent = needed.map((k) => `${label(k)} online`).join(' · ')
      el.className = 'vs-status ok'
    }
  } catch {
    el.textContent = 'server offline: start it with  node server.js'
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
  const md = mode()
  applyMode()

  match = {
    md,
    human,
    jev,
    fxH: new Effects(),
    fxJ: new Effects(),
    bot: new JevBot(jev, { ...pace(md.right), model: md.right, opponent: human, onDecision: (d) => showDecision(d, 'think') }),
    leftBot: md.left
      ? new JevBot(human, { ...pace(md.left), model: md.left, opponent: jev, onDecision: (d) => showDecision(d, 'think-left') })
      : null,
    phase: 'countdown',
    paused: false,
    elapsed: 0,
    winner: null,
  }

  modal('result', false)
  modal('paused', false)
  $('think').textContent = ''
  $('think-left').textContent = ''
  for (const id of ['log-left', 'log-right']) {
    $(id).innerHTML = ''
    $(id).dataset.n = 0
  }
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
      input.enabled = !match.leftBot // bot vs bot: the keyboard stays out of it
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
  match.leftBot?.stop()
  // A moment to see the final board before the result card covers it.
  setTimeout(showResult, 900)
}

function showResult() {
  const m = match
  const won = m.winner === 'human'
  const L = leftName(m.md)
  const R = BOTS[m.md.right].name
  $('r-kicker').textContent = m.leftBot ? 'MATCH OVER' : won ? 'VICTORY' : 'DEFEAT'
  $('r-title').textContent = `${won ? L : R} WINS`
  $('r-title').className = `card-title ${m.winner}`

  const mins = Math.max(m.elapsed / 60000, 1e-9)
  const secs = Math.max(m.elapsed / 1000, 1e-9)
  const row = (label, f) => `<tr><td>${label}</td><td>${f(m.human)}</td><td>${f(m.jev)}</td></tr>`
  $('r-table').innerHTML = `
    <tr><th></th><th>${L}</th><th>${R}</th></tr>
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
    match.leftBot?.stop()
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
  input.enabled = !on && !match.leftBot
  input.reset()
  modal('paused', on)
}

// --- Jev's latest decision -----------------------------------------------------------

function showDecision(d, el = 'think') {
  logDecision(d, el === 'think' ? 'log-right' : 'log-left')
  const c = d.choice
  if (!c) {
    $(el).textContent = `no decision (${d.error ?? 'unknown error'}), dropping in place`
    return
  }
  const spin =
    c.spin === 'none' ? '' : c.type === 'T' && c.spin === 'full' ? ' T-spin' : ` ${c.type}-spin`
  const what = c.lines ? `${['', 'single', 'double', 'triple', 'quad'][c.lines]}${spin}` : spin.trim() || 'place'
  const conf = d.confidence == null ? '' : ` · conf ${d.confidence.toFixed(2)}`
  const lat = d.prefetched ? ' · pre-planned' : d.latencyMs == null ? '' : ` · ${d.latencyMs}ms`
  $(el).textContent =
    `${d.fallback ? 'FALLBACK · ' : ''}${c.useHold ? 'hold · ' : ''}${what}` +
    `${c.sent ? ` · sends ${c.sent}` : ''}${conf}${lat} · ${d.options}/${d.total} options`
}

// --- decision log: newest on top, under each player's hold box ------------------------

const LOG_MAX = 14
const LOG_TOP = 3 // options shown per decision

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])

/** "hold, then L piece, right-facing, columns 1-2" -> "hold → L right · cols 1-2" */
function shortLabel(label) {
  return String(label)
    .replace('hold, then ', 'hold → ')
    .replace(' piece,', '')
    .replace(/-facing/, '')
    .replace('upside-down', '180')
    .replace(', columns ', ' · cols ')
    .replace(', column ', ' · col ')
}

function logDecision(d, id) {
  const box = $(id)
  const n = Number(box.dataset.n ?? 0) + 1
  box.dataset.n = n
  const c = d.choice
  const item = document.createElement('div')
  item.className = 'dl-item'

  if (!c) {
    item.innerHTML = `<div class="dl-head"><span class="dl-n">#${n}</span><span class="dl-bad">no decision</span></div>`
  } else {
    const spin = c.spin === 'none' ? '' : c.type === 'T' && c.spin === 'full' ? 'T-spin ' : `${c.type}-spin `
    const what = c.lines ? `${spin}${['', 'single', 'double', 'triple', 'quad'][c.lines]}` : spin ? spin.trim() : 'place'
    const bits = [c.useHold ? 'hold' : '', what, c.sent ? `sends ${c.sent}` : ''].filter(Boolean).join(' · ')
    const timing = d.fallback ? '<span class="dl-bad">FALLBACK</span>' : d.prefetched ? 'pre-planned' : d.latencyMs != null ? `${d.latencyMs}ms` : ''
    const opts = (d.probabilities ?? []).slice(0, LOG_TOP)
    if (!d.fallback && !opts.some((o) => o.id === c.id)) opts.push({ id: c.id, p: null, label: c.label })
    const rows = opts.map((o) => {
      const pct = o.p == null ? '—' : `${Math.round(o.p * 100)}%`
      const chosen = o.id === c.id
      return `<div class="dl-opt${chosen ? ' chosen' : ''}">
        <span class="dl-bar" style="width:${Math.round((o.p ?? 0) * 100)}%"></span>
        <span class="dl-pct">${pct}</span><span class="dl-lab">${chosen ? '✓ ' : ''}${esc(shortLabel(o.label ?? o.id))}</span></div>`
    }).join('')
    const fb = d.fallback ? `<div class="dl-opt chosen"><span class="dl-lab">✓ ${esc(shortLabel(c.label ?? c.id))} (shortlist pick)</span></div>` : ''
    item.innerHTML = `
      <div class="dl-head"><span class="dl-n">#${n}</span><b style="color:${COLOR[c.type]}">${c.type}</b>
        <span class="dl-what">${esc(bits)}</span><span class="dl-t">${timing}</span></div>
      ${rows}${fb}
      <div class="dl-meta">conf ${d.confidence == null ? '—' : d.confidence.toFixed(2)} · ${d.options}/${d.total} options</div>`
  }
  box.prepend(item)
  while (box.children.length > LOG_MAX) box.lastChild.remove()
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

      if (m.leftBot) {
        m.leftBot.update(dt, h.time)
      } else {
        input.update(dt, h)
        // Soft drop is SDF times gravity; a floor keeps it usable at low gravity.
        h.softDropG = input.softDropping ? Math.max(h.gravity * input.handling.sdf, 0.35) : 0
      }
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
$('mode').onchange = applyMode
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

applyMode()
requestAnimationFrame(frame)
