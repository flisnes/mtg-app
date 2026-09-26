import { expect, test } from 'vitest';
// Rebuild plan B1: the limiter. When a held card is not payable on its own
// turn, was it the tapped land, too little mana, or the wrong colors.
//
// Three synthetic decks, each built so one reason has to dominate, plus the
// invariant that holds for any deck: the reasons and the on-curve share add
// back up to one. Run with:
//   npx tsx notes/checks/limiter-sim.ts
import type { OracleCard } from '../../shared/src/card.js';
import { buildSimDeck, MASK_BITS, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, type SimResult } from '../src/simulate.js';

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

const land = (name: string, color: string, tapped = false) =>
  card({ name, typeLine: 'Land', cmc: 0, manaCost: '', produces: color, mana: [0, 1, tapped ? 1 : 0] });
const FOREST = land('Forest', 'G');
const MOUNTAIN = land('Mountain', 'R');
const TAPPED_FOREST = land('Tapped Forest', 'G', true);

const GAMES = 8000;
const opts = { ...defaultSimOptions('commander', true), games: GAMES };
const run = (rows: DeckRow[]): SimResult => simulate(buildSimDeck(rows), opts);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};
const p = (x: number) => `${(x * 100).toFixed(1)}%`;

const report = (label: string, r: SimResult) => {
  console.log(`\n=== ${label} ===`);
  for (const c of r.costs) {
    const l = c.limits;
    const shorts = MASK_BITS.split('')
      .map((col, i) => (l.colors[i]! > 0 ? `${col} ${p(l.colors[i]!)}` : ''))
      .filter(Boolean)
      .join(' ');
    console.log(
      `${c.manaCost.padEnd(14)} turn ${c.curveTurn}  pay ${p(c.onCurvePay)}  tapped ${p(l.tapped)}  mana ${p(l.mana)}  color ${p(l.color)}  ${shorts}`,
    );
    const sum = c.onCurvePay + l.tapped + l.mana + l.color;
    check(Math.abs(sum - 1) < 0.01, `${c.manaCost}: on time and the three reasons add up to one (${sum.toFixed(3)})`);
  }
  return r.costs[0]!;
};

// 1. Thirty Forests under a pile of five-drops: mono-green, untapped, so the
//    only thing that can go wrong on turn five is the land count.
const five = report(
  '30 Forests, {4}{G} five-drops',
  run([
    { quantity: 30, board: 'main', oracle: FOREST },
    { quantity: 69, board: 'main', oracle: card({ name: 'Five', manaCost: '{4}{G}', cmc: 5 }) },
  ]),
);
check(five.limits.mana > 0.1, `short on mana a real share of the time (${p(five.limits.mana)})`);
check(five.limits.color < 1e-9 && five.limits.tapped < 1e-9, 'never color, never tapped');

// 2. A 20/20 Forest-Mountain split under {G}{G}{G}: plenty of lands, the wrong
//    half of them, so color has to lead and it has to name green.
const ggg = report(
  '20 Forests + 20 Mountains, {G}{G}{G}',
  run([
    { quantity: 20, board: 'main', oracle: FOREST },
    { quantity: 20, board: 'main', oracle: MOUNTAIN },
    { quantity: 59, board: 'main', oracle: card({ name: 'Triple Green', manaCost: '{G}{G}{G}', cmc: 3 }) },
  ]),
);
check(ggg.limits.color > ggg.limits.mana, `color leads mana (${p(ggg.limits.color)} vs ${p(ggg.limits.mana)})`);
const g = MASK_BITS.indexOf('G');
check(Math.abs(ggg.limits.colors[g]! - ggg.limits.color) < 1e-9, 'every color miss names green');
check(ggg.limits.colors[MASK_BITS.indexOf('R')]! === 0, 'and never red');

// 3. Forty lands that always enter tapped, under two-drops. On turn two the
//    first land is up and the second came down tapped: that is the whole
//    miss, so tapped has to be nearly all of it.
const two = report(
  '40 tapped Forests, {1}{G}',
  run([
    { quantity: 40, board: 'main', oracle: TAPPED_FOREST },
    { quantity: 59, board: 'main', oracle: card({ name: 'Two', manaCost: '{1}{G}', cmc: 2 }) },
  ]),
);
check(two.limits.tapped > 0.5, `tapped is most of the miss (${p(two.limits.tapped)} of ${p(1 - two.onCurvePay)})`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);

test('limiter-sim: every check passes', () => {
  expect(failures).toBe(0);
});
