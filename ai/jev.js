// TypeSafe /v1/systemone client.
//
// CRITICAL: this uses a pooled keep-alive HTTPS agent. Measured earlier in this
// project, a fresh connection per request costs ~0.78s (0.435s of it TLS), while
// a reused connection costs ~0.30s. If you ever see decisions creeping back
// toward 0.78s, the agent is not being reused.

import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Load TYPESAFE_* from the nearest .env, without a dotenv dependency. */
export function loadEnv() {
  if (process.env.TYPESAFE_API_KEY) return
  const candidates = [
    path.resolve(__dirname, '../../.env'), // repo root
    path.resolve(__dirname, '../.env'),
    path.resolve(process.cwd(), '.env'),
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
    return
  }
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30_000 })

export class JevClient {
  constructor({ apiKey, baseUrl, model = 'jev-latest' } = {}) {
    loadEnv()
    this.apiKey = apiKey ?? process.env.TYPESAFE_API_KEY
    this.baseUrl = baseUrl ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai'
    this.model = model
    if (!this.apiKey) throw new Error('no API key: set TYPESAFE_API_KEY or add it to .env')
    this.inFlight = 0
    this.latencies = []
  }

  /** True while a request is outstanding — the caller uses this to avoid piling up. */
  get busy() {
    return this.inFlight > 0
  }

  /**
   * One decision. Returns { answers, latencyMs, usage }.
   * Retries 429/529/5xx with a short backoff.
   */
  async ask(state, questions, { timeoutMs = 20_000, retries = 2 } = {}) {
    const payload = { state, model: this.model, questions }
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._request(payload, timeoutMs)
      } catch (err) {
        lastErr = err
        if (!err.retryable || attempt === retries) throw err
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
      }
    }
    throw lastErr
  }

  _request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify(payload))
      const url = new URL('/v1/systemone', this.baseUrl)
      const started = Date.now()
      let settled = false

      this.inFlight++

      const finish = (fn) => {
        if (settled) return
        settled = true
        this.inFlight--
        fn()
      }

      const req = https.request(
        {
          agent,
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const latencyMs = Date.now() - started
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = JSON.parse(text)
            } catch {
              /* fall through to the error path */
            }

            if (res.statusCode >= 200 && res.statusCode < 300 && json) {
              this.latencies.push(latencyMs)
              return finish(() => resolve({ ...json, latencyMs }))
            }

            const detail = json?.detail
            const msg =
              (typeof detail === 'string' ? detail : detail?.message) ??
              text.slice(0, 200)
            const e = new Error(`HTTP ${res.statusCode}: ${msg}`)
            e.status = res.statusCode
            e.retryable =
              res.statusCode === 429 || res.statusCode === 529 || res.statusCode >= 500
            finish(() => reject(e))
          })
        }
      )

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`))
      })

      req.on('error', (err) => {
        err.retryable = true
        finish(() => reject(err))
      })

      req.write(body)
      req.end()
    })
  }

  /** p50/p90 of every successful request so far. */
  stats() {
    if (!this.latencies.length) return { n: 0, p50: 0, p90: 0, min: 0, max: 0 }
    const s = [...this.latencies].sort((a, b) => a - b)
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))]
    return {
      n: s.length,
      p50: at(0.5),
      p90: at(0.9),
      min: s[0],
      max: s[s.length - 1],
    }
  }
}
