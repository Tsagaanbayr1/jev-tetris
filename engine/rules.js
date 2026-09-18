// Every tunable number for versus play, in one place.
//
// Modelled on TETR.IO's Season 2 versus rules. Main source: Triangle.js
// (github.com/halp1/triangle), an open-source TETR.IO engine written for replay
// parity, plus tetrio.wiki.gg. Values marked UNVERIFIED could not be confirmed
// for ranked play specifically and are the documented defaults.

const F = 1000 / 60 // TETR.IO simulates at 60 frames per second

// --- timing -------------------------------------------------------------------

export const TIMING = {
  lockDelay: 30 * F, // 500 ms
  lockResets: 15, // restarts of lock delay per piece; refilled on a new lowest row
  gravityStart: 0.02, // G = rows per frame
  gravityMargin: 3600 * F, // 60 s of flat gravity...
  gravityIncrease: 0.0025, // ...then +0.0025 G per second (UNVERIFIED for ranked)
  garbageDelay: 20 * F, // 333 ms before received garbage may enter
  garbageMultMargin: 10800 * F, // after 3 minutes attack is scaled up...
  garbageMultIncrease: 0.008, // ...by +0.008 per second
}

// --- attack -------------------------------------------------------------------

/** Lines sent per clear size [0, single, double, triple, quad]. */
export const BASE_ATTACK = {
  none: [0, 0, 1, 2, 4],
  mini: [0, 0, 1, 2, 10], // T-spin minis and all-spins (a spin quad is 10 in the source)
  full: [0, 2, 4, 6, 10], // T-spin single / double / triple
}

export const B2B_BONUS = 1 // flat +1 on a difficult clear while back-to-back
export const ALL_CLEAR = 5 // Season 2 value (was 10 in Season 1)
export const ALL_CLEAR_B2B = 2 // an all clear adds 2 to the B2B chain

/** B2B "surge": breaking a chain of at least this many releases it as attack. */
export const SURGE_AT = 4

/**
 * Combo scaling (TETR.IO "multiplier" table): attack grows 25% per combo step,
 * and from combo 2 on even a zero-attack clear sends ln(1 + 1.25 * combo).
 */
export function comboAttack(base, combo) {
  let atk = base * (1 + 0.25 * Math.max(0, combo))
  if (combo > 1) atk = Math.max(atk, Math.log1p(1.25 * combo))
  return atk
}

// --- garbage ------------------------------------------------------------------

export const GARBAGE = {
  capPerPlacement: 8, // most garbage rows that rise in one lock
  // Each new attack gets a fresh hole column; rows within one attack share it
  // (TETR.IO defaults messiness_change = 1, messiness_inner = 0; UNVERIFIED for ranked).
  messinessChange: 1,
  messinessInner: 0,
}
