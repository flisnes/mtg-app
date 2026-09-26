import { expect, test } from 'vitest';
// §13: does the card credit add up, and does it credit the right card?
//
// The whole claim the panel makes is that every row is a slice of a line on the
// chart above it. That claim is one assertion — the rows sum to the line — and
// it is the first thing here, because a decomposition that does not sum is not
// a decomposition, it is a second opinion with a misleading layout.
//
// The rest is the attribution itself: the Skyshroud Claim case (a land another
// card went and got is worth mana to the card that got it, not to the land) and
// the Archmage Emeritus case (a draw inside a watched trigger belongs to the
// watcher, and the spell that woke it keeps its own).
//
// Run with:
//   npx tsx notes/checks/credit-sim.ts
import type { CardBehavior } from '../../shared/src/behavior.js';
import type { OracleCard } from '../../shared/src/card.js';
import { buildSimDeck, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, type SimResult } from '../src/simulate.js';

let n = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${n++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{U}',
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;

const FOREST = card({ name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, manaCost: '', produces: 'G', mana: [0, 1, 0] });
const ISLAND = card({ name: 'Island', typeLine: 'Basic Land — Island', cmc: 0, manaCost: '', produces: 'U', mana: [0, 1, 0] });
const BLANK = card({ name: 'Blank Spell', manaCost: '{1}{G}', cmc: 2 });
const OPT = card({ name: 'Opt', typeLine: 'Instant', manaCost: '{U}', cmc: 1, effect: [0, 1] });
const DIVINATION = card({ name: 'Divination', manaCost: '{2}{U}', cmc: 3, effect: [0, 2] });
// Rampant Growth's profile: role landramp, one land. `mana` is [role, adds, tapped].
const RAMPANT = card({ name: 'Rampant Growth', manaCost: '{1}{G}', cmc: 2, produces: 'G', mana: [3, 1, 0] });
// Skyshroud Claim: the same role, two lands, and the reason this file exists.
const CLAIM = card({ name: 'Skyshroud Claim', manaCost: '{3}{G}', cmc: 4, produces: 'G', mana: [3, 2, 0] });
const SOL_RING = card({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, produces: 'C', mana: [1, 2, 0] });
// Archmage Emeritus: a permanent that watches you cast instants and sorceries.
const ARCHMAGE = card({ name: 'Archmage Emeritus', typeLine: 'Creature — Human Wizard', manaCost: '{2}{U}{U}', cmc: 4 });
const MAGECRAFT: CardBehavior = {
  v: 1,
  rules: [{ on: 'cast', q: 't:instant OR t:sorcery', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }],
};

const GAMES = 6000;
const run = (rows: DeckRow[], behaviors?: Map<string, CardBehavior>): SimResult =>
  simulate(buildSimDeck(rows, behaviors), { ...defaultSimOptions('commander', true), games: GAMES });

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};
const f2 = (v: number) => v.toFixed(2);
const credit = (r: SimResult, name: string) => r.contributions.find((c) => c.name === name);

/**
 * The invariant, both lines, every turn. Floating-point sums of twenty thousand
 * doubles will not land on the nose, so the tolerance is 1e-9 per turn rather
 * than exact equality — three orders of magnitude tighter than anything the
 * panel renders and still loose enough to survive the addition order changing.
 */
const sums = (label: string, r: SimResult) => {
  let worstMana = 0;
  let worstCards = 0;
  for (let turn = 1; turn <= r.maxTurn; turn++) {
    let mana = 0;
    let cards = (r.seenFromOpener[turn] ?? 0) + (r.seenFromDrawStep[turn] ?? 0);
    for (const c of r.contributions) {
      mana += c.manaByTurn[turn] ?? 0;
      cards += c.cardsByTurn[turn] ?? 0;
    }
    worstMana = Math.max(worstMana, Math.abs(mana - (r.manaByTurn[turn] ?? 0)));
    worstCards = Math.max(worstCards, Math.abs(cards - (r.cardsSeenByTurn[turn] ?? 0)));
  }
  check(`${label}: mana rows sum to the mana line`, worstMana < 1e-9, `worst drift ${worstMana.toExponential(1)}`);
  check(`${label}: card rows sum to the cards line`, worstCards < 1e-9, `worst drift ${worstCards.toExponential(1)}`);
};

// ---------------------------------------------------------------------------
// 1. The sum invariant, over decks that exercise every credit site
// ---------------------------------------------------------------------------
console.log('\n=== the rows are a slice of the line ===');
sums('lands only', run([{ quantity: 40, board: 'main', oracle: FOREST }, { quantity: 59, board: 'main', oracle: BLANK }]));
sums(
  'ramp and rocks',
  run([
    { quantity: 36, board: 'main', oracle: FOREST },
    { quantity: 8, board: 'main', oracle: RAMPANT },
    { quantity: 6, board: 'main', oracle: CLAIM },
    { quantity: 4, board: 'main', oracle: SOL_RING },
    { quantity: 45, board: 'main', oracle: BLANK },
  ]),
);
sums(
  'draw spells',
  run([
    { quantity: 38, board: 'main', oracle: ISLAND },
    { quantity: 10, board: 'main', oracle: DIVINATION },
    { quantity: 10, board: 'main', oracle: OPT },
    { quantity: 41, board: 'main', oracle: BLANK },
  ]),
);
sums(
  'a watched trigger',
  run(
    [
      { quantity: 38, board: 'main', oracle: ISLAND },
      { quantity: 12, board: 'main', oracle: OPT },
      { quantity: 8, board: 'main', oracle: ARCHMAGE },
      { quantity: 41, board: 'main', oracle: BLANK },
    ],
    new Map([[ARCHMAGE.oracleId, MAGECRAFT]]),
  ),
);

// ---------------------------------------------------------------------------
// 2. Skyshroud Claim: the land it fetched is worth mana to the Claim
// ---------------------------------------------------------------------------
console.log('\n=== a land another card went and got ===');
{
  const rows: DeckRow[] = [
    { quantity: 36, board: 'main', oracle: FOREST },
    { quantity: 8, board: 'main', oracle: CLAIM },
    { quantity: 55, board: 'main', oracle: BLANK },
  ];
  const r = run(rows);
  const claim = credit(r, 'Skyshroud Claim');
  const forest = credit(r, 'Forest');
  check('Skyshroud Claim is credited mana at all', !!claim && claim.mana > 0, claim ? `${f2(claim.mana)} mana` : 'no row');
  // It costs four, so it cannot resolve before turn four and cannot be worth
  // anything on turn three. The turn it is worth something is the turn after.
  check('and nothing before it could have been cast', (claim?.manaByTurn[3] ?? 0) === 0, `turn 3: ${f2(claim?.manaByTurn[3] ?? 0)}`);
  check('but something after', (claim?.manaByTurn[6] ?? 0) > 0, `turn 6: ${f2(claim?.manaByTurn[6] ?? 0)}`);
  check('the Forest keeps the rest', !!forest && forest.mana > (claim?.mana ?? 0), forest ? `${f2(forest.mana)} mana` : 'no row');
  console.log(`     Claim  ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => f2(claim?.manaByTurn[t] ?? 0)).join('  ')}`);
  console.log(`     Forest ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => f2(forest?.manaByTurn[t] ?? 0)).join('  ')}`);

  // And the thing the user asked for in the first place: more Claims is more
  // Claim credit, and the per-copy number is the one that survives the change.
  const half = run([
    { quantity: 36, board: 'main', oracle: FOREST },
    { quantity: 4, board: 'main', oracle: CLAIM },
    { quantity: 59, board: 'main', oracle: BLANK },
  ]);
  const four = credit(half, 'Skyshroud Claim');
  check('eight copies beat four', (claim?.mana ?? 0) > (four?.mana ?? 0), `${f2(claim?.mana ?? 0)} vs ${f2(four?.mana ?? 0)}`);
}

// ---------------------------------------------------------------------------
// 3. Sol Ring credits itself, every turn, from the turn after it lands
// ---------------------------------------------------------------------------
console.log('\n=== a rock is its own two mana ===');
{
  const r = run([
    { quantity: 38, board: 'main', oracle: FOREST },
    { quantity: 8, board: 'main', oracle: SOL_RING },
    { quantity: 53, board: 'main', oracle: BLANK },
  ]);
  const ring = credit(r, 'Sol Ring');
  check('Sol Ring is credited', !!ring && ring.mana > 0, ring ? `${f2(ring.mana)} mana over the game` : 'no row');
  check('and draws nothing', (ring?.cards ?? 0) === 0);
  console.log(`     Sol Ring ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => f2(ring?.manaByTurn[t] ?? 0)).join('  ')}`);
}

// ---------------------------------------------------------------------------
// 4. Archmage Emeritus: the trigger's card is the watcher's, Opt keeps its own
// ---------------------------------------------------------------------------
console.log('\n=== the magecraft case, which is the one that was asked about ===');
{
  const rows: DeckRow[] = [
    { quantity: 38, board: 'main', oracle: ISLAND },
    { quantity: 12, board: 'main', oracle: OPT },
    { quantity: 8, board: 'main', oracle: ARCHMAGE },
    { quantity: 41, board: 'main', oracle: BLANK },
  ];
  const withWatcher = run(rows, new Map([[ARCHMAGE.oracleId, MAGECRAFT]]));
  const without = run(rows);
  const arch = credit(withWatcher, 'Archmage Emeritus');
  const optWith = credit(withWatcher, 'Opt');
  const optWithout = credit(without, 'Opt');

  check('Archmage is credited cards', !!arch && arch.cards > 0, arch ? `${f2(arch.cards)} cards` : 'no row');
  check('and no mana, being neither a land nor a rock', (arch?.mana ?? 0) === 0);
  check(
    'Opt keeps its own draw either way',
    Math.abs((optWith?.cards ?? 0) - (optWithout?.cards ?? 0)) < 0.25,
    `${f2(optWith?.cards ?? 0)} with the watcher, ${f2(optWithout?.cards ?? 0)} without`,
  );
  check(
    'and the deck really does see more cards',
    (withWatcher.cardsSeenByTurn[8] ?? 0) > (without.cardsSeenByTurn[8] ?? 0),
    `${f2(withWatcher.cardsSeenByTurn[8] ?? 0)} vs ${f2(without.cardsSeenByTurn[8] ?? 0)}`,
  );
  // The unauthored deck has no watcher, so nobody should hold a credit for one.
  check('no watcher, no credit', !credit(without, 'Archmage Emeritus'));
  console.log(`     Archmage ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => f2(arch?.cardsByTurn[t] ?? 0)).join('  ')}`);
  console.log(`     Opt      ${[1, 2, 3, 4, 5, 6, 7, 8].map((t) => f2(optWith?.cardsByTurn[t] ?? 0)).join('  ')}`);
}

// ---------------------------------------------------------------------------
// 5. A blank earns nothing, and the opener is nobody's
// ---------------------------------------------------------------------------
console.log('\n=== the cards that did nothing ===');
{
  const r = run([{ quantity: 40, board: 'main', oracle: FOREST }, { quantity: 59, board: 'main', oracle: BLANK }]);
  check('a blank spell has no row', !credit(r, 'Blank Spell'));
  check('the opener is charged to nobody', (r.seenFromOpener[1] ?? 0) >= 7, `${f2(r.seenFromOpener[1] ?? 0)} cards`);
  check(
    'the draw step grows by one a turn',
    Math.abs((r.seenFromDrawStep[5] ?? 0) - (r.seenFromDrawStep[4] ?? 0) - 1) < 1e-9,
    `${f2(r.seenFromDrawStep[4] ?? 0)} -> ${f2(r.seenFromDrawStep[5] ?? 0)}`,
  );
}

// ---------------------------------------------------------------------------
// 6. What it costs. The accounting rides along inside loops that already ran,
//    so this should be noise rather than a number.
// ---------------------------------------------------------------------------
console.log('\n=== the bill ===');
{
  const rows: DeckRow[] = [
    { quantity: 36, board: 'main', oracle: FOREST },
    { quantity: 8, board: 'main', oracle: CLAIM },
    { quantity: 4, board: 'main', oracle: SOL_RING },
    { quantity: 10, board: 'main', oracle: DIVINATION },
    { quantity: 41, board: 'main', oracle: BLANK },
  ];
  const deck = buildSimDeck(rows);
  const opts = { ...defaultSimOptions('commander', true), games: 20000 };
  simulate(deck, { ...opts, games: 2000 });
  const t0 = performance.now();
  simulate(deck, opts);
  console.log(`     20,000 games: ${Math.round(performance.now() - t0)}ms`);
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILURES`}`);

test('credit-sim: every check passes', () => {
  expect(failures).toBe(0);
});
