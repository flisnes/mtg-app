import { describe, expect, test } from 'vitest';
// Rebuild plan §5 G0: the golden traces.
//
// G1-G3 restructure simulate() and have to prove they changed nothing. The
// other suites check numbers at a few turns, which is enough to catch a rule
// that stopped firing and not enough to catch a shuffle that moved by one
// slot. This is the byte-for-byte gate: for every deck in golden/decks.ts, the
// full SimResult of two thousand games and three complete game transcripts,
// committed under golden/ and compared on every run.
//
//   npx vitest run sim/test/golden.test.ts        compare
//   npx vitest run sim/test/golden.test.ts -u     accept a deliberate change
//
// A diff here is either a bug or a change in behavior, and either way it is
// the thing to read before the numbers. A refactor that is meant to change
// nothing must leave every file untouched.
import { readFileSync } from 'node:fs';
import { compileBehavior, sanitizeCardBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import { buildSimDeck, type SimDeck } from '../src/simDeck.js';
import { defaultSimOptions, QUICK_GAMES, simulate, traceGame, type SimOptions } from '../src/simulate.js';
import { GOLDEN_DECKS, type GoldenDeck } from './golden/decks.js';
import { renderTrace, stableJson } from './golden/render.js';

const build = (d: GoldenDeck): { deck: SimDeck; opts: SimOptions } => {
  const behaviors = new Map<string, CardBehavior>();
  for (const [o, raw] of d.behaviors ?? []) {
    // The app sanitizes before it builds, so the golden runs what a saved
    // rule becomes. A rule that does not survive is a typo in the deck set,
    // and a typo that silently compiled to nothing would snapshot nothing.
    const clean = sanitizeCardBehavior(raw);
    if (!clean || !compileBehavior(clean)) throw new Error(`${d.id}: the rule on ${o.name} does not survive sanitizing`);
    behaviors.set(o.oracleId, clean);
  }
  const format = d.opts && 'format' in d.opts ? d.opts.format : 'commander';
  const opts: SimOptions = { ...defaultSimOptions(format, true), games: QUICK_GAMES, ...d.opts };
  return { deck: buildSimDeck(d.rows, behaviors, undefined, undefined, undefined, d.goals, opts.maxTurn), opts };
};

test('every golden deck has its own id and the seeds differ', () => {
  const ids = GOLDEN_DECKS.map((d) => d.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const d of GOLDEN_DECKS) expect(new Set(d.seeds).size).toBe(3);
});

describe.each(GOLDEN_DECKS)('$id', (d) => {
  const { deck, opts } = build(d);

  test(`result of ${QUICK_GAMES} games is byte-identical`, async () => {
    const r = simulate(deck, opts);
    const text = `// ${d.note}\n${stableJson(r)}\n`;
    await expect(text).toMatchFileSnapshot(`golden/${d.id}.result.jsonc`);
  });

  test('three traced games are byte-identical', async () => {
    const games = d.seeds.map((seed) => renderTrace(deck, traceGame(deck, opts, seed)));
    await expect(`${d.note}\n\n${games.join('\n\n')}\n`).toMatchFileSnapshot(`golden/${d.id}.trace.txt`);
  });
});

test('the committed snapshots were made by this deck set', () => {
  // A deck edited after its snapshot was written would still "pass" with -u.
  // The note at the top of each file is the deck's own, so a renamed or
  // reworded deck without a fresh snapshot fails here before it fails above.
  for (const d of GOLDEN_DECKS) {
    const head = readFileSync(new URL(`./golden/${d.id}.trace.txt`, import.meta.url), 'utf8').split('\n')[0];
    expect(head, `${d.id}: snapshot note`).toBe(d.note);
  }
});
