import { expect, test } from 'vitest';
// Rebuild plan E4: the thin table model. Opponents who draw and cast, the
// rules that watch them (oppcast, oppdraw, oppenters, oppdies), taxes, edicts,
// wheels, and the `answer` interaction policy: counterspells held for an
// opponent's turn, removal waiting for a creature to hit.
//
//   npx vitest run sim/test/table-sim.test.ts
import type { OracleCard } from '../../shared/src/card.js';
import { describeRule, oppSpellFilter, sanitizeCardBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import { buildSimDeck, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, traceGame, type SimOptions, type SimResult } from '../src/simulate.js';

let seq = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${seq++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{G}',
    oracleText: o.oracleText ?? null,
    colorIdentity: ['G'],
    colors: ['G'],
    rarity: 'common',
    ...o,
  }) as OracleCard;
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });

const FOREST = card({ name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, manaCost: '', produces: 'G', mana: [0, 1, 0] });
const BEAR = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
const STUDY = card({ name: 'Study', typeLine: 'Enchantment', manaCost: '{2}{G}', cmc: 3 });
const TITHE = card({ name: 'Tithe', typeLine: 'Enchantment', manaCost: '{3}{G}', cmc: 4 });
const SENTINEL = card({ name: 'Sentinel', typeLine: 'Creature — Human', manaCost: '{G}', cmc: 1, power: '1', toughness: '1' });
const COUNTER = card({ name: 'Counter', typeLine: 'Instant', manaCost: '{G}{G}', cmc: 2, oracleText: 'Counter target spell.' });
const SWORDS = card({ name: 'Swords', typeLine: 'Instant', manaCost: '{G}', cmc: 1, oracleText: 'Exile target creature. Its controller gains life equal to its power.' });
const ARTIST = card({ name: 'Artist', typeLine: 'Creature — Vampire', manaCost: '{1}{G}', cmc: 2, power: '0', toughness: '1' });
const EDICT = card({ name: 'Edict', typeLine: 'Sorcery', manaCost: '{1}{G}', cmc: 2 });
const WHEEL = card({ name: 'Wheel', typeLine: 'Sorcery', manaCost: '{2}{G}', cmc: 3 });
const SHEOLDRED = card({ name: 'Sheoldred', typeLine: 'Legendary Creature — Phyrexian', manaCost: '{2}{G}{G}', cmc: 4, power: '4', toughness: '5' });
const PRIEST = card({ name: 'Priest', typeLine: 'Creature — Cleric', manaCost: '{1}{G}', cmc: 2, power: '1', toughness: '1' });
const TALLY = card({ name: 'Tally', typeLine: 'Sorcery', manaCost: '{1}{G}', cmc: 2 });

const n = (k: number) => ({ kind: 'fixed' as const, n: k });
const behaviors = new Map<string, CardBehavior>([
  [STUDY.oracleId, { v: 1, rules: [{ on: 'oppcast', tax: 1, steps: [{ op: 'draw', x: n(1) }] }] }],
  [TITHE.oracleId, { v: 1, rules: [{ on: 'oppdraw', tax: 2, steps: [{ op: 'treasure', x: n(1) }] }] }],
  [SENTINEL.oracleId, { v: 1, rules: [{ on: 'oppcast', q: '-t:creature', tax: 1, once: true, steps: [{ op: 'draw', x: n(1) }] }] }],
  [ARTIST.oracleId, { v: 1, rules: [{ on: 'oppdies', steps: [{ op: 'damage', x: n(1) }] }] }],
  [EDICT.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'oppsac', x: n(1) }] }] }],
  [WHEEL.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'oppdraws', x: n(1) }] }] }],
  [SHEOLDRED.oracleId, { v: 1, rules: [{ on: 'oppdraw', steps: [{ op: 'damage', x: n(2) }] }] }],
  [PRIEST.oracleId, { v: 1, rules: [{ on: 'oppenters', steps: [{ op: 'damage', x: n(1) }] }] }],
  [TALLY.oracleId, { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'opponents' } }] }] }],
]);

const GAMES = 4000;
const base: SimOptions = { ...defaultSimOptions('commander', true), games: GAMES };
const run = (rows: DeckRow[], over: Partial<SimOptions> = {}): SimResult => simulate(buildSimDeck(rows, behaviors), { ...base, ...over });
const deck = (...extra: DeckRow[]): DeckRow[] => [main(24, FOREST), main(8, BEAR), ...extra];
const fires = (r: SimResult, o: OracleCard, on: string) => r.fires.find((f) => f.oracleId === o.oracleId && f.on === on)?.perGame ?? 0;
const seen = (r: SimResult) => r.cardsSeenByTurn[8] ?? 0;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};
const f1 = (x: number) => x.toFixed(2);

// ---------------------------------------------------------------------------
console.log('\n=== grammar ===');
{
  const study = behaviors.get(STUDY.oracleId)!;
  check(describeRule(study.rules[0]!) === 'Whenever an opponent casts a spell, unless they pay {1}: draw 1', `Study reads: ${describeRule(study.rules[0]!)}`);
  const sentinel = behaviors.get(SENTINEL.oracleId)!;
  check(describeRule(sentinel.rules[0]!).startsWith('Whenever an opponent casts a noncreature spell, unless they pay {1}, once each turn'), `Sentinel reads: ${describeRule(sentinel.rules[0]!)}`);
  const clean = sanitizeCardBehavior(study);
  check(clean?.rules[0]?.tax === 1, 'the tax survives the sanitizer on an opponent trigger');
  const misplaced = sanitizeCardBehavior({ v: 1, rules: [{ on: 'cast', tax: 1, steps: [{ op: 'draw', x: n(1) }] }] });
  check(misplaced?.rules[0]?.tax === undefined, 'a tax on your own cast trigger is dropped');
  const big = sanitizeCardBehavior({ v: 1, rules: [{ on: 'oppcast', tax: 40, steps: [{ op: 'draw', x: n(1) }] }] });
  check(big?.rules[0]?.tax === 9, 'a tax is capped at MAX_TAX');
  check(oppSpellFilter(undefined) === 0 && oppSpellFilter('t:creature') === 1 && oppSpellFilter('-t:creature') === 2 && oppSpellFilter('t:instant or t:sorcery') === 2, 'oppSpellFilter reads creature, noncreature, any');
  const edict = sanitizeCardBehavior(behaviors.get(EDICT.oracleId))!;
  check(describeRule(edict.rules[0]!) === 'When you play it: each opponent sacrifices 1 creature', `Edict reads: ${describeRule(edict.rules[0]!)}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== the table leaves a deck that ignores it alone ===');
{
  const strip = (r: SimResult) => JSON.stringify({ ...r, oppSpells: 0, answers: 0 });
  const off = run(deck(), { opponents: 0 });
  const on = run(deck(), { opponents: 3 });
  check(strip(off) === strip(on), 'Forests and Bears: byte-identical with three opponents or none');
  check(off.oppSpells === 0 && on.oppSpells > 0, `opponents cast ${f1(on.oppSpells)} spells a game between them (0 with nobody there)`);
  // Turn one is one spell at most, then 1.5 a turn for seven turns: 11.5 each.
  check(Math.abs(on.oppSpells - 34.5) < 0.6, `three typical opponents cast about 34.5 spells over eight turns (${f1(on.oppSpells)})`);
  const quiet = run(deck(), { opponents: 3, tempo: 'quiet' });
  const busy = run(deck(), { opponents: 3, tempo: 'busy' });
  check(quiet.oppSpells < on.oppSpells && on.oppSpells < busy.oppSpells, `quiet ${f1(quiet.oppSpells)} < typical ${f1(on.oppSpells)} < busy ${f1(busy.oppSpells)}`);
  const one = run(deck(), { opponents: 1 });
  check(Math.abs(one.oppSpells * 3 - on.oppSpells) < 1.5, `one opponent casts a third as much (${f1(one.oppSpells)})`);
}

// ---------------------------------------------------------------------------
console.log('\n=== taxes: Study, Tithe, Sentinel ===');
{
  const plain = run(deck(main(4, BEAR)));
  const study = run(deck(main(4, STUDY)));
  const none = run(deck(main(4, STUDY)), { opponents: 0 });
  check(fires(none, STUDY, 'oppcast') === 0 && seen(none) === seen(plain), 'Study with nobody at the table draws nothing');
  check(fires(study, STUDY, 'oppcast') > 2, `Study fires ${f1(fires(study, STUDY, 'oppcast'))} times a game at the default table`);
  check(seen(study) > seen(plain) + 1, `cards seen by turn 8: ${f1(seen(plain))} without, ${f1(seen(study))} with Study`);
  const rarely = run(deck(main(4, STUDY)), { pay: 'rarely' });
  const usually = run(deck(main(4, STUDY)), { pay: 'usually' });
  const r = fires(rarely, STUDY, 'oppcast');
  const h = fires(study, STUDY, 'oppcast');
  const u = fires(usually, STUDY, 'oppcast');
  check(r > h && h > u, `Study draws more the less they pay: rarely ${f1(r)} > half ${f1(h)} > usually ${f1(u)}`);
  // A {1} tax at 'half' is paid half the time, so the rule fires on half the spells it sees.
  check(Math.abs(r / 0.75 - h / 0.5) < Math.max(0.6, 0.15 * (h / 0.5)), 'the fire counts scale with 1 - pay rate');

  const tithe = run(deck(main(4, TITHE)));
  check(fires(tithe, TITHE, 'oppdraw') > 1, `Tithe makes ${f1(fires(tithe, TITHE, 'oppdraw'))} Treasures a game`);
  const titheRare = run(deck(main(4, TITHE)), { pay: 'rarely' });
  check(fires(titheRare, TITHE, 'oppdraw') > fires(tithe, TITHE, 'oppdraw'), 'a table that rarely pays feeds the Tithe more');
  // Treasures are mana: the deck has more of it by turn 8.
  check((tithe.manaByTurn[8] ?? 0) > (plain.manaByTurn[8] ?? 0) + 0.5, `mana by turn 8: ${f1(plain.manaByTurn[8] ?? 0)} plain, ${f1(tithe.manaByTurn[8] ?? 0)} with Tithe`);

  const sentinel = run(deck(main(4, SENTINEL)));
  const s = fires(sentinel, SENTINEL, 'oppcast');
  check(s > 0.5 && s < 8, `Sentinel, noncreature only and once a round: ${f1(s)} draws a game`);
  check(s < fires(study, STUDY, 'oppcast'), 'and fewer than the Study, which sees every spell');
}

// ---------------------------------------------------------------------------
console.log('\n=== counterspells under the three interaction policies ===');
{
  const rows = deck(main(6, COUNTER));
  const answer = run(rows, { interaction: 'answer' });
  const cast = run(rows, { interaction: 'cast' });
  const hold = run(rows, { interaction: 'hold' });
  check(answer.answers > 0.5, `answer: ${f1(answer.answers)} spells countered a game`);
  check(cast.answers === 0 && hold.answers === 0, 'cast and hold counter nothing');
  let heldCasts = 0;
  for (let s = 0; s < 20; s++) {
    const t = traceGame(buildSimDeck(rows, behaviors), { ...base, interaction: 'hold' }, 300 + s);
    if (t.turns.some((turn) => turn.lines.some((l) => l.kind === 'cast' && l.text.includes('Counter')))) heldCasts++;
  }
  check(heldCasts === 0, 'hold never casts it (twenty traced games)');
  // A countered creature never lands, so the table has fewer creatures to remove.
  const goldfish = run(rows, { interaction: 'answer', opponents: 0 });
  const castfish = run(rows, { interaction: 'cast', opponents: 0 });
  check(JSON.stringify(goldfish) === JSON.stringify(castfish), 'with nobody at the table, answer is cast');
  const trace = traceGame(buildSimDeck(rows, behaviors), { ...base, interaction: 'answer' }, 11);
  const lines = trace.turns.flatMap((t) => t.lines.map((l) => l.text));
  check(lines.some((l) => l.startsWith('Opponent 1 draws')), 'the trace shows the opponents taking their turns');
  console.log('      ' + (lines.find((l) => l.startsWith('Counters Opponent')) ?? '(no counter in this deal)'));
}

// ---------------------------------------------------------------------------
console.log('\n=== removal waits for a creature, then kills one ===');
{
  const rows = deck(main(6, SWORDS), main(4, ARTIST));
  const answer = run(rows, { interaction: 'answer' });
  const none = run(rows, { opponents: 0 });
  check(answer.answers > 1, `answer: ${f1(answer.answers)} creatures removed a game`);
  check(none.answers === 0, 'nothing to remove with nobody there');
  check((answer.damageByTurn[8] ?? 0) > (none.damageByTurn[8] ?? 0), `Artist drains off their creatures dying: ${f1(none.damageByTurn[8] ?? 0)} -> ${f1(answer.damageByTurn[8] ?? 0)} damage`);
  check(fires(answer, ARTIST, 'oppdies') > 0, `oppdies fires ${f1(fires(answer, ARTIST, 'oppdies'))} times a game`);
  // Cast on sight still kills when there is something out, but does not wait for it.
  const cast = run(rows, { interaction: 'cast' });
  check(cast.answers > 0 && cast.answers < answer.answers, `cast on sight removes ${f1(cast.answers)} (less: some Swords go off into nothing)`);
  // A Swords in the opener is never cast on turn one: nobody has a creature yet.
  let early = false;
  let waited = false;
  for (let s = 0; s < 40 && !early; s++) {
    const t = traceGame(buildSimDeck(rows, behaviors), { ...base, interaction: 'answer' }, 100 + s);
    const t1 = t.turns[0]!.lines.map((l) => l.text);
    if (t1.some((l) => l.includes('Swords removes'))) early = true;
    if (t1.some((l) => l.includes('holding 1 answer') || l.includes('holding 2 answers'))) waited = true;
  }
  check(!early && waited, 'under answer a Swords in the opener waits (turn one has no target) and the trace says so');
}

// ---------------------------------------------------------------------------
console.log('\n=== edicts, wheels, arrivals, amounts ===');
{
  const edict = run(deck(main(6, EDICT), main(4, ARTIST)));
  check(fires(edict, ARTIST, 'oppdies') > 0.5, `an edict a turn: Artist sees ${f1(fires(edict, ARTIST, 'oppdies'))} opposing creatures die a game`);
  const edictNone = run(deck(main(6, EDICT), main(4, ARTIST)), { opponents: 0 });
  check(fires(edictNone, ARTIST, 'oppdies') === 0, 'nothing to sacrifice with nobody there');

  const wheelAlone = run(deck(main(4, WHEEL), main(4, BEAR)));
  const wheelShe = run(deck(main(4, WHEEL), main(4, SHEOLDRED)));
  const sheAlone = run(deck(main(4, BEAR), main(4, SHEOLDRED)));
  check((sheAlone.damageByTurn[8] ?? 0) > 5, `Sheoldred drains off their draw steps: ${f1(sheAlone.damageByTurn[8] ?? 0)} damage by turn 8`);
  check((wheelShe.damageByTurn[8] ?? 0) > (sheAlone.damageByTurn[8] ?? 0) + 1, `and more with a wheel in the deck: ${f1(wheelShe.damageByTurn[8] ?? 0)}`);
  check((wheelAlone.damageByTurn[8] ?? 0) === 0, 'a wheel alone deals nothing');

  const priest = run(deck(main(4, PRIEST)));
  const priestNone = run(deck(main(4, PRIEST)), { opponents: 0 });
  check((priest.damageByTurn[8] ?? 0) > 2 && (priestNone.damageByTurn[8] ?? 0) === 0, `Priest pings arrivals: ${f1(priest.damageByTurn[8] ?? 0)} damage by turn 8, 0 with nobody there`);

  const tally = run(deck(main(4, TALLY)));
  const tallyNone = run(deck(main(4, TALLY)), { opponents: 0 });
  const tallyBlank = run(deck(main(4, BEAR)));
  check(seen(tally) > seen(tallyBlank) + 1.5 && Math.abs(seen(tallyNone) - seen(tallyBlank)) < 0.3, `"draw X, X = your opponents": ${f1(seen(tally))} seen with three, ${f1(seen(tallyNone))} with none, ${f1(seen(tallyBlank))} blank`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('the table model', () => {
  expect(failures).toBe(0);
});
