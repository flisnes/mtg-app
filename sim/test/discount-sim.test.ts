import { expect, test } from 'vitest';
// Rebuild plan §6 step 8: cost reduction. A static `discount` rule takes
// generic mana off the spells it names while its card is out; printed
// affinity does the same per matching permanent. Decks are built so the answer
// can be read off the trace: lands, one spell kind, and the reducer in the
// command zone.
//
//   npx vitest run sim/test/discount-sim.test.ts
import { MANA_TAPPED, type OracleCard } from '../../shared/src/card.js';
import type { CardBehavior } from '../../shared/src/behavior.js';
import { buildSimDeck, printedAffinity, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, traceGame, type SimOptions } from '../src/simulate.js';

let seq = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${seq++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{R}',
    oracleText: o.oracleText ?? null,
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;
const land = (name: string, color: string, adds = 1, tapped = false, typeLine = 'Land') =>
  card({ name, typeLine, cmc: 0, manaCost: '', produces: color, mana: [0, adds, tapped ? MANA_TAPPED : 0] });
const MOUNTAIN = land('Mountain', 'R', 1, false, 'Basic Land — Mountain');
/** A {3}{R} burn spell. Written out as a rule so the trace shows it resolving. */
const BOLT4 = card({ name: 'Big Bolt', typeLine: 'Instant', manaCost: '{3}{R}', cmc: 4 });
const BEAR4 = card({ name: 'Big Bear', typeLine: 'Creature — Bear', manaCost: '{3}{R}', cmc: 4, power: '4', toughness: '4' });

const base: SimOptions = { ...defaultSimOptions('commander', true), games: 2000, mulligan: false, combat: 'all' };
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
const run = (rows: DeckRow[], behaviors?: Map<string, CardBehavior>, opts: Partial<SimOptions> = {}) => simulate(buildSimDeck(rows, behaviors), { ...base, ...opts });
const lines = (rows: DeckRow[], behaviors: Map<string, CardBehavior> | undefined, seed: number) =>
  traceGame(buildSimDeck(rows, behaviors), { ...base, trace: true }, seed).turns.flatMap((t) => t.lines.map((l) => ({ turn: t.turn, text: l.text })));

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
console.log('\n=== a Medallion: {1} off every instant and sorcery ===');
{
  // Mountains and {3}{R} bolts. A {2} Electromancer in the command zone that
  // makes instants and sorceries cost {1} less: with 4 Mountains out, two
  // bolts a turn become affordable where one was.
  const MANCER = card({ name: 'Electromancer', typeLine: 'Creature — Goblin', manaCost: '{R}{R}', cmc: 2, power: '2', toughness: '2' });
  const rules = new Map<string, CardBehavior>([
    [MANCER.oracleId, { v: 1, rules: [{ on: 'static', steps: [{ op: 'discount', x: { kind: 'fixed', n: 1 }, q: 't:instant or t:sorcery' }] }] }],
  ]);
  const deck = [main(50, MOUNTAIN), main(49, BOLT4), cmd(MANCER)];
  const trace = lines(deck, rules, 4);
  const mancerTurn = trace.find((l) => l.text.startsWith('Casts Electromancer'))?.turn ?? 99;
  const casts = trace.filter((l) => l.turn > mancerTurn && l.text.startsWith('Casts Big Bolt'));
  check(casts.length > 0 && casts.every((l) => / for 1 less/.test(l.text)), `every bolt after the Electromancer lands says "for 1 less" (${casts.length} casts)`);
  const before = trace.filter((l) => l.turn <= mancerTurn && l.text.startsWith('Casts Big Bolt'));
  check(before.every((l) => !/ less/.test(l.text)), `and none before it does (${before.length} casts)`);
  // Spent mana per turn rises against the same deck with a vanilla 2/2 commander.
  const PLAIN = card({ name: 'Goblin', typeLine: 'Creature — Goblin', manaCost: '{R}{R}', cmc: 2, power: '2', toughness: '2' });
  const cheap = run(deck, rules);
  const dear = run([main(50, MOUNTAIN), main(49, BOLT4), cmd(PLAIN)]);
  const castsCheap = cheap.cards.find((c) => c.name === 'Big Bolt');
  const castsDear = dear.cards.find((c) => c.name === 'Big Bolt');
  check(!!castsCheap && !!castsDear && castsCheap.onCurvePay > castsDear.onCurvePay, `the bolt is castable on curve more often: ${castsCheap?.onCurvePay.toFixed(3)} vs ${castsDear?.onCurvePay.toFixed(3)}`);
  // The discount names instants and sorceries: a creature spell pays full price.
  const creatures = lines([main(50, MOUNTAIN), main(49, BEAR4), cmd(MANCER)], rules, 4).filter((l) => l.text.startsWith('Casts Big Bear'));
  check(creatures.length > 0 && creatures.every((l) => !/ less/.test(l.text)), `a creature spell is not discounted (${creatures.length} casts)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== a discount reads the game: Animar ===');
{
  // Creature spells cost {1} less for each +1/+1 counter on it, and casting
  // a creature puts one on. Written as two rules.
  const ANIMAR = card({ name: 'Animar', typeLine: 'Legendary Creature — Elemental', manaCost: '{U}{R}{G}', cmc: 3, power: '1', toughness: '1' });
  const rules = new Map<string, CardBehavior>([
    [
      ANIMAR.oracleId,
      {
        v: 1,
        rules: [
          { on: 'cast', q: 't:creature', steps: [{ op: 'counter', x: { kind: 'fixed', n: 1 }, ck: 'p1p1' }] },
          { on: 'static', steps: [{ op: 'discount', x: { kind: 'counters' }, q: 't:creature' }] },
        ],
      },
    ],
  ]);
  const ANY = land('Command Tower', 'URG', 1, false, 'Land');
  const trace = lines([main(50, ANY), main(49, BEAR4), cmd(ANIMAR)], rules, 11);
  const casts = trace.filter((l) => l.text.startsWith('Casts Big Bear'));
  const less = casts.map((l) => Number(/for (\d+) less/.exec(l.text)?.[1] ?? 0));
  // The k-th bear after Animar is k-1 cheaper (capped at the {3} generic).
  const animarTurn = trace.find((l) => l.text.startsWith('Casts Animar'))?.turn ?? 99;
  const after = casts.filter((l) => l.turn > animarTurn).map((l) => Number(/for (\d+) less/.exec(l.text)?.[1] ?? 0));
  const expected = after.map((_v, k) => Math.min(3, k));
  check(after.length >= 3 && after.every((v, k) => v === expected[k]), `bears after Animar cost ${after.join(', ')} less (expected ${expected.join(', ')})`);
  void less;
}

// ---------------------------------------------------------------------------
console.log('\n=== printed affinity ===');
{
  check(printedAffinity('Affinity for artifacts (This spell costs {1} less to cast for each artifact you control.)\nFlying') === 't:artifact', 'Affinity for artifacts');
  check(printedAffinity('Affinity for Plains') === 't:plains', 'Affinity for Plains');
  check(printedAffinity('Whenever you cast a spell with affinity for artifacts, draw a card.') === null, 'a sentence about affinity is not the keyword');
  // Rocks and a {7} Frogmite-shaped artifact: with k rocks out it costs 7 - k.
  const ROCK = card({ name: 'Rock', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, produces: 'C', mana: [1, 1, 0] });
  const MYR = card({ name: 'Myr Enforcer', typeLine: 'Artifact Creature — Myr', manaCost: '{7}', cmc: 7, power: '4', toughness: '4', oracleText: 'Affinity for artifacts (This spell costs {1} less to cast for each artifact you control.)' });
  const deck = buildSimDeck([main(40, MOUNTAIN), main(30, ROCK), main(29, MYR)]);
  check(deck.cards.find((c) => c.name === 'Myr Enforcer')?.affinity === 't:artifact', 'the deck reads the Myr\'s affinity');
  const trace = traceGame(deck, { ...base, trace: true }, 9);
  let ok = 0;
  let seen = 0;
  for (const t of trace.turns) {
    // Rocks out at the end of the turn, minus the ones cast this turn after the Myr: the trace is checked loosely, the "for N less" has to be between 0 and the artifacts on the board.
    const rocks = t.board.permanents.filter((p) => deck.cards[p.card]!.name === 'Rock').reduce((s, p) => s + p.count, 0);
    const myrs = t.board.permanents.filter((p) => deck.cards[p.card]!.name === 'Myr Enforcer').reduce((s, p) => s + p.count, 0);
    for (const l of t.lines) {
      const m = /^Casts Myr Enforcer(?: \{7\})?(?: for (\d+) less)?/.exec(l.text);
      if (!m) continue;
      seen++;
      const less = Number(m[1] ?? 0);
      if (less <= rocks + myrs && less >= 0) ok++;
    }
  }
  check(seen > 0 && ok === seen, `every Myr cast is discounted by at most the artifacts out (${ok} of ${seen})`);
  const cheap = simulate(deck, base);
  const myr = cheap.cards.find((c) => c.name === 'Myr Enforcer');
  check(!!myr && myr.onCurvePay > 0.3, `a {7} Myr is castable on curve in ${((myr?.onCurvePay ?? 0) * 100).toFixed(0)}% of games with rocks out`);
}

// ---------------------------------------------------------------------------
console.log('\n=== nothing else moves ===');
{
  const plain = run([main(50, MOUNTAIN), main(49, BOLT4)]);
  check(Math.abs(plain.manaByTurn[6]! - 5.75) < 0.6, `mana on turn 6 ${plain.manaByTurn[6]!.toFixed(2)}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('discount-sim: every check passes', () => {
  expect(failures).toBe(0);
});
