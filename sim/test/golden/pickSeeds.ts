// Pick the three seeds per golden deck whose transcripts, between them, show
// the most distinct kinds of line: every card name replaced by <card> and
// every number by #, so "Casts Opt {U}" and "Casts Divination {#}{U}" are one
// shape and a madness cast is its own. Greedy: the seed adding the most new
// shapes wins each round. Run it when a deck is added or changed, paste the
// seeds into decks.ts, then regenerate the snapshots with -u.
//
//   npx tsx sim/test/golden/pickSeeds.ts [deck-id ...]
import { compileBehavior, sanitizeCardBehavior, type CardBehavior } from '../../../shared/src/behavior.js';
import { buildSimDeck } from '../../src/simDeck.js';
import { defaultSimOptions, QUICK_GAMES, traceGame, type SimOptions } from '../../src/simulate.js';
import { GOLDEN_DECKS } from './decks.js';

const SEEDS = 400;
const only = new Set(process.argv.slice(2));

for (const d of GOLDEN_DECKS) {
  if (only.size && !only.has(d.id)) continue;
  const behaviors = new Map<string, CardBehavior>();
  for (const [o, raw] of d.behaviors ?? []) {
    const clean = sanitizeCardBehavior(raw);
    if (!clean || !compileBehavior(clean)) throw new Error(`${d.id}: ${o.name}`);
    behaviors.set(o.oracleId, clean);
  }
  const format = d.opts && 'format' in d.opts ? d.opts.format : 'commander';
  const opts: SimOptions = { ...defaultSimOptions(format, true), games: QUICK_GAMES, ...d.opts };
  const deck = buildSimDeck(d.rows, behaviors, undefined, undefined, undefined, d.goals, opts.maxTurn);
  const names = [...new Set(deck.cards.map((c) => c.name))].sort((a, b) => b.length - a.length);
  const shape = (text: string) => {
    let s = text;
    for (const n of names) s = s.split(n).join('<card>');
    // A list of names is one shape however long it is, and so is the mana line.
    return s
      .replace(/\d+/g, '#')
      .replace(/^# mana untapped:.*$/, '# mana untapped: <sources>')
      .replace(/<card>(, <card>)+/g, '<cards>');
  };
  const shapes = new Map<number, Set<string>>();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = traceGame(deck, opts, seed);
    const set = new Set<string>();
    for (const t of g.turns) for (const l of t.lines) set.add(shape(l.text));
    if (g.mulligans > 0) set.add('<mulligan>');
    shapes.set(seed, set);
  }
  const all = new Set<string>();
  for (const s of shapes.values()) for (const x of s) all.add(x);
  const covered = new Set<string>();
  const picked: number[] = [];
  for (let k = 0; k < 3; k++) {
    let best = 0;
    let bestGain = -1;
    for (const [seed, set] of shapes) {
      if (picked.includes(seed)) continue;
      let gain = 0;
      for (const x of set) if (!covered.has(x)) gain++;
      if (gain > bestGain) {
        bestGain = gain;
        best = seed;
      }
    }
    picked.push(best);
    for (const x of shapes.get(best)!) covered.add(x);
  }
  const missing = [...all].filter((x) => !covered.has(x));
  console.log(`${d.id.padEnd(18)} seeds: [${picked.join(', ')}]  shapes ${covered.size} of ${all.size} seen in ${SEEDS} games`);
  for (const m of missing.slice(0, 15)) console.log(`     not in the three: ${m}`);
  if (missing.length > 15) console.log(`     ... and ${missing.length - 15} more`);
}
