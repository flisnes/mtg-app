import { expect, test } from 'vitest';
// Rebuild plan §6 step 6: the cheap grammar batch. Each item is one small
// rule the color reviewers kept re-inventing; each gets one check that the
// sanitizer keeps it, the compiler reads it and the sequencer does it.
//
//   npx vitest run sim/test/grammar6-sim.test.ts
import { MANA_TAPPED, type OracleCard } from '../../shared/src/card.js';
import { compileBehavior, describeBehavior, sanitizeCardBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import { buildSimDeck, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, traceGame, type SimOptions } from '../src/simulate.js';

let seq = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${seq++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{G}',
    oracleText: o.oracleText ?? null,
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;
const land = (name: string, color: string, adds = 1, tapped = false, typeLine = 'Land') =>
  card({ name, typeLine, cmc: 0, manaCost: '', produces: color, mana: [0, adds, tapped ? MANA_TAPPED : 0] });
const FOREST = land('Forest', 'G', 1, false, 'Basic Land — Forest');
const BEAR = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2' });
const BOLT = card({ name: 'Bolt', typeLine: 'Instant', manaCost: '{G}', cmc: 1 });

const base: SimOptions = { ...defaultSimOptions('commander', true), games: 1000, mulligan: false, combat: 'all' };
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
const run = (rows: DeckRow[], behaviors?: Map<string, CardBehavior>, opts: Partial<SimOptions> = {}) => simulate(buildSimDeck(rows, behaviors), { ...base, ...opts });
const lines = (rows: DeckRow[], behaviors: Map<string, CardBehavior> | undefined, seed: number) =>
  traceGame(buildSimDeck(rows, behaviors), { ...base, trace: true }, seed).turns.flatMap((t) => t.lines.map((l) => ({ turn: t.turn, text: l.text })));
const rules = (o: OracleCard, b: CardBehavior) => new Map<string, CardBehavior>([[o.oracleId, b]]);
const shape = (b: unknown) => JSON.stringify(b);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
console.log('\n=== the sanitizer keeps the new fields ===');
{
  const b: CardBehavior = {
    v: 1,
    rules: [
      { on: 'cast', q: '-t:creature', steps: [{ op: 'pump', x: { kind: 'fixed', n: 1 }, own: true }] },
      { on: 'etb', oneshot: true, steps: [{ op: 'pump', x: { kind: 'fixed', n: 2 }, po: true }] },
      { on: 'activate', cost: { tap: true }, steps: [{ op: 'pump', x: { kind: 'fixed', n: 1 }, q: 't:elf' }, { op: 'keyword', x: { kind: 'fixed', n: 1 }, kw: 'H', q: 't:elf' }] },
      { on: 'lifegain', steps: [{ op: 'counter', x: { kind: 'fixed', n: 1 }, ck: 'p1p1', each: true, q: 't:creature' }] },
      { on: 'static', cond: { x: { kind: 'life' }, op: '>=', n: 30 }, steps: [{ op: 'pump', x: { kind: 'fixed', n: 5 }, own: true }] },
      { on: 'combat', steps: [{ op: 'token', x: { kind: 'fixed', n: 1 }, tk: 'soldier', attacking: true }] },
      { on: 'static', steps: [{ op: 'discount', x: { kind: 'fixed', n: 1 }, q: 'c:w' }] },
    ],
  };
  const clean = sanitizeCardBehavior(JSON.parse(shape(b)));
  check(shape(clean) === shape(b), `saves unchanged\n    wrote ${shape(b)}\n    saved ${shape(clean)}`);
  const compiled = compileBehavior(clean);
  check(!!compiled && compiled.lifegain.length === 1 && compiled.combat.length === 1 && compiled.statics.length === 2 && !!compiled.statics[0]!.cond, 'compiles with the new buckets and a condition on the static');
  check(compiled!.etb[0]!.op === 'gate' && (compiled!.etb[0] as { oneshot?: true }).oneshot === true, 'the one-shot rides as a gate');
  for (const line of describeBehavior(clean)) console.log(`    ${line}`);
  const said = describeBehavior(clean).join(' | ');
  check(/this card gets \+1\/\+1 until end of turn/.test(said) && /get \+2\/\+0/.test(said) && /only the first time each game/.test(said), 'reads as written: own pump, +X/+0, the one-shot');
  check(/on each creature you control matching t:creature/.test(said) && /tapped and attacking/.test(said) && /spells matching c:w cost 1 less/.test(said), 'counters on each, attacking tokens, the discount');
  // The poison step, on its own.
  const poison = sanitizeCardBehavior({ v: 1, rules: [{ on: 'attack', steps: [{ op: 'poison', x: { kind: 'fixed', n: 2 } }] }] });
  check(!!poison && poison.rules[0]!.steps[0]!.op === 'poison', 'poison is a step');
}

// ---------------------------------------------------------------------------
console.log('\n=== prowess: `own` on pump, and +X/+0 ===');
{
  // A 2/2 commander with prowess: each noncreature spell is +1/+1 until end
  // of turn. In a deck of {G} bolts cast before combat, its swing on a turn is
  // 2 + the bolts cast that turn.
  const MONK = card({ name: 'Monk', typeLine: 'Creature — Monk', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2' });
  const prowess = rules(MONK, { v: 1, rules: [{ on: 'cast', q: '-t:creature', steps: [{ op: 'pump', x: { kind: 'fixed', n: 1 }, own: true }] }] });
  const trace = lines([main(60, FOREST), main(39, BOLT), cmd(MONK)], prowess, 3);
  const monkTurn = trace.find((l) => l.text.startsWith('Casts Monk'))?.turn ?? 99;
  let okTurns = 0;
  let turns = 0;
  for (let t = monkTurn + 1; t <= 8; t++) {
    const bolts = trace.filter((l) => l.turn === t && l.text.startsWith('Casts Bolt')).length;
    const swing = trace.find((l) => l.turn === t && l.text.startsWith('Attacks with'));
    if (!swing) continue;
    turns++;
    if (Number(/for (\d+)/.exec(swing.text)?.[1]) === 2 + bolts) okTurns++;
  }
  check(turns > 0 && okTurns === turns, `the Monk swings for 2 plus the bolts cast that turn (${okTurns} of ${turns} turns)`);
  check(trace.some((l) => /Monk gets \+1\/\+1/.test(l.text)), 'the trace says "Monk gets +1/+1"');

  // +X/+0 on a static: bears with a "+2/+0" anthem in the command zone.
  const BANNER = card({ name: 'Banner', typeLine: 'Enchantment', manaCost: '{1}{G}', cmc: 2 });
  const anthem = rules(BANNER, { v: 1, rules: [{ on: 'static', q: 't:creature', steps: [{ op: 'pump', x: { kind: 'fixed', n: 2 }, po: true }] }] });
  const t2 = lines([main(50, FOREST), main(49, BEAR), cmd(BANNER)], anthem, 5);
  const bannerTurn = t2.find((l) => l.text.startsWith('Casts Banner'))?.turn ?? 99;
  const swings = t2.filter((l) => l.turn > bannerTurn && l.text.startsWith('Attacks with'));
  const ok = swings.every((l) => {
    const m = /Attacks with (\d+) creatures? for (\d+)/.exec(l.text)!;
    return Number(m[2]) === 4 * Number(m[1]);
  });
  check(swings.length > 0 && ok, `under a +2/+0 anthem every bear swings for 4 (${swings.length} attacks)`);
  const with2 = run([main(50, FOREST), main(49, BEAR), cmd(BANNER)], anthem);
  const plus2 = rules(BANNER, { v: 1, rules: [{ on: 'static', q: 't:creature', steps: [{ op: 'pump', x: { kind: 'fixed', n: 2 } }] }] });
  const both = run([main(50, FOREST), main(49, BEAR), cmd(BANNER)], plus2);
  check(Math.abs(with2.combatDamageByTurn[8]! - both.combatDamageByTurn[8]!) < 0.01, `+2/+0 and +2/+2 deal the same combat damage (${with2.combatDamageByTurn[8]!.toFixed(2)}): nothing here reads toughness`);
}

// ---------------------------------------------------------------------------
console.log('\n=== `q` on a pump inside an ability ===');
{
  // {T}: Elves get +1/+1. Sanitized with the criteria kept, so bears are not pumped.
  const LORD = card({ name: 'Lord', typeLine: 'Creature — Elf', manaCost: '{1}{G}', cmc: 2, power: '1', toughness: '1' });
  const ELF = card({ name: 'Elf', typeLine: 'Creature — Elf', manaCost: '{1}{G}', cmc: 2, power: '1', toughness: '1' });
  const b = rules(LORD, { v: 1, rules: [{ on: 'activate', cost: { tap: true }, steps: [{ op: 'pump', x: { kind: 'fixed', n: 1 }, q: 't:elf' }] }] });
  const clean = sanitizeCardBehavior(JSON.parse(shape(b.get(LORD.oracleId))));
  check(clean?.rules[0]?.steps[0]?.q === 't:elf', 'the criteria survives the sanitizer on an ability');
  const trace = lines([main(50, FOREST), main(25, ELF), main(24, BEAR), cmd(LORD)], b, 2);
  const pumped = trace.filter((l) => /Lord gives \d+ creatures? \+1\/\+1/.test(l.text));
  check(pumped.length > 0, `the ability fires (${pumped.length} times in one game)`);
  // The pump reaches only the Elves: never more than the Elves on the board
  // plus the Lord itself (an Elf too).
  const deck = buildSimDeck([main(50, FOREST), main(25, ELF), main(24, BEAR), cmd(LORD)], b);
  const t = traceGame(deck, { ...base, trace: true }, 2);
  let ok = true;
  for (const turn of t.turns) {
    const elves = turn.board.permanents.filter((p) => /Elf|Lord/.test(deck.cards[p.card]!.name)).reduce((s, p) => s + p.count, 0);
    for (const l of turn.lines) {
      const m = /Lord gives (\d+) creatures? \+1\/\+1/.exec(l.text);
      if (m && Number(m[1]) > elves) ok = false;
    }
  }
  check(ok, 'and never reaches more creatures than there are Elves');
}

// ---------------------------------------------------------------------------
console.log('\n=== counters on each creature, and "what woke it" off a watched rule ===');
{
  // Archangel of Thune, written out: whenever you gain life, a +1/+1 counter
  // on each creature you control. A Food in the deck... simpler: an end-step
  // rule gaining 1 life on the same card. Each end step: +1/+1 on every creature.
  const ANGEL = card({ name: 'Angel', typeLine: 'Creature — Angel', manaCost: '{3}{G}{G}', cmc: 5, power: '3', toughness: '4' });
  const b = rules(ANGEL, {
    v: 1,
    rules: [
      { on: 'endstep', steps: [{ op: 'gainlife', x: { kind: 'fixed', n: 1 } }] },
      { on: 'lifegain', steps: [{ op: 'counter', x: { kind: 'fixed', n: 1 }, ck: 'p1p1', each: true }] },
    ],
  });
  const trace = lines([main(50, FOREST), main(49, BEAR), cmd(ANGEL)], b, 6);
  const angelTurn = trace.find((l) => l.text.startsWith('Casts Angel'))?.turn ?? 99;
  const counters = trace.filter((l) => /Angel puts 1 \+1\/\+1 counter on \d+ creatures?/.test(l.text));
  check(counters.length > 0, `the counters go on every creature (${counters.length} end steps)`);
  // The turn after the Angel lands, every bear out since before swings one bigger.
  const swings = trace.filter((l) => l.turn > angelTurn + 1 && l.text.startsWith('Attacks with'));
  check(swings.length > 0 && swings.every((l) => Number(/for (\d+)/.exec(l.text)?.[1]) > 2 * Number(/with (\d+)/.exec(l.text)?.[1])), `attacks after that are bigger than 2 a bear (${swings.length} attacks)`);

  // "What woke it" on an enters rule: a 3/3 entering deals 3 (Warstorm Surge).
  const SURGE = card({ name: 'Surge', typeLine: 'Enchantment', manaCost: '{1}{G}', cmc: 2 });
  const OX = card({ name: 'Ox', typeLine: 'Creature — Ox', manaCost: '{2}{G}', cmc: 3, power: '3', toughness: '3' });
  const surge = rules(SURGE, { v: 1, rules: [{ on: 'enters', q: 't:creature', steps: [{ op: 'damage', x: { kind: 'cause' } }] }] });
  const t2 = lines([main(50, FOREST), main(49, OX), cmd(SURGE)], surge, 8);
  const hits = t2.filter((l) => /Surge deals (\d+) damage/.test(l.text));
  check(hits.length > 0 && hits.every((l) => /deals 3 damage/.test(l.text)), `each Ox entering deals its power, 3 (${hits.length} times)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== a condition on a static: Serra Ascendant ===');
{
  // +5/+5 while life is 30 or more. In Commander (40 life) it is on from the
  // start; with a rule bleeding 11 life at its own entry it is off.
  const SERRA = card({ name: 'Serra', typeLine: 'Creature — Human Monk', manaCost: '{W}', cmc: 1, power: '1', toughness: '1' });
  const FOREST_W = land('Plains', 'W', 1, false, 'Basic Land — Plains');
  const on = rules(SERRA, { v: 1, rules: [{ on: 'static', cond: { x: { kind: 'life' }, op: '>=', n: 30 }, steps: [{ op: 'pump', x: { kind: 'fixed', n: 5 }, own: true }] }] });
  const t1 = lines([main(60, FOREST_W), main(39, BEAR), cmd(SERRA)], on, 3);
  const swing = t1.find((l) => l.turn === 2 && l.text.startsWith('Attacks with'));
  check(!!swing && /Attacks with 1 creature for 6/.test(swing.text), `at 40 life Serra swings for 6 on turn 2: ${swing?.text ?? '(no attack)'}`);
  const off = rules(SERRA, {
    v: 1,
    rules: [
      { on: 'etb', steps: [{ op: 'loselife', x: { kind: 'fixed', n: 11 } }] },
      { on: 'static', cond: { x: { kind: 'life' }, op: '>=', n: 30 }, steps: [{ op: 'pump', x: { kind: 'fixed', n: 5 }, own: true }] },
    ],
  });
  const t2 = lines([main(60, FOREST_W), main(39, BEAR), cmd(SERRA)], off, 3);
  const swing2 = t2.find((l) => l.turn === 2 && l.text.startsWith('Attacks with'));
  check(!!swing2 && /Attacks with 1 creature for 1\b/.test(swing2.text), `at 29 life it is a 1/1: ${swing2?.text ?? '(no attack)'}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== beginning of combat, and tokens entering attacking ===');
{
  // At the beginning of combat, make a 1/1 Soldier tapped and attacking: it
  // is tapped (so it does not attack) the turn it is made, and attacks the
  // turn after. Made outside the attack, "attacking" is only tapped.
  const CAPTAIN = card({ name: 'Captain', typeLine: 'Creature — Human', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2' });
  const b = rules(CAPTAIN, { v: 1, rules: [{ on: 'combat', steps: [{ op: 'token', x: { kind: 'fixed', n: 1 }, tk: 'soldier', attacking: true }] }] });
  const trace = lines([main(60, FOREST), main(39, BEAR), cmd(CAPTAIN)], b, 4);
  const made = trace.filter((l) => /^Beginning of combat: Captain creates 1 Soldier/.test(l.text));
  check(made.length > 0, `the combat trigger fires every turn from the one it lands (${made.length} times)`);
  const captainTurn = trace.find((l) => l.text.startsWith('Casts Captain'))?.turn ?? 99;
  const result = run([main(60, FOREST), main(39, BEAR), cmd(CAPTAIN)], b);
  const plain = run([main(60, FOREST), main(39, BEAR), cmd(card({ name: 'Vanilla', typeLine: 'Creature — Human', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2' }))]);
  check(result.combatDamageByTurn[8]! > plain.combatDamageByTurn[8]! + 4, `the Soldiers add up: ${result.combatDamageByTurn[8]!.toFixed(2)} vs ${plain.combatDamageByTurn[8]!.toFixed(2)} by turn 8`);
  void captainTurn;

  // An attack trigger making attacking tokens: they hit this combat.
  const WARLORD = card({ name: 'Warlord', typeLine: 'Creature — Human', manaCost: '{1}{G}', cmc: 2, power: '2', toughness: '2' });
  const w = rules(WARLORD, { v: 1, rules: [{ on: 'attack', steps: [{ op: 'token', x: { kind: 'fixed', n: 2 }, tk: 'soldier', attacking: true }] }] });
  const t2 = lines([main(60, FOREST), main(39, BEAR), cmd(WARLORD)], w, 4);
  const warlordTurn = t2.find((l) => l.text.startsWith('Casts Warlord'))?.turn ?? 99;
  const first = t2.find((l) => l.turn === warlordTurn + 1 && /Attacks with Warlord: creates 2 Soldiers, attacking/.test(l.text));
  check(!!first, `the attack trigger makes them attacking: ${first?.text ?? '(missing)'}`);
  const g = traceGame(buildSimDeck([main(60, FOREST), main(39, BEAR), cmd(WARLORD)], w), { ...base, trace: true }, 4);
  const turn = g.turns.find((t) => t.turn === warlordTurn + 1);
  const declared = Number(/Attacks with \d+ creatures? for (\d+)/.exec(turn?.lines.find((l) => l.text.startsWith('Attacks with'))?.text ?? '')?.[1] ?? 0);
  check(!!turn && turn.damage === declared + 2, `that turn's damage is the declared attack plus the two Soldiers: ${turn?.damage} = ${declared} + 2`);
}

// ---------------------------------------------------------------------------
console.log('\n=== once each game ===');
{
  // A Saga written plainly: when it enters, draw 2, only the first time each game.
  const SAGA = card({ name: 'Saga', typeLine: 'Enchantment — Saga', manaCost: '{1}{G}', cmc: 2 });
  const once = rules(SAGA, { v: 1, rules: [{ on: 'upkeep', oneshot: true, steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] });
  const every = rules(SAGA, { v: 1, rules: [{ on: 'upkeep', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] });
  const a = run([main(60, FOREST), main(39, BEAR), cmd(SAGA)], once);
  const b = run([main(60, FOREST), main(39, BEAR), cmd(SAGA)], every);
  const onceFires = a.fires.find((f) => f.oracleId === SAGA.oracleId)!;
  const everyFires = b.fires.find((f) => f.oracleId === SAGA.oracleId)!;
  check(onceFires.perGame <= 1 && onceFires.games > 0.9, `one-shot: fires ${onceFires.perGame.toFixed(2)} times a game in ${(onceFires.games * 100).toFixed(0)}% of games`);
  check(everyFires.perGame > 3, `without the flag the same rule fires ${everyFires.perGame.toFixed(2)} times a game`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('grammar6-sim: every check passes', () => {
  expect(failures).toBe(0);
});
