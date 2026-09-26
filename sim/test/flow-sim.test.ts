import { expect, test } from 'vitest';
// Rebuild plan B2: screw, flood, idle turns and the mana distribution.
//
// Three synthetic decks at the extremes, plus the invariants that hold for any
// deck. Run with:
//   npx tsx notes/checks/flow-sim.ts
import type { OracleCard } from '../../shared/src/card.js';
import { buildSimDeck, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, MANA_BINS, simulate, type SimResult } from '../src/simulate.js';

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
const FOREST = card({ name: 'Forest', typeLine: 'Land', cmc: 0, manaCost: '', produces: 'G', mana: [0, 1, 0] });

const GAMES = 8000;
const opts = { ...defaultSimOptions('commander', true), games: GAMES };
const run = (rows: DeckRow[]): SimResult => simulate(buildSimDeck(rows), opts);
const curve = (lands: number): DeckRow[] => {
  const spells = 99 - lands;
  const two = Math.round(spells * 0.35);
  const three = Math.round(spells * 0.35);
  return [
    { quantity: lands, board: 'main', oracle: FOREST },
    { quantity: two, board: 'main', oracle: card({ name: 'Two', manaCost: '{1}{G}', cmc: 2 }) },
    { quantity: three, board: 'main', oracle: card({ name: 'Three', manaCost: '{2}{G}', cmc: 3 }) },
    { quantity: spells - two - three, board: 'main', oracle: card({ name: 'Five', manaCost: '{4}{G}', cmc: 5 }) },
  ];
};

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};
const p = (x: number) => `${(x * 100).toFixed(1)}%`;

const report = (label: string, r: SimResult) => {
  console.log(`\n=== ${label} ===`);
  console.log('turn  screw  flood  idle   screwEver floodEver  >=turn mana  mean(hist) mean');
  for (let t = 1; t <= r.maxTurn; t++) {
    const at = r.manaAtLeast[t]!;
    let mean = 0;
    for (let k = 1; k < MANA_BINS; k++) mean += at[k]!;
    console.log(
      `${String(t).padEnd(5)} ${p(r.screwByTurn[t]!).padEnd(6)} ${p(r.floodByTurn[t]!).padEnd(6)} ${p(r.idleByTurn[t]!).padEnd(6)} ${p(r.screwEverByTurn[t]!).padEnd(9)} ${p(r.floodEverByTurn[t]!).padEnd(10)} ${p(at[t] ?? 0).padEnd(12)} ${mean.toFixed(2).padEnd(11)} ${r.manaByTurn[t]!.toFixed(2)}`,
    );
    check(r.screwByTurn[t]! + r.floodByTurn[t]! <= 1 + 1e-9, `turn ${t}: screwed and flooded never overlap`);
    check(Math.abs(at[0]! - 1) < 1e-9, `turn ${t}: at least 0 mana is every game`);
    check(at.every((v, k) => k === 0 || v <= at[k - 1]! + 1e-12), `turn ${t}: at-least is non-increasing in k`);
    check(Math.abs(mean - r.manaByTurn[t]!) < 0.01, `turn ${t}: the histogram's mean is manaByTurn`);
    check(r.screwEverByTurn[t]! + 1e-9 >= r.screwByTurn[t]!, `turn ${t}: ever >= this turn (screw)`);
    check(r.floodEverByTurn[t]! + 1e-9 >= r.floodByTurn[t]!, `turn ${t}: ever >= this turn (flood)`);
    if (t > 1) check(r.screwEverByTurn[t]! + 1e-9 >= r.screwEverByTurn[t - 1]!, `turn ${t}: screwEver climbs`);
  }
  return r;
};

const light = report('24 Forests', run(curve(24)));
const normal = report('38 Forests', run(curve(38)));
const heavy = report('60 Forests', run(curve(60)));

const T = 6;
check(light.screwEverByTurn[T]! > normal.screwEverByTurn[T]!, `fewer lands, more screw (${p(light.screwEverByTurn[T]!)} > ${p(normal.screwEverByTurn[T]!)})`);
check(normal.screwEverByTurn[T]! > heavy.screwEverByTurn[T]!, `more lands, less screw (${p(normal.screwEverByTurn[T]!)} > ${p(heavy.screwEverByTurn[T]!)})`);
check(heavy.floodEverByTurn[T]! > normal.floodEverByTurn[T]!, `more lands, more flood (${p(heavy.floodEverByTurn[T]!)} > ${p(normal.floodEverByTurn[T]!)})`);
check(normal.floodEverByTurn[T]! > light.floodEverByTurn[T]!, `fewer lands, less flood (${p(normal.floodEverByTurn[T]!)} > ${p(light.floodEverByTurn[T]!)})`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);

test('flow-sim: every check passes', () => {
  expect(failures).toBe(0);
});
