import { expect, test } from 'vitest';
// Hand-made pools for the phase-1 half of §9.A: same-color unit groups and the
// generic-only unit. No card DB, no deck, just the solver.
import { canPay, missingColors, type ManaUnit, type UnitGroup } from '../src/canPay.js';
import { parseManaCost, type PipColor } from '../src/manaCost.js';

let pass = 0;
let fail = 0;

const u = (colors: string): ManaUnit => ({ colors: [...colors] as PipColor[] });
const many = (colors: string, n: number): ManaUnit[] => Array.from({ length: n }, () => u(colors));
const group = (colors: string, count: number): UnitGroup => ({ colors: [...colors] as PipColor[], count });

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}: expected ${e}, got ${a}`);
  }
}

const pay = (cost: string, units: ManaUnit[], groups: UnitGroup[] = []) =>
  canPay(parseManaCost(cost), units, groups);

console.log('\n-- regression: no groups, behaviour unchanged --');
// The comment at the top of canPay.ts, made executable. Per-color counting says
// two white and one blue, which is enough of each; the matching says no.
check('WU + WB + Mountain cannot pay {W}{W}{U}', pay('{W}{W}{U}', [u('WU'), u('WB'), u('R')]), false);
check('WU + WB + Mountain can pay {1}{W}{W}', pay('{1}{W}{W}', [u('WU'), u('WB'), u('R')]), true);
check('WU alone cannot pay {W}{U}', pay('{W}{U}', [u('WU')]), false);
check('Forest pays {G}', pay('{G}', [u('G')]), true);
check('Forest does not pay {W}', pay('{W}', [u('G')]), false);
check('empty pool pays {0}', pay('', []), true);
check('4 lands pay {3}{W} only with a white one', pay('{3}{W}', many('R', 4)), false);
check('hybrid {W/U}{W/U} off two Islands', pay('{W/U}{W/U}', many('U', 2)), true);
check('twobrid {2/R} off two colorless', pay('{2/R}', many('C', 2)), true);
check('Phyrexian {G/P} needs no green', pay('{G/P}', []), true);
check('{C} is not paid by a Forest', pay('{C}', [u('G')]), false);
check('{X}{R} counts X as zero', pay('{X}{R}', [u('R')]), true);

console.log('\n-- the generic-only unit (Exotic Orchard, §9.C) --');
const orchard = u('');
check('generic-only pays {1}', pay('{1}', [orchard]), true);
check('generic-only does not pay {W}', pay('{W}', [orchard]), false);
check('generic-only does not pay {C}', pay('{C}', [orchard]), false);
check('generic-only fills the generic of {1}{G}', pay('{1}{G}', [orchard, u('G')]), true);
check('generic-only cannot be the second G of {1}{G}{G}', pay('{1}{G}{G}', [orchard, u('G')]), false);
check('two Forests and an Orchard do pay {1}{G}{G}', pay('{1}{G}{G}', [orchard, u('G'), u('G')]), true);
check('3 Orchards + Forest pay {3}{G}', pay('{3}{G}', [orchard, orchard, orchard, u('G')]), true);
check('generic-only counts toward the total, so {4} needs four', pay('{4}', many('', 4)), true);
check('three generic-only do not pay {4}', pay('{4}', many('', 3)), false);

console.log('\n-- same-color groups (Lotus Field, §9.A) --');
const lotus = group('WUBRG', 3);
check('Lotus Field alone pays {B}{B}{B}', pay('{B}{B}{B}', [], [lotus]), true);
check('Lotus Field alone does NOT pay {W}{U}{B}', pay('{W}{U}{B}', [], [lotus]), false);
check('Lotus Field alone pays {2}{B}', pay('{2}{B}', [], [lotus]), true);
check('Lotus Field alone pays {3}', pay('{3}', [], [lotus]), true);
check('Lotus Field does not pay {4}', pay('{4}', [], [lotus]), false);
// The whole point of the group: Lotus is white OR blue, never both. {W}{U}{U}
// wants one of each plus a second blue, and the Island is the only other mana.
check('Lotus Field + Island fails {W}{U}{U}', pay('{W}{U}{U}', [u('U')], [lotus]), false);
check('Lotus Field + Island pays {W}{W}{W}{U}', pay('{W}{W}{W}{U}', [u('U')], [lotus]), true);
check('Lotus Field + Island pays {2}{U}{U}', pay('{2}{U}{U}', [u('U')], [lotus]), true);
// Expanded as three independent WUBRG units — the shipped bug — this is true.
check('Lotus Field alone fails {W}{U}{B}, the §9.A bug', pay('{W}{U}{B}', [], [lotus]), false);
check('Lotus Field + Island fails {W}{U}{B}{R}', pay('{W}{U}{B}{R}', [u('U')], [lotus]), false);
check('Lotus Field + Plains pays {W}{W}{W}{W}', pay('{W}{W}{W}{W}', [u('W')], [lotus]), true);
check('Lotus Field + Plains fails {W}{W}{W}{W}{W}', pay('{W}{W}{W}{W}{W}', [u('W')], [lotus]), false);
check('{C} is not "any one color"', pay('{C}{C}{C}', [], [lotus]), false);

console.log('\n-- Cascading Cataracts is the opposite case: independent units --');
const cataracts = many('WUBRGC', 5);
check('Cataracts pays {W}{U}{B}{R}{G}', pay('{W}{U}{B}{R}{G}', cataracts), true);

console.log('\n-- degenerate groups --');
check('zero-count group is ignored', pay('{1}', [u('G')], [group('WUBRG', 0)]), true);
check('empty-mask group is generic-only: pays {2}', pay('{2}', [], [group('', 2)]), true);
check('empty-mask group is generic-only: fails {W}{W}', pay('{W}{W}', [], [group('', 2)]), false);
check('single-color group is just mana: {G}{G}', pay('{G}{G}', [], [group('G', 2)]), true);
check('single-color group: fails {G}{G}{G}', pay('{G}{G}{G}', [], [group('G', 2)]), false);

console.log('\n-- two groups have to agree with each other, not with themselves --');
const twoLotus = [group('WUBRG', 3), group('WUBRG', 3)];
check('two Lotus Fields pay {W}{W}{W}{U}{U}{U}', pay('{W}{W}{W}{U}{U}{U}', [], twoLotus), true);
check('two Lotus Fields fail {W}{U}{B}{R}{G}{W}', pay('{W}{U}{B}{R}{G}{W}', [], twoLotus), false);
check('two Lotus Fields pay {5}{B}', pay('{5}{B}', [], twoLotus), true);

console.log('\n-- a group interacting with a flexible pip --');
// {2/W} paid in color needs the group on white; paid in generic it needs 2 mana.
check('Lotus Field pays {2/W}{2/W} (both in white)', pay('{2/W}{2/W}', [], [lotus]), true);
check('one Plains pays {2/W}{2/W}? no, needs 2 W or 4 generic', pay('{2/W}{2/W}', [u('W')]), false);

console.log('\n-- the group cap degrades safely, it does not lie --');
// 5 choices ^ 5 groups = 3125 > 1024, so the later groups fall back to colorless.
const fiveLotus = Array.from({ length: 5 }, () => group('WUBRG', 3));
check('5 Lotus Fields still pay {15} generic', pay('{15}', [], fiveLotus), true);
check('5 Lotus Fields never claim a color they cannot make', pay('{W}{U}{B}{R}{G}{W}{U}{B}{R}{G}{W}{U}{B}{R}{G}', [], fiveLotus), false);

console.log('\n-- missingColors --');
check('no blue in a mono-green pool', missingColors(parseManaCost('{1}{U}'), many('G', 3)), ['U']);
check('nothing missing when it is a count problem', missingColors(parseManaCost('{5}{G}'), many('G', 2)), []);
check('generic-only pool is short the color', missingColors(parseManaCost('{U}'), many('', 3)), ['U']);
check('group under-reports by design', missingColors(parseManaCost('{W}{U}{B}'), [], [lotus]), []);

console.log(`\n${pass} passed, ${fail} failed`);

test('canpay-groups: every check passes', () => {
  expect(fail).toBe(0);
});
