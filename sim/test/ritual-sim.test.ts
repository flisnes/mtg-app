import { expect, test } from 'vitest';
// Rituals and the mana pool: does burst mana reach the spend loop, does it stop
// reaching it at the end of the turn, and does the sequencer refuse to throw a
// ritual away when there is nothing to burst into?
//
// Synthetic cards for the same reason effect-sim.ts uses them: a Dark Ritual in
// a real decklist is one card among ninety-eight and the arithmetic is not
// checkable by hand. Run with:
//   npx tsx notes/checks/ritual-sim.ts
import { MANA_KINDS, MANA_ONE_SHOT, MANA_UNKNOWN, type OracleCard } from '../../shared/src/card.js';
import type { CardBehavior } from '../../shared/src/behavior.js';
import { buildSimDeck, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate } from '../src/simulate.js';
import { newTraceSink } from '../src/trace.js';

let n = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${n++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{B}',
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;

const RITUAL_KIND = MANA_KINDS.indexOf('ritual');

const SWAMP = card({ name: 'Swamp', typeLine: 'Basic Land — Swamp', cmc: 0, manaCost: '', produces: 'B', mana: [0, 1, 0] });
/** {B}: add {B}{B}{B}. The card the whole feature is named after. */
const DARK_RITUAL = card({
  name: 'Dark Ritual',
  manaCost: '{B}',
  cmc: 1,
  produces: 'B',
  mana: [RITUAL_KIND, 3, MANA_ONE_SHOT],
});
/** The control: same cost, same slot, does nothing. */
const ONE_BLANK = card({ name: 'Blank One-Drop', manaCost: '{B}', cmc: 1 });
const FOUR_DROP = card({ name: 'Four Drop', manaCost: '{3}{B}', cmc: 4 });
const TWO_DROP = card({ name: 'Two Drop', manaCost: '{1}{B}', cmc: 2 });

const GAMES = 8000;
const opts = { ...defaultSimOptions('commander', true), games: GAMES };

const run = (rows: DeckRow[], behaviors?: Map<string, CardBehavior>) => {
  const deck = buildSimDeck(rows, behaviors);
  return { deck, r: simulate(deck, opts) };
};

const line = (label: string, xs: readonly number[]) =>
  `${label.padEnd(24)} ${xs.slice(1, 8).map((v) => v.toFixed(3)).join('  ')}`;

const byName = <T extends { name: string }>(cards: readonly T[], name: string): T | undefined => cards.find((c) => c.name === name);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

/** The trajectory chart's right-hand labels assume the two lines cannot cross. */
const neverCrosses = (label: string, r: { manaByTurn: number[]; manaSpentByTurn: number[] }) => {
  for (let t = 1; t <= 7; t++) {
    const a = r.manaByTurn[t] ?? 0;
    const s = r.manaSpentByTurn[t] ?? 0;
    if (s > a + 1e-9) {
      check(false, `${label}: turn ${t} spent ${s.toFixed(3)} > available ${a.toFixed(3)}`);
      return;
    }
  }
  check(true, `${label}: spent never exceeds available`);
};

// ---------------------------------------------------------------------------
// 1. The burst reaches the spell it is for
// ---------------------------------------------------------------------------
// Twenty-four Swamps, twelve one-drops and twenty-four four-drops. The only
// difference between the two decks is whether the one-drop makes mana.

const deckWith = (oneDrop: OracleCard): DeckRow[] => [
  { quantity: 24, board: 'main', oracle: SWAMP },
  { quantity: 12, board: 'main', oracle: oneDrop },
  { quantity: 24, board: 'main', oracle: FOUR_DROP },
];

const ritual = run(deckWith(DARK_RITUAL));
const control = run(deckWith(ONE_BLANK));

console.log('=== Dark Ritual vs a blank one-drop, into a deck of four-drops ===');
console.log(`coverage (ritual):  ${JSON.stringify(ritual.deck.coverage)}`);
console.log(`coverage (control): ${JSON.stringify(control.deck.coverage)}`);
console.log(line('mana  control', control.r.manaByTurn));
console.log(line('mana  ritual', ritual.r.manaByTurn));
console.log(line('spent control', control.r.manaSpentByTurn));
console.log(line('spent ritual', ritual.r.manaSpentByTurn));

const four = byName(ritual.r.cards, 'Four Drop')!;
const fourControl = byName(control.r.cards, 'Four Drop')!;
console.log(line('4-drop pay  control', fourControl.payByTurn));
console.log(line('4-drop pay  ritual', four.payByTurn));
console.log(line('4-drop cast control', fourControl.castByTurn));
console.log(line('4-drop cast ritual', four.castByTurn));

check(
  (four.payByTurn[3] ?? 0) > (fourControl.payByTurn[3] ?? 0) + 0.02,
  `turn 3: the four-drop is payable more often with rituals (${(four.payByTurn[3] ?? 0).toFixed(3)} vs ${(fourControl.payByTurn[3] ?? 0).toFixed(3)})`,
);
// Per turn is the wrong axis: the ritual deck empties its hand two turns early
// and then has a quiet turn three. Over the whole game is the question.
const total = (xs: readonly number[]) => xs.slice(1, 8).reduce((a, b) => a + b, 0);
check(
  total(ritual.r.manaSpentByTurn) > total(control.r.manaSpentByTurn) + 0.5,
  `over seven turns, more mana goes into spells (${total(ritual.r.manaSpentByTurn).toFixed(2)} vs ${total(control.r.manaSpentByTurn).toFixed(2)})`,
);
neverCrosses('ritual deck', ritual.r);
neverCrosses('control deck', control.r);

// ---------------------------------------------------------------------------
// 2. A ritual with nothing to burst into is never cast
// ---------------------------------------------------------------------------
// Same twelve Dark Rituals, but the rest of the deck is two-drops. A turn with
// two lands up already casts a two-drop, so the burst buys nothing and the card
// stays in hand. If the gate is broken this deck's mana line jumps.

const cheap = (oneDrop: OracleCard): DeckRow[] => [
  { quantity: 24, board: 'main', oracle: SWAMP },
  { quantity: 12, board: 'main', oracle: oneDrop },
  { quantity: 24, board: 'main', oracle: TWO_DROP },
];
const cheapRitual = run(cheap(DARK_RITUAL));
const cheapControl = run(cheap(ONE_BLANK));

console.log('\n=== Dark Ritual with nothing above two mana to cast ===');
console.log(line('mana  control', cheapControl.r.manaByTurn));
console.log(line('mana  ritual', cheapRitual.r.manaByTurn));

// Not identical: the blank one-drop gets cast and the ritual does not, which
// changes what else the turn does with its mana. What must not happen is the
// ritual line running away with free mana it had no use for.
for (let t = 1; t <= 7; t++) {
  const a = cheapRitual.r.manaByTurn[t] ?? 0;
  const b = cheapControl.r.manaByTurn[t] ?? 0;
  if (a > b + 0.25) {
    check(false, `turn ${t}: ritual deck has ${a.toFixed(3)} mana against the control's ${b.toFixed(3)}`);
    break;
  }
  if (t === 7) check(true, 'the burst is not made when nothing needs it');
}
neverCrosses('cheap ritual deck', cheapRitual.r);

// ---------------------------------------------------------------------------
// 2b. A ritual that is not up on the deal does not jump the queue
// ---------------------------------------------------------------------------
// Jeska's Will reads as a ritual with an amount we could not count, so `adds`
// is a floor of one against a cost of three. It is still a ritual and its mana
// still lands in the pool; what it must not do is rank as ramp and get cast
// ahead of everything because some other card's burst has a target.

const FLOORED = card({
  name: 'Floored Ritual',
  manaCost: '{2}{B}',
  cmc: 3,
  produces: 'B',
  mana: [RITUAL_KIND, 1, MANA_ONE_SHOT | MANA_UNKNOWN],
});
const flooredDeck: DeckRow[] = [
  { quantity: 24, board: 'main', oracle: SWAMP },
  { quantity: 12, board: 'main', oracle: FLOORED },
  { quantity: 24, board: 'main', oracle: FOUR_DROP },
];
const floored = run(flooredDeck);
console.log('\n=== a ritual whose amount is a floor of one ===');
console.log(line('mana  no ritual', control.r.manaByTurn));
console.log(line('mana  floored', floored.r.manaByTurn));
// Three mana in, one mana out: it must not make the deck look richer than the
// control, which holds a blank in the same slot.
check(
  (floored.r.manaByTurn[4] ?? 0) < (control.r.manaByTurn[4] ?? 0) + 0.3,
  `turn 4: a net-negative ritual buys no mana (${(floored.r.manaByTurn[4] ?? 0).toFixed(3)} vs ${(control.r.manaByTurn[4] ?? 0).toFixed(3)})`,
);
neverCrosses('floored ritual deck', floored.r);

// ---------------------------------------------------------------------------
// 3. The pool empties
// ---------------------------------------------------------------------------
// A landfall trigger that adds one mana, written in the grammar, against the
// same trigger making a Treasure. A Treasure keeps, so by turn six the Treasure
// deck must be strictly ahead; if the pool never emptied the two would track.

const COBRA = card({ name: 'Lotus Cobra', typeLine: 'Creature — Snake', manaCost: '{1}{B}', cmc: 2 });
const cobraDeck: DeckRow[] = [
  { quantity: 24, board: 'main', oracle: SWAMP },
  { quantity: 12, board: 'main', oracle: COBRA },
  { quantity: 24, board: 'main', oracle: FOUR_DROP },
];
const landfall = (op: 'mana' | 'treasure'): Map<string, CardBehavior> =>
  new Map([[COBRA.oracleId, { v: 1, rules: [{ on: 'enters', q: 't:land', steps: [{ op, x: { kind: 'fixed', n: 1 } }] }] }]] as [
    string,
    CardBehavior,
  ][]);

const pool = run(cobraDeck, landfall('mana'));
const keeps = run(cobraDeck, landfall('treasure'));
const bare = run(cobraDeck);

console.log('\n=== landfall: one mana in the pool vs one Treasure ===');
console.log(line('mana  no rule', bare.r.manaByTurn));
console.log(line('mana  pool', pool.r.manaByTurn));
console.log(line('mana  Treasure', keeps.r.manaByTurn));

check((pool.r.manaByTurn[4] ?? 0) > (bare.r.manaByTurn[4] ?? 0) + 0.05, 'turn 4: landfall mana shows up');
check(
  (keeps.r.manaByTurn[6] ?? 0) > (pool.r.manaByTurn[6] ?? 0) + 0.1,
  `turn 6: a Treasure keeps and the pool does not (${(keeps.r.manaByTurn[6] ?? 0).toFixed(3)} vs ${(pool.r.manaByTurn[6] ?? 0).toFixed(3)})`,
);
neverCrosses('pool deck', pool.r);

// ---------------------------------------------------------------------------
// 4. The goldfish trace says what happened
// ---------------------------------------------------------------------------

const sink = newTraceSink(opts.seed);
simulate(buildSimDeck(deckWith(DARK_RITUAL)), { ...opts, games: 1, trace: true }, undefined, sink);
console.log('\n=== one game, traced ===');
for (const t of sink.game.turns.slice(0, 6)) {
  console.log(`turn ${t.turn}: ${t.available} available, ${t.spent} spent`);
  for (const l of t.lines) {
    console.log(`   ${l.kind.padEnd(5)} ${l.text}`);
    for (const tap of l.taps ?? []) console.log(`         ${tap}`);
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);

test('ritual-sim: every check passes', () => {
  expect(failures).toBe(0);
});
