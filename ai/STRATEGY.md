# Versus strategy, compacted

What published Tetris bots and top players agree on, reduced to what these bots
use. `ai/evaluate.js` implements the numbers; the objectives in `ai/battle.js`
(Jev) and `ai/laya.js` (Laya) state the rules in words.

## Rules (priority order)

1. **Survive.** Keep the stack low: height above half the board is punished
   hard, above three quarters much harder. Defense = attack + lines cleared —
   every line you send first cancels garbage waiting to rise.
2. **No holes.** A covered hole costs more than almost any clear gains (Cold
   Clear: a hole −173 vs a quad +390). Never stack more blocks over a hole;
   stack flat over garbage so the next garbage hole stays open.
3. **Attack in bulk.** Quads and T-spin doubles are the attack; a single sends
   nothing and a double one line, so as clears they are *penalised* while the
   board is safe. Keep back-to-back chains alive (each keeps adding +1).
4. **Keep one well** (a column ~4 deep, best away from the wall's corner) for
   the next I; build T-spin double slots (a 3-wide gap with an overhang on one
   side) for the next T. Don't spend a T without a T-spin.
5. **Think one piece ahead.** A placement is only as good as the best place
   for the next piece afterwards.
6. **Finish.** When the opponent's stack is high, any attack may end it.

## Sources

| Source | What it contributes |
| --- | --- |
| [Cold Clear](https://github.com/MinusKelvin/cold-clear) `bot/src/evaluation/standard.rs` | The board + move weights (cavities, overhangs, covered cells, height bands, bumpiness around the well, well column bonus, T-slots, clear-type table, B2B, combo, wasted T) |
| [El-Tetris](https://imake.ninja/el-tetris-an-improvement-on-pierre-dellacheries-algorithm/) (Dellacherie) | Row/column transitions and wells as board-quality signals |
| [Yiyuan Lee, "Near perfect bot"](https://codemyroad.wordpress.com/2013/04/14/tetris-ai-the-near-perfect-player/) | One-piece lookahead; tuning weights by self-play (genetic algorithm) |
| [TETRIS-FAQ: versus](https://winternebs.github.io/TETRIS-FAQ/versus/) | Defend = attack + lines cleared; prioritise B2B T-spins and quads; keep the stack low; singles are not an attack |
| [Hard Drop: downstacking guide](https://harddrop.com/wiki/Anonymous's_Downstacking_Guide) | Stack flat over garbage, keep the next hole accessible, don't bury holes |
| [Hard Drop: T-spin guide](https://harddrop.com/wiki/T-Spin_Guide) | T-spin double slot shape; save the T for the slot |
| [MisaMino](https://tetris.wiki/MisaMino) / [Zetris](https://github.com/ZetrisAI/Zetris) | Search width over placements matters: evaluate many, keep the best few |

## How the bots use it

- **Shortlist (both models):** every reachable placement (spins, hold) is scored
  by `ai/evaluate.js`; the top 12 are re-scored with one piece of lookahead.
  Weights start from Cold Clear's and are re-tuned by self-play for this
  engine and this shallow search (`test/tune.js`, checked on held-out seeds with
  `test/selfplay.js`): holes cost more (−269), the clear table is doubled
  (quad +771, single −283), T-spins are worth less (a one-piece search rarely
  sets them up), and the lookahead weighs 1.43.
- **Jev** sees the shortlist with measured facts, including each option's
  `strategy_rank`, and the rules above as its objective.
- **Laya** is near-uniform over its options and cannot use rank text (it made it
  worse), so the evaluation reaches it as a prior multiplied into its own
  probabilities (`combineWithPrior` in `ai/laya.js`).
