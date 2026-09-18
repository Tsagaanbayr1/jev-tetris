// Seeded PRNG. Both players in a match share a seed so they see the same piece
// sequence, as in online versus; garbage holes use their own stream so the
// piece sequence never depends on how much garbage anyone received.

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31)
}
