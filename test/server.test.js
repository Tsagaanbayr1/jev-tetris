// Who can reach /decide. Every Jev decision is a paid TypeSafe call made with
// the key the server holds, so only this machine's own game page may ask for one:
// not another device on the network, not another website open in the browser,
// and not a DNS-rebound hostname.
//
// The server runs as a child process with both deciders pointed at a closed
// local port, so these tests never reach TypeSafe or a Laya sidecar.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { COLS, ROWS } from '../engine/pieces.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLOSED = 'http://127.0.0.1:9' // discard port: nothing listens, nothing is sent

let child
let port
let output = ''

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

/** Raw request, so the Host header can be set to anything. */
function request({ method = 'GET', path = '/health', host, headers = {}, body, address = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: address, port, method, path, headers: { Host: host ?? `localhost:${port}`, ...headers }, timeout: 8000 },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (body) req.write(body)
    req.end()
  })
}

const position = JSON.stringify({
  board: Array.from({ length: ROWS }, () => Array(COLS).fill(null)),
  current: { type: 'T', rot: 0, x: 3, y: 19 }, // the spawn position (see engine/engine.js)
  hold: null,
  queue: ['I', 'O', 'S', 'Z', 'L'],
  canHold: true,
})

const decide = (headers = {}, extra = {}) =>
  request({
    method: 'POST',
    path: '/decide?model=laya',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: position,
    ...extra,
  })

before(async () => {
  port = await freePort()
  const env = { ...process.env, PORT: String(port), TYPESAFE_BASE_URL: CLOSED, LAYA_URL: CLOSED }
  delete env.HOST
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (c) => (output += c))
  child.stderr.on('data', (c) => (output += c))
  for (let i = 0; i < 100; i++) {
    try {
      await request({})
      return
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  throw new Error(`server did not start:\n${output}`)
})

after(() => child?.kill())

test('the game page itself still gets a decision', async () => {
  const res = await decide({ Origin: `http://localhost:${port}` })
  assert.equal(res.status, 200, res.body)
  assert.ok(JSON.parse(res.body).choice, 'a placement comes back (the heuristic fallback here)')
})

test('another website cannot spend decisions (cross-origin POST)', async () => {
  const res = await decide({ Origin: 'https://evil.example' })
  assert.equal(res.status, 403)
})

test('a form-style POST without a JSON content type is refused', async () => {
  // text/plain is what a cross-site <form> or no-cors fetch can send without a preflight.
  const res = await decide({ 'Content-Type': 'text/plain' })
  assert.equal(res.status, 415)
})

test('a DNS-rebound hostname is refused', async () => {
  const res = await request({ host: `rebind.evil.example:${port}` })
  assert.equal(res.status, 403)
  const d = await decide({}, { host: `rebind.evil.example:${port}` })
  assert.equal(d.status, 403)
})

test('a Host header with a path or userinfo is refused', async () => {
  for (const host of [`localhost:${port}/x`, `evil.example@localhost:${port}`, `localhost:${port}?a`]) {
    const res = await request({ host })
    assert.equal(res.status, 403, host)
  }
})

test('loopback names are accepted', async () => {
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost']) {
    const res = await request({ host })
    assert.equal(res.status, 200, host)
  }
})

test('only the two known models are accepted', async () => {
  const res = await decide({}, { path: '/decide?model=constructor' })
  assert.equal(res.status, 400)
})

test('the server is not reachable from other machines by default', (t) => {
  // Read the listening socket from the OS rather than connecting to a LAN
  // address: a local firewall can make that connection time out either way.
  let out
  try {
    out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  } catch {
    return t.skip('lsof is not available')
  }
  assert.match(out, new RegExp(`127\\.0\\.0\\.1:${port}\\b`), out)
  assert.doesNotMatch(out, new RegExp(`(\\*|0\\.0\\.0\\.0|\\[::\\]):${port}\\b`), out)
})

// Last: on the old server this request killed the process.
test('a malformed Host header does not crash the server', async () => {
  const bad = await request({ host: '[' })
  assert.ok(bad.status >= 400 && bad.status < 500, `got ${bad.status}`)
  const after = await request({})
  assert.equal(after.status, 200, 'still serving afterwards')
})
