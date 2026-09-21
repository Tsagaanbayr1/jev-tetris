// Tune ai/evaluate.js weights by self-play, the way genetic Tetris bots were
// tuned: a (1+1) evolution strategy scales a few weights at a time and keeps the
// change when survival + attack improves on training seeds. Prints the best
// weights; check them on held-out seeds before adopting them.
//
//   node test/tune.js [rounds] [pressure]

import { W } from '../ai/evaluate.js'
import { selfplay } from './selfplay.js'

const ROUNDS = Number(process.argv[2] ?? 40)
const PRESSURE = Number(process.argv[3] ?? 0.25)
const TRAIN = { pieces: 200, seeds: 5, pressure: PRESSURE, from: 1 }

// Scalar weights worth tuning; arrays are scaled as a whole.
const KEYS = ['height', 'topHalf', 'topQuarter', 'cavity', 'overhang', 'covered', 'rowTransitions',
  'bumpiness', 'bumpinessSq', 'wellDepth', 'wellColumn', 'clear', 'tspin', 'tslot', 'cancel', 'lookahead', 'wastedT', 'dangerHeight']

const clone = (o) => JSON.parse(JSON.stringify(o))
const fitness = () => {
  const rows = selfplay(TRAIN)
  const pieces = rows.reduce((a, r) => a + r.pieces, 0)
  const sent = rows.reduce((a, r) => a + r.sent, 0)
  return { fit: pieces + 3 * sent, pieces, sent, deaths: rows.filter((r) => r.dead).length }
}
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random())

let best = clone(W)
let bestF = fitness()
console.log(`start  fit ${bestF.fit}  pieces ${bestF.pieces} sent ${bestF.sent} deaths ${bestF.deaths}`)
for (let r = 1; r <= ROUNDS; r++) {
  const trial = clone(best)
  const n = 2 + Math.floor(Math.random() * 2)
  const changed = []
  for (let i = 0; i < n; i++) {
    const k = KEYS[Math.floor(Math.random() * KEYS.length)]
    const f = Math.exp(0.45 * gauss())
    trial[k] = Array.isArray(trial[k]) ? trial[k].map((v) => Math.round(v * f)) : +(trial[k] * f).toFixed(3)
    changed.push(`${k}x${f.toFixed(2)}`)
  }
  Object.assign(W, clone(trial))
  const f = fitness()
  const ok = f.fit > bestF.fit
  if (ok) {
    best = trial
    bestF = f
  } else Object.assign(W, clone(best))
  console.log(`r${r} ${ok ? 'KEEP' : '    '} fit ${f.fit} (best ${bestF.fit})  deaths ${f.deaths}  ${changed.join(' ')}`)
}
console.log('\nBEST ' + JSON.stringify(best))
