// Laya as a drop-in for Jev: a client for the local sidecar (ai/laya_server.py)
// and a compact encoding of the battle question that fits Laya's input budget.
//
// WHY A SEPARATE ENCODING. Laya reads one sequence per question:
//   [CLS] instructions [SEP] [MASK] option ... [MASK] option [SEP] state [SEP]
// with instructions + options capped at 256 tokens and the whole thing at 1024.
// Jev's battle payload (ai/battle.js) measures 442 tokens of instructions, 285
// of options and 1602 of state: sent as-is, the objective is cut to ~8 tokens and
// half the candidate facts fall off the end. So for Laya:
//   - fewer options (LAYA_K), still including the best attack and a hold option;
//   - each option carries its own measured facts, right next to its [MASK],
//     because the option text is where Laya scores it;
//   - a short objective, and no ASCII board (Jev couldn't read it either).

import http from 'node:http'

const LAYA_K = 8

const OBJECTIVE =
  'Versus Tetris: pick the best placement. Survive first; never create holes; ' +
  'prefer big attacks (sent) over wasting rows on small clears; keep a well for quads.'

/** Short, fact-bearing option text: what Laya actually scores. */
function optionText(c) {
  const parts = [
    `${c.useHold ? 'hold ' : ''}${c.type}`,
    `sent ${c.sent}`,
    `holes +${Math.max(0, c.holesCreated)}`,
    `height ${c.maxHeight}`,
    `bump ${c.bumpiness}`,
    `well ${c.well}`,
  ]
  if (c.lines) parts.push(`clears ${c.lines}`)
  if (c.spin !== 'none') parts.push('spin')
  if (c.wastesStack) parts.push('wastes stack')
  return parts.join(', ')
}

/** Trim the shortlist to LAYA_K, keeping the strongest attack and one hold option. */
function trim(candidates) {
  const keep = candidates.slice(0, LAYA_K)
  const must = [
    [...candidates].sort((a, b) => b.sent - a.sent).find((c) => c.sent > 0),
    candidates.find((c) => c.useHold),
  ]
  let slot = keep.length - 1 // overwrite the weakest, one slot each
  for (const c of must) {
    if (c && !keep.includes(c)) keep[slot--] = c
  }
  return keep
}

export function buildLayaDecision(pos, candidates) {
  const shown = trim(candidates)
  const criteria = {}
  for (const c of shown) criteria[c.id] = optionText(c)
  const state = {
    piece: pos.current.type,
    hold: pos.hold ?? 'empty',
    next: pos.queue.slice(0, 5).join(' '),
    incoming_garbage: pos.incoming ?? 0,
    combo: Math.max(0, pos.combo + 1),
    b2b: Math.max(0, pos.b2b),
    ...(pos.opponent ? { opponent_height: pos.opponent.maxHeight } : {}),
  }
  return {
    candidates: shown,
    state,
    questions: { placement: { type: 'choice', instructions: OBJECTIVE, criteria } },
  }
}

// Plain HTTP with keep-alive: the sidecar is on loopback, so there is no TLS to amortise.
const agent = new http.Agent({ keepAlive: true, maxSockets: 4 })

export class LayaClient {
  constructor({ baseUrl } = {}) {
    this.baseUrl = baseUrl ?? process.env.LAYA_URL ?? 'http://127.0.0.1:8090'
    this.model = 'laya-multilingual'
    this.inFlight = 0
    this.latencies = []
  }

  get busy() {
    return this.inFlight > 0
  }

  /** Same contract as JevClient.ask: resolves { answers, latencyMs, usage }. */
  ask(state, questions, { timeoutMs = 6_000 } = {}) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ state, questions }))
      const url = new URL('/v1/systemone', this.baseUrl)
      const started = Date.now()
      this.inFlight++
      let settled = false
      const finish = (fn) => {
        if (settled) return
        settled = true
        this.inFlight--
        fn()
      }
      const req = http.request(
        {
          agent, hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const latencyMs = Date.now() - started
            let json = null
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              /* reported below */
            }
            if (res.statusCode === 200 && json) {
              this.latencies.push(latencyMs)
              return finish(() => resolve({ ...json, latencyMs }))
            }
            finish(() => reject(new Error(`Laya HTTP ${res.statusCode}: ${json?.detail ?? 'bad response'}`)))
          })
        }
      )
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Laya timed out after ${timeoutMs}ms`)))
      req.on('error', (err) => {
        const msg = err.code === 'ECONNREFUSED'
          ? `Laya sidecar not running at ${this.baseUrl} (start: python ai/laya_server.py)`
          : err.message
        finish(() => reject(new Error(msg)))
      })
      req.end(body)
    })
  }

  stats() {
    if (!this.latencies.length) return { n: 0, p50: 0, p90: 0, min: 0, max: 0 }
    const s = [...this.latencies].sort((a, b) => a - b)
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
    return { n: s.length, p50: at(0.5), p90: at(0.9), min: s[0], max: s[s.length - 1] }
  }
}
