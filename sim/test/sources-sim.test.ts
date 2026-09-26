import { expect, test } from 'vitest';
// §14's recorder: colored sources as the game produced them, against
// `manaSources`' count of the decklist.
//
// The case the section is named after is here as deck 2. Nineteen Forests,
// twenty utility lands that tap for colorless only, and one Yavimaya. The
// static report widens every land in that deck to green and says 40 green
// sources, which is true in the games where the Yavimaya is on the battlefield
// and false in all the others. This measures which fraction of games that is,
// which is the number the panel could not previously ask for.
//
// Synthetic cards, for the reason every sim rig here uses them: in a real
// decklist the arithmetic is not checkable by hand. Run with:
//   npx tsx notes/checks/sources-sim.ts
import type { OracleCard } from '../../shared/src/card.js';
import { buildSimDeck, MASK_BITS, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, type SimResult } from '../src/simulate.js';
import { manaReport } from '../src/manaSources.js';

let n = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${n++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{G}',
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;

const FOREST = card({ name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, manaCost: '', produces: 'G', mana: [0, 1, 0] });
/** A utility land: one colorless, no color anybody can spend on a pip. */
const WASTES = card({ name: 'Utility Land', typeLine: 'Land', cmc: 0, manaCost: '', produces: 'C', mana: [0, 1, 0] });
/** The card §14 is about: every land you control is also a Forest. */
const YAVIMAYA = card({
  name: 'Yavimaya, Cradle of Growth',
  typeLine: 'Land',
  cmc: 0,
  manaCost: '',
  produces: 'G',
  mana: [0, 1, 0],
  grants: 'G',
});
const GG = card({ name: 'Double Green Three Drop', manaCost: '{1}{G}{G}', cmc: 3 });

const GAMES = 8000;
const opts = { ...defaultSimOptions('commander', true), games: GAMES };

const run = (rows: DeckRow[]) => {
  const deck = buildSimDeck(rows);
  return { deck, r: simulate(deck, opts), report: manaReport(rows, deck.library.length, 'commander') };
};

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

const at = (r: SimResult, color: string, turn: number) => r.sourcesByTurn[MASK_BITS.indexOf(color)]?.[turn] ?? 0;
const share = (r: SimResult, color: string, turn: number) => {
  const total = r.sourcesInPlayByTurn[turn] ?? 0;
  return total > 0 ? at(r, color, turn) / total : 0;
};

const line = (label: string, xs: readonly number[]) =>
  `${label.padEnd(26)} ${xs.slice(1, 9).map((v) => v.toFixed(2)).join('  ')}`;

/**
 * The two invariants that have to hold whatever the deck is: a color count is a
 * subset of the sources in play, and a source cannot be in play before it could
 * have been drawn and dropped.
 */
const invariants = (label: string, r: SimResult) => {
  for (let t = 1; t <= r.maxTurn; t++) {
    const total = r.sourcesInPlayByTurn[t] ?? 0;
    for (const c of MASK_BITS) {
      if (at(r, c, t) > total + 1e-9) {
        check(false, `${label}: turn ${t} has ${at(r, c, t).toFixed(2)} ${c} sources out of ${total.toFixed(2)} in play`);
        return;
      }
    }
    // One land drop a turn, and nothing in these decks ramps, so the count can
    // never run ahead of the turn number.
    if (total > t + 1e-9) {
      check(false, `${label}: turn ${t} has ${total.toFixed(2)} sources in play with one land drop a turn`);
      return;
    }
  }
  check(true, `${label}: every color count is a subset of the sources in play, and no source arrives early`);
};

// ---------------------------------------------------------------------------
// 1. The control: all Forests, so measured and printed have to agree on 100%
// ---------------------------------------------------------------------------
// Forty Forests. Every source in play makes green in every game, so the share
// is 1.0 on every turn and any deviation is a bug in the recorder rather than a
// fact about the deck.

const mono = run([
  { quantity: 40, board: 'main', oracle: FOREST },
  { quantity: 59, board: 'main', oracle: GG },
]);

console.log('=== 40 Forests: the recorder against a deck with nothing to get wrong ===');
console.log(line('sources in play', mono.r.sourcesInPlayByTurn));
console.log(line('G sources', mono.r.sourcesByTurn[MASK_BITS.indexOf('G')]!));
invariants('mono', mono.r);
check(
  Math.abs(share(mono.r, 'G', 4) - 1) < 1e-9,
  `turn 4: every source in play makes green (${(share(mono.r, 'G', 4) * 100).toFixed(1)}%)`,
);
// The land-drop line is the one number here another engine already reports, so
// it is the cross-check that the sample is taken at the right point in the turn.
const drops = mono.r.landDropByTurn.slice(1, 5).reduce((a, b) => a + b, 0);
console.log(`land drops made by turn 4:  ${drops.toFixed(3)}   sources in play: ${(mono.r.sourcesInPlayByTurn[4] ?? 0).toFixed(3)}`);
check(
  Math.abs(drops - (mono.r.sourcesInPlayByTurn[4] ?? 0)) < 0.02,
  'turn 4: sources in play equals the land drops actually made',
);

// ---------------------------------------------------------------------------
// 2. Yavimaya: the case §14 is named after
// ---------------------------------------------------------------------------

const yavi = run([
  { quantity: 19, board: 'main', oracle: FOREST },
  { quantity: 20, board: 'main', oracle: WASTES },
  { quantity: 1, board: 'main', oracle: YAVIMAYA },
  { quantity: 59, board: 'main', oracle: GG },
]);

const printedG = yavi.report.byColor.find((c) => c.color === 'G')?.count ?? 0;
console.log('\n=== 19 Forests + 20 utility lands + 1 Yavimaya ===');
console.log(`manaReport says            ${printedG} green sources, granted: ${yavi.report.granted.join('') || 'none'}`);
console.log(line('sources in play', yavi.r.sourcesInPlayByTurn));
console.log(line('G sources', yavi.r.sourcesByTurn[MASK_BITS.indexOf('G')]!));
console.log(
  line(
    'G share',
    yavi.r.sourcesInPlayByTurn.map((_v, t) => share(yavi.r, 'G', t)),
  ),
);
invariants('yavimaya', yavi.r);

// The static count widens all forty lands to green because the deck holds a
// granter. That is the claim §14.1 calls an apology, and this is it failing.
check(printedG === 40, `the static report claims all 40 lands are green sources (${printedG})`);
// Measured: a Yavimaya is one card in ninety-nine, so most games never see it
// and a green share near 100% would mean the recorder is reading the grant
// without checking the battlefield.
const s4 = share(yavi.r, 'G', 4);
check(s4 < 0.75, `turn 4: the measured green share is well under the printed 100% (${(s4 * 100).toFixed(1)}%)`);
// And above the floor: 19 of 40 lands are Forests, so a deck that never found
// the Yavimaya would sit at 47.5%. The gap above that is the Yavimaya games.
check(s4 > 0.47, `turn 4: and above the no-Yavimaya floor of 47.5% (${(s4 * 100).toFixed(1)}%)`);

// ---------------------------------------------------------------------------
// 3. The same deck with the granter taken out: the floor, stated
// ---------------------------------------------------------------------------
// Twenty utility lands and twenty Forests, no Yavimaya. Half the lands make
// green and the measured share has to say so, which is what pins the number in
// deck 2 to the Yavimaya rather than to anything else in the model.

const noGrant = run([
  { quantity: 20, board: 'main', oracle: FOREST },
  { quantity: 20, board: 'main', oracle: WASTES },
  { quantity: 59, board: 'main', oracle: GG },
]);

console.log('\n=== The same manabase with no granter ===');
console.log(
  line(
    'G share',
    noGrant.r.sourcesInPlayByTurn.map((_v, t) => share(noGrant.r, 'G', t)),
  ),
);
invariants('no granter', noGrant.r);
const flat = share(noGrant.r, 'G', 4);
check(Math.abs(flat - 0.5) < 0.03, `turn 4: half the sources make green, as printed (${(flat * 100).toFixed(1)}%)`);
check(
  s4 > flat + 0.01,
  `the Yavimaya deck reads greener than the same manabase without it (${(s4 * 100).toFixed(1)}% vs ${(flat * 100).toFixed(1)}%)`,
);

// The Yavimaya's contribution is the *gap* against this control, and it is the
// gap that has to climb with the turn: the later it is, the likelier the
// granter is on the battlefield.
//
// The absolute share does the opposite, and that is the sequencer rather than
// the manabase. It plays the land that most widens your colors, so turn one is
// a Forest in 87% of games against a 47.5% deck composition, and every turn
// after that regresses toward the deck. Both decks show the same fall, which is
// what makes the gap and not the level the number to read.
const gap = (t: number) => share(yavi.r, 'G', t) - share(noGrant.r, 'G', t);
console.log(line('Yavimaya gap', noGrant.r.sourcesInPlayByTurn.map((_v, t) => gap(t))));
check(
  gap(8) > gap(2) + 0.02,
  `the granter's share of the green count climbs with the turn (${(gap(2) * 100).toFixed(1)}pp -> ${(gap(8) * 100).toFixed(1)}pp)`,
);

// ---------------------------------------------------------------------------
// 4. A source that makes two colors is counted against both
// ---------------------------------------------------------------------------
// Forty duals. Every source in play makes green and makes white, so both shares
// are 1.0 and they do not have to sum to one. This is the invariant a recorder
// counting mana units instead of sources would break.

const DUAL = card({ name: 'Dual Land', typeLine: 'Land', cmc: 0, manaCost: '', produces: 'GW', mana: [0, 1, 0] });
const dual = run([
  { quantity: 40, board: 'main', oracle: DUAL },
  { quantity: 59, board: 'main', oracle: GG },
]);
console.log('\n=== 40 GW duals: a source counts against every color it makes ===');
console.log(line('G share', dual.r.sourcesInPlayByTurn.map((_v, t) => share(dual.r, 'G', t))));
console.log(line('W share', dual.r.sourcesInPlayByTurn.map((_v, t) => share(dual.r, 'W', t))));
invariants('duals', dual.r);
check(
  Math.abs(share(dual.r, 'G', 4) - 1) < 1e-9 && Math.abs(share(dual.r, 'W', 4) - 1) < 1e-9,
  'turn 4: both shares are 100% — a dual is one source for two colors, not half a source each',
);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);

test('sources-sim: every check passes', () => {
  expect(failures).toBe(0);
});
