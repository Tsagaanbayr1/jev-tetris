// Playback pacing: what the bot's piece is seen doing between two decisions.
//
// The bot never assigns a position — it plays inputs, and the renderer draws
// whatever the game is in at the end of each frame. These tests pin the two
// things that would turn that back into a teleport: spending a whole route in
// one frame, and snapping to the floor instead of falling there.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Game } from '../engine/engine.js'
import { JevBot } from '../public/bot.js'
import { ROWS } from '../engine/pieces.js'

const FRAME = 1000 / 60 // the browser's animation frame

/**
 * A bot parked mid-route: state and token are set by hand so update() plays the
 * action list back instead of asking the server about the piece.
 */
function actingBot(options) {
  const game = new Game({ seed: 7 })
  const bot = new JevBot(game, options)
  bot.state = 'acting'
  bot.token = game.stats.pieces
  return { game, bot }
}

test('superhuman spends one input a frame, not the whole route at once', () => {
  const { game, bot } = actingBot({ pps: 0, superhuman: true })
  bot.actions = ['left', 'left', 'left', 'fall']
  const x0 = game.current.x

  bot.update(FRAME, 0)
  assert.equal(game.current.x, x0 - 1, 'exactly one input in the first frame')

  bot.update(FRAME, FRAME)
  assert.equal(game.current.x, x0 - 2, 'and exactly one in the second')

  assert.deepEqual(bot.actions, ['left', 'fall'], 'the rest of the route is still queued')
})

test('a paced bot still waits its step between inputs', () => {
  const { game, bot } = actingBot({ pps: 1.2 })
  bot.actions = ['left', 'left', 'fall']
  bot.stepTimer = 40 // as _ask sets it: the first input goes out immediately
  const x0 = game.current.x

  bot.update(FRAME, 0)
  assert.equal(game.current.x, x0 - 1)
  bot.update(FRAME, FRAME)
  assert.equal(game.current.x, x0 - 1, 'the next input is 40 ms away, not a frame away')
})

test('superhuman falls home over several frames instead of teleporting', () => {
  const { game, bot } = actingBot({ pps: 0, superhuman: true })
  bot.actions = ['fall']
  const ghost = game.ghostY()
  const start = game.current.y
  assert.ok(ghost > start, 'the piece has room to fall')

  let frames = 0
  const seen = []
  while (bot.state === 'acting' && frames < 200) {
    bot.update(FRAME, frames * FRAME)
    game.update(FRAME)
    if (game.current) seen.push(game.current.y)
    frames++
  }

  assert.equal(bot.state, 'idle', 'the piece landed and locked')
  assert.ok(frames > 2, `landed in ${frames} frames: too fast to read as a fall`)
  assert.ok(frames < 40, `landed in ${frames} frames: not the fast descent we asked for`)
  assert.ok(seen.length > 2 && seen[1] > start, 'intermediate rows were drawn on the way down')
  assert.ok(ROWS > ghost, 'the target row was inside the board')
})

test('the paced terminal is still a hard drop; superhuman falls instead', () => {
  const paced = actingBot({ pps: 1.2 })
  assert.equal(paced.bot._terminal(), 'hard')
  const rush = actingBot({ pps: 0, superhuman: true })
  assert.equal(rush.bot._terminal(), 'fall')
})

test('superhuman clears the last piece\'s drop speed for the next one', async () => {
  const { game, bot } = actingBot({ pps: 0, superhuman: true })
  bot.actions = ['fall']
  bot.update(FRAME, 0)
  assert.ok(game.softDropG > 0, 'falling')
  bot.stopped = true // stand in for the match ending: no request is made
  bot.state = 'idle'
  bot.actions = []
  await bot._ask(0)
  assert.equal(game.softDropG, 0, 'a fresh piece falls at gravity')
})
