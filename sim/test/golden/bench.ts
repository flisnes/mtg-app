// The timing baseline for phase G (rebuild plan §5 G0): twenty thousand games
// of the plain 99 and of the credit deck, desktop node. G1-G3 must stay within
// 3% of the number in the kanban card's notes. Five timed runs after a warm-up,
// the median reported, because the first run of anything is the JIT's.
//
//   npx tsx sim/test/golden/bench.ts
import { compileBehavior, sanitizeCardBehavior, type CardBehavior } from '../../../shared/src/behavior.js';
import { buildSimDeck } from '../../src/simDeck.js';
import { DEFAULT_GAMES, defaultSimOptions, simulate, type SimOptions } from '../../src/simulate.js';
import { GOLDEN_DECKS } from './decks.js';

const RUNS = 5;
for (const id of ['plain', 'credit']) {
  const d = GOLDEN_DECKS.find((x) => x.id === id)!;
  const behaviors = new Map<string, CardBehavior>();
  for (const [o, raw] of d.behaviors ?? []) {
    const clean = sanitizeCardBehavior(raw);
    if (!clean || !compileBehavior(clean)) throw new Error(`${d.id}: ${o.name}`);
    behaviors.set(o.oracleId, clean);
  }
  const opts: SimOptions = { ...defaultSimOptions('commander', true), ...d.opts, games: DEFAULT_GAMES };
  const deck = buildSimDeck(d.rows, behaviors, undefined, undefined, undefined, d.goals, opts.maxTurn);
  simulate(deck, { ...opts, games: 2000 });
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    simulate(deck, opts);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`${id.padEnd(8)} ${DEFAULT_GAMES} games: median ${Math.round(times[Math.floor(RUNS / 2)]!)}ms  (min ${Math.round(times[0]!)}, max ${Math.round(times[RUNS - 1]!)})`);
}
