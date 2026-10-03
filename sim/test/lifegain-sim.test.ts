import { expect, test } from 'vitest';
// Rebuild plan §6 step 3: lifegain and poison. Printed lifelink, infect and
// toxic are read off the card; a lifelink hit is one life-gain event and wakes
// the "whenever you gain life" rules; poison is the opponent's counter the
// other way. Decks are built so the answer can be worked out by hand: lands,
// one creature kind, and the card under test in the command zone.
//
//   npx vitest run sim/test/lifegain-sim.test.ts
import { MANA_TAPPED, type OracleCard } from '../../shared/src/card.js';
import type { CardBehavior } from '../../shared/src/behavior.js';
import { KW_INFECT, KW_LIFELINK, buildSimDeck, printedKeywords, printedToxic, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, traceGame, type SimOptions } from '../src/simulate.js';

let seq = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${seq++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{W}',
    oracleText: o.oracleText ?? null,
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;
const land = (name: string, color: string, adds = 1, tapped = false, typeLine = 'Land') =>
  card({ name, typeLine, cmc: 0, manaCost: '', produces: color, mana: [0, adds, tapped ? MANA_TAPPED : 0] });
const PLAINS = land('Plains', 'W', 1, false, 'Basic Land — Plains');
const BEAR = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', manaCost: '{1}{W}', cmc: 2, power: '2', toughness: '2' });
const LINKER = card({ name: 'Vampire Nighthawk', typeLine: 'Creature — Vampire', manaCost: '{1}{W}', cmc: 2, power: '2', toughness: '3', oracleText: 'Flying, deathtouch, lifelink' });
const INFECTOR = card({ name: 'Blight Mamba', typeLine: 'Creature — Snake', manaCost: '{1}{W}', cmc: 2, power: '1', toughness: '1', oracleText: 'Infect (This creature deals damage to creatures in the form of -1/-1 counters and to players in the form of poison counters.)' });
const TOXIC = card({ name: 'Venomous Rat', typeLine: 'Creature — Rat', manaCost: '{1}{W}', cmc: 2, power: '2', toughness: '2', oracleText: 'Toxic 1 (Players dealt combat damage by this creature also get a poison counter.)' });

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
console.log('\n=== the reading ===');
{
  check((printedKeywords(LINKER.oracleText) & KW_LIFELINK) !== 0, 'lifelink on a keyword line');
  check((printedKeywords(INFECTOR.oracleText) & KW_INFECT) !== 0, 'infect, the reminder text ignored');
  check(printedToxic(TOXIC.oracleText) === 1, 'toxic 1');
  check(printedToxic('Flying, toxic 2') === 2, 'toxic after another keyword');
  check(printedKeywords('Creatures you control have lifelink.') === 0, 'a sentence granting lifelink is not a printed keyword');
}

// ---------------------------------------------------------------------------
console.log('\n=== lifelink: combat damage is life, and it wakes a life-gain rule ===');
{
  // Plains and lifelinkers: life climbs by the combat damage dealt.
  const linked = run([main(50, PLAINS), main(49, LINKER)]);
  const bears = run([main(50, PLAINS), main(49, BEAR)]);
  const gained = (linked.lifeByTurn[8] ?? 0) - 40;
  check(bears.lifeByTurn[8] === 40, `bears: life stays at 40 (${bears.lifeByTurn[8]})`);
  check(gained > 0 && Math.abs(gained - (linked.combatDamageByTurn[8] ?? 0)) < 0.01, `lifelinkers: life up ${gained.toFixed(2)} by turn 8, combat damage ${linked.combatDamageByTurn[8]!.toFixed(2)}`);

  // Ajani's Pridemate in the command zone: a +1/+1 counter per life-gain event,
  // one event per lifelinker that connects. So the Pridemate's power on a turn
  // is 2 plus the lifelinkers that swung before it (from the turn before).
  const PRIDEMATE = card({ name: 'Pridemate', typeLine: 'Creature — Cat Soldier', manaCost: '{1}{W}', cmc: 2, power: '2', toughness: '2' });
  const rules = new Map<string, CardBehavior>([[PRIDEMATE.oracleId, { v: 1, rules: [{ on: 'lifegain', steps: [{ op: 'counter', x: { kind: 'fixed', n: 1 }, ck: 'p1p1' }] }] }]]);
  const deck = [main(50, PLAINS), main(49, LINKER), cmd(PRIDEMATE)];
  const withMate = run(deck, rules);
  const without = run([main(50, PLAINS), main(49, LINKER), cmd(BEAR)]);
  check(withMate.combatDamageByTurn[8]! > without.combatDamageByTurn[8]! + 3, `Pridemate adds combat damage: ${withMate.combatDamageByTurn[8]!.toFixed(2)} vs ${without.combatDamageByTurn[8]!.toFixed(2)} by turn 8`);
  const fired = withMate.fires.find((f) => f.oracleId === PRIDEMATE.oracleId && f.on === 'lifegain');
  check(!!fired && fired.perGame > 2, `the life-gain rule fires ${fired?.perGame.toFixed(2)} times a game`);
  const trace = lines(deck, rules, 3);
  check(trace.some((l) => /Attacks with \d+ creatures? for \d+, gaining \d+ life/.test(l.text)), 'the attack line says how much life it gains');
  check(trace.some((l) => /Pridemate gets 1 \+1\/\+1 counter/.test(l.text)), 'the trace shows the counter going on');
  check(trace.some((l) => /^Life total \d+ \(\+\d+ this turn\)/.test(l.text)), 'the turn says the new life total');
}

// ---------------------------------------------------------------------------
console.log('\n=== "what woke it" and "life gained this turn" ===');
{
  // Sanguine Bond: whenever you gain life, deal that much. With lifelinkers
  // every point of combat damage is dealt twice: once in combat, once by Bond.
  const BOND = card({ name: 'Bond', typeLine: 'Enchantment', manaCost: '{3}{W}{W}', cmc: 5 });
  const rules = new Map<string, CardBehavior>([[BOND.oracleId, { v: 1, rules: [{ on: 'lifegain', steps: [{ op: 'damage', x: { kind: 'cause' } }] }] }]]);
  const deck = [main(50, PLAINS), main(49, LINKER), cmd(BOND)];
  const trace = lines(deck, rules, 5);
  const bondTurn = trace.find((l) => l.text.startsWith('Casts Bond'))?.turn ?? 99;
  const after = trace.filter((l) => l.turn > bondTurn);
  const swings = after.filter((l) => /^Attacks with/.test(l.text));
  const drains = after.filter((l) => /Bond deals (\d+) damage/.test(l.text));
  const swung = swings.reduce((s, l) => s + Number(/for (\d+)/.exec(l.text)?.[1] ?? 0), 0);
  const drained = drains.reduce((s, l) => s + Number(/deals (\d+) damage/.exec(l.text)?.[1] ?? 0), 0);
  check(swings.length > 0 && swung === drained, `after the Bond lands, combat damage ${swung} is matched by Bond damage ${drained}`);

  // An end-step rule reading "life gained this turn" reads the whole turn's.
  const TALLY = card({ name: 'Tally', typeLine: 'Enchantment', manaCost: '{1}{W}', cmc: 2 });
  const tally = new Map<string, CardBehavior>([[TALLY.oracleId, { v: 1, rules: [{ on: 'endstep', steps: [{ op: 'damage', x: { kind: 'lifegained' } }] }] }]]);
  const t2 = lines([main(50, PLAINS), main(49, LINKER), cmd(TALLY)], tally, 7);
  const byTurn = new Map<number, { swung: number; tallied: number }>();
  for (const l of t2) {
    const row = byTurn.get(l.turn) ?? { swung: 0, tallied: 0 };
    const s = /^Attacks with .* for (\d+)/.exec(l.text);
    if (s) row.swung += Number(s[1]);
    const d = /Tally deals (\d+) damage/.exec(l.text);
    if (d) row.tallied += Number(d[1]);
    byTurn.set(l.turn, row);
  }
  const tallied = [...byTurn.values()].filter((r) => r.tallied > 0);
  check(tallied.length > 0 && tallied.every((r) => r.swung === r.tallied), `"life gained this turn" at the end step equals the turn's lifelink damage (${tallied.length} turns)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== poison: infect instead of damage, toxic on top ===');
{
  const infect = run([main(50, PLAINS), main(49, INFECTOR)]);
  check((infect.combatDamageByTurn[8] ?? 0) === 0 && (infect.poisonByTurn[8] ?? 0) > 0, `infect creatures deal no damage and ${infect.poisonByTurn[8]!.toFixed(2)} poison by turn 8`);
  const toxic = run([main(50, PLAINS), main(49, TOXIC)]);
  const bears = run([main(50, PLAINS), main(49, BEAR)]);
  check(Math.abs(toxic.combatDamageByTurn[8]! - bears.combatDamageByTurn[8]!) < 0.01, `toxic creatures deal the same combat damage as bears (${toxic.combatDamageByTurn[8]!.toFixed(2)})`);
  check(Math.abs(toxic.poisonByTurn[8]! * 2 - toxic.combatDamageByTurn[8]!) < 0.01, `and one poison per 2/2 that connects (${toxic.poisonByTurn[8]!.toFixed(2)} poison)`);
  check(bears.poisonByTurn[8] === 0, 'bears give no poison');

  // Triumph of the Hordes, written out: creatures get +1/+1 and infect until
  // end of turn. The turn it is cast, every point of combat damage is poison.
  const TRIUMPH = card({ name: 'Triumph', typeLine: 'Sorcery', manaCost: '{2}{W}{W}', cmc: 4 });
  const rules = new Map<string, CardBehavior>([
    [TRIUMPH.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'pump', x: { kind: 'fixed', n: 1 } }, { op: 'keyword', x: { kind: 'fixed', n: 1 }, kw: 'I' }] }] }],
  ]);
  const trace = lines([main(50, PLAINS), main(49, BEAR), cmd(TRIUMPH)], rules, 2);
  const turn = trace.find((l) => l.text.startsWith('Casts Triumph'))?.turn;
  const swing = trace.find((l) => l.turn === turn && l.text.startsWith('Attacks with'));
  check(!!swing && / for 0 and \d+ poison/.test(swing.text), `the turn Triumph resolves: ${swing?.text ?? '(no attack)'}`);
  const rule = trace.find((l) => l.turn === turn && /Triumph gives \d+ creatures? \+1\/\+1, gives \d+ creatures? infect/.test(l.text));
  check(!!rule, `and the rule reads as written: ${rule?.text ?? '(missing)'}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== nothing else moves ===');
{
  const plain = run([main(50, PLAINS), main(49, BEAR)]);
  check(Math.abs(plain.manaByTurn[6]! - 5.75) < 0.6, `mana on turn 6 ${plain.manaByTurn[6]!.toFixed(2)}`);
  check((plain.poisonByTurn[8] ?? 0) === 0 && plain.lifeByTurn[8] === 40, 'a deck without any of this reads 0 poison, 40 life');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('lifegain-sim: every check passes', () => {
  expect(failures).toBe(0);
});
