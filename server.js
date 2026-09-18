// Human vs Jev: static files plus Jev's decision endpoint.
//
// Both games run in the browser, in real time, so the human's inputs never make
// a network round trip. The server holds the API key and the pooled keep-alive
// connection to TypeSafe, and answers one question: given this position, where
// does Jev put the piece?
//
//   POST /decide   { board, current, hold, queue, canHold, combo, b2b, incoming, opponent }
//               -> { choice: { id, useHold, rot, x, y, spin, cells, path, sent, label },
//                    confidence, probabilities, latencyMs, options, total, fallback }
//   GET  /health   -> { ok, model }   (the VS screen checks this before a match)

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { COLS, ROWS } from './engine/pieces.js'
import { JevClient } from './ai/jev.js'
import {
  candidatesFor, buildBattleState, buildBattleQuestions, readBattleDecision,
} from './ai/battle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 8081, not 8080: service workers are scoped per-origin and outlive the server that
// registered them. An unrelated local app left one on :8080 that serves a cached page
// from its own origin, so this UI could never load there. A different port is a
// different origin, which sidesteps it entirely. Override with PORT=... for the old one.
const PORT = Number(process.env.PORT ?? 8081)

const REQUEST_MS = 6_000 // a battle cannot wait long; the client falls back past this
const BODY_MAX = 64 * 1024

const jev = new JevClient()

// --- decisions -----------------------------------------------------------------

const TYPES = new Set(['I', 'O', 'T', 'S', 'Z', 'J', 'L'])

/** Reject anything that is not a well-formed position before doing work on it. */
function parsePosition(body) {
  const p = JSON.parse(body)
  const okBoard =
    Array.isArray(p.board) &&
    p.board.length === ROWS &&
    p.board.every((r) => Array.isArray(r) && r.length === COLS)
  if (!okBoard) throw new Error('board must be ROWS x COLS')
  if (!p.current || !TYPES.has(p.current.type)) throw new Error('bad current piece')
  for (const k of ['rot', 'x', 'y']) {
    if (!Number.isInteger(p.current[k])) throw new Error(`bad current.${k}`)
  }
  if (!Array.isArray(p.queue) || !p.queue.every((t) => TYPES.has(t))) throw new Error('bad queue')
  if (p.hold != null && !TYPES.has(p.hold)) throw new Error('bad hold')
  return {
    board: p.board.map((r) => r.map((c) => (c ? String(c).slice(0, 1) : null))),
    current: { type: p.current.type, rot: p.current.rot, x: p.current.x, y: p.current.y },
    hold: p.hold ?? null,
    queue: p.queue.slice(0, 12),
    canHold: p.canHold !== false,
    combo: Number.isInteger(p.combo) ? p.combo : -1,
    b2b: Number.isInteger(p.b2b) ? p.b2b : -1,
    incoming: Number(p.incoming) || 0,
    opponent: p.opponent && Number.isFinite(p.opponent.maxHeight) ? { maxHeight: p.opponent.maxHeight } : null,
  }
}

const wire = (c) => ({
  id: c.id, useHold: c.useHold, type: c.type, rot: c.rot, x: c.x, y: c.y,
  spin: c.spin, cells: c.cells, path: c.path, sent: c.sent, lines: c.lines, label: c.label,
})

let decided = 0

async function decide(pos) {
  const { candidates, total, heuristic } = candidatesFor(pos)
  if (!candidates.length) return { choice: null, options: 0, total }

  const state = buildBattleState(pos, candidates, pos.opponent)
  const questions = buildBattleQuestions(candidates)

  let d = null
  let error = null
  try {
    const response = await jev.ask(state, questions, { timeoutMs: REQUEST_MS, retries: 0 })
    d = readBattleDecision(response, candidates)
  } catch (err) {
    error = err.message
  }

  // Fallback keeps the match playable through a failed or malformed answer. It
  // is reported on the wire and shown on screen, never passed off as Jev's.
  const fallback = !d?.chosen
  const chosen = fallback ? heuristic : d.chosen
  const probs = d?.probabilities
    ? Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, p]) => ({ id, p }))
    : null

  decided++
  console.log(
    `  [${String(decided).padStart(4)}] ${chosen.type} ${chosen.id.padEnd(12)}` +
      ` sends ${chosen.sent}${chosen.spin !== 'none' ? ` ${chosen.spin}-spin` : ''}` +
      ` conf ${(d?.confidence ?? 0).toFixed(2)} ${String(d?.latencyMs ?? '--').padStart(4)}ms` +
      ` ${candidates.length}/${total} opts${fallback ? `  FALLBACK${error ? ` (${error})` : ''}` : ''}`
  )

  return {
    choice: wire(chosen),
    confidence: d?.confidence ?? null,
    probabilities: probs,
    latencyMs: d?.latencyMs ?? null,
    options: candidates.length,
    total,
    fallback,
    error,
  }
}

// --- HTTP ------------------------------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

// Explicit map rather than a directory walk: the browser gets the page and the
// engine modules it shares with the server, and nothing else.
const STATIC = {
  '/': 'public/index.html',
  '/app.js': 'public/app.js',
  '/style.css': 'public/style.css',
  '/render.js': 'public/render.js',
  '/input.js': 'public/input.js',
  '/bot.js': 'public/bot.js',
  '/predict.js': 'public/predict.js',
  '/engine/pieces.js': 'engine/pieces.js',
  '/engine/engine.js': 'engine/engine.js',
  '/engine/rules.js': 'engine/rules.js',
  '/engine/rng.js': 'engine/rng.js',
  '/engine/search.js': 'engine/search.js',
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'POST' && url.pathname === '/decide') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > BODY_MAX) req.destroy()
    })
    req.on('end', async () => {
      let pos
      try {
        pos = parsePosition(body)
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
      try {
        json(res, 200, await decide(pos))
      } catch (err) {
        console.error('  ! decide failed:', err)
        json(res, 500, { error: err.message })
      }
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, model: jev.model, ...jev.stats() })
  }

  const rel = STATIC[url.pathname]
  if (req.method === 'GET' && rel) {
    const file = path.join(__dirname, rel)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'text/plain',
      'Cache-Control': 'no-store',
    })
    res.end(fs.readFileSync(file))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

// Starting a second copy is an easy mistake to make, and Node's default
// response is an unhandled 'error' event with a stack trace. Say what is
// actually wrong and what to do about it instead.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use.`)
    console.error(`A server is probably already running — just open http://localhost:${PORT}`)
    console.error('')
    console.error('  stop the running one:  pkill -f "node server.js"')
    console.error(`  or use a different port:  PORT=${PORT + 1} node server.js`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, () => {
  console.log(`Tsagaanbayar vs Jev  ->  http://localhost:${PORT}`)
  console.log(`model ${jev.model} via ${jev.baseUrl}, keep-alive pooled\n`)
})
