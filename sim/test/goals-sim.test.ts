import { expect, test } from 'vitest';
// Rebuild plan E1 (goals), E2 (searches go for the plan's missing piece),
// §6 step 5 (a look at the top N) and D2 (the speed signal on the bracket).
//
//   npx vitest run sim/test/goals-sim.test.ts
import type { OracleCard } from '../../shared/src/card.js';
import type { CardBehavior } from '../../shared/src/behavior.js';
import { bracketReport, bracketSpeed } from '../src/bracket.js';
import type { SimGoal } from '../src/goals.js';
import { buildSimDeck, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, traceGame, type SimResult } from '../src/simulate.js';

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
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
const noTags = () => null;

const FOREST = card({ name: 'Forest', typeLine: 'Basic Land — Forest', cmc: 0, manaCost: '', produces: 'G', mana: [0, 1, 0] });
const BEAR = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', power: '2', toughness: '2' });
const DRAGON = card({ name: 'Big Dragon', typeLine: 'Creature — Dragon', manaCost: '{3}{G}{G}', cmc: 5, power: '5', toughness: '5' });
const GOBLIN = card({ name: 'Goblin', typeLine: 'Creature — Goblin', manaCost: '{G}', cmc: 1, power: '1', toughness: '1' });
const BLANK = card({ name: 'Blank', typeLine: 'Sorcery', manaCost: '{2}{G}', cmc: 3 });
const TUTOR = card({ name: 'Creature Tutor', typeLine: 'Sorcery', manaCost: '{1}{G}', cmc: 2 });
const MUXUS = card({ name: 'Muxus', typeLine: 'Legendary Creature — Goblin Noble', manaCost: '{2}{G}{G}', cmc: 4, power: '4', toughness: '4' });
/** A commander of its own: a commander that is also in the 99 is (correctly) not one. */
const CMDR = card({ name: 'Bear Commander', typeLine: 'Legendary Creature — Bear', power: '2', toughness: '2' });
const HASTY = card({ name: 'Hasty Giant', typeLine: 'Creature — Giant', manaCost: '{G}', cmc: 1, power: '8', toughness: '8', oracleText: 'Haste' });

const GAMES = 6000;
const opts = { ...defaultSimOptions('commander', true), games: GAMES };
const tutorRule: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'hand', q: 't:creature' }] }] };
const muxusRule = (win: number | undefined, rest?: 'graveyard'): CardBehavior => ({
  v: 1,
  rules: [{ on: 'etb', steps: [{ op: 'move', x: { kind: 'all' }, from: 'library', to: 'battlefield', q: 't:goblin', ...(win ? { win } : {}), ...(rest ? { rest } : {}) }] }],
});

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};
const p = (x: number) => `${(x * 100).toFixed(1)}%`;
const monotone = (xs: number[]) => xs.every((v, i) => i === 0 || v + 1e-12 >= xs[i - 1]!);
const goalOf = (r: SimResult, id: string) => r.goals.find((g) => g.id === id)!;

// ---------------------------------------------------------------------------
console.log('\n=== goals on a plain deck ===');
{
  const rows = [main(38, FOREST), main(61, BEAR), cmd(CMDR)];
  const goals: SimGoal[] = [
    { id: 'lands4', turn: 4, terms: [{ kind: 'inPlay', n: 4, q: 't:land' }] },
    { id: 'mana4', turn: 4, terms: [{ kind: 'mana', n: 4 }] },
    { id: 'bear2', turn: 2, terms: [{ kind: 'cast', n: 1, q: 't:creature' }] },
    { id: 'cmdr2', turn: 4, terms: [{ kind: 'commander', n: 1 }] },
    { id: 'land1', turn: 1, terms: [{ kind: 'have', n: 1, q: 't:land' }] },
    { id: 'seen10', turn: 8, terms: [{ kind: 'drawn', n: 10, q: 't:creature' }] },
    { id: 'both4', turn: 4, terms: [{ kind: 'inPlay', n: 4, q: 't:land' }, { kind: 'cast', n: 1, q: 't:creature' }] },
    { id: 'bear4', turn: 4, terms: [{ kind: 'cast', n: 1, q: 't:creature' }] },
  ];
  const plain = simulate(buildSimDeck(rows), opts);
  const r = simulate(buildSimDeck(rows, undefined, undefined, undefined, undefined, goals), opts);
  check(r.goals.length === goals.length, `${r.goals.length} goal results`);
  for (const g of r.goals) {
    check(monotone(g.byTurn.slice(1)) && g.byTurn.every((v) => v >= 0 && v <= 1 + 1e-12), `${g.id}: by-turn climbs and stays in [0, 1] (${g.byTurn.slice(1).map(p).join(' ')})`);
  }
  const lands4 = goalOf(r, 'lands4');
  const mana4 = goalOf(r, 'mana4');
  check(lands4.p > 0.6, `four lands on the battlefield by turn 4: ${p(lands4.p)}`);
  check(Math.abs(lands4.p - mana4.p) < 0.03, `four mana by turn 4 reads the same, Forests being the only mana: ${p(mana4.p)}`);
  check(goalOf(r, 'bear2').p > 0.5, `a creature cast by turn 2: ${p(goalOf(r, 'bear2').p)}`);
  check(goalOf(r, 'cmdr2').p > 0.5, `the two-drop commander cast by turn 4 (a coin flip against the other two-drops each turn): ${p(goalOf(r, 'cmdr2').p)}`);
  check(goalOf(r, 'land1').p > 0.6, `a land still in hand after the turn-one drop: ${p(goalOf(r, 'land1').p)}`);
  const seen = goalOf(r, 'seen10');
  check(seen.p > 0.02 && seen.p < 0.8, `ten creatures seen by turn 8: ${p(seen.p)}`);
  const both = goalOf(r, 'both4');
  check(both.p <= lands4.p + 1e-9 && both.p <= goalOf(r, 'bear4').p + 1e-9, `the conjunction is under both of its parts: ${p(both.p)} <= ${p(lands4.p)}, ${p(goalOf(r, 'bear4').p)}`);
  check(
    JSON.stringify(plain.manaByTurn) === JSON.stringify(r.manaByTurn) && JSON.stringify(plain.cardsSeenByTurn) === JSON.stringify(r.cardsSeenByTurn),
    'goals alone move nothing else: mana and cards seen are byte-identical to the run without them',
  );
  check(plain.goals.length === 0 && monotone(plain.lethalByTurn.slice(1)), 'no goals: an empty list; lethal-by-turn climbs');
}

// ---------------------------------------------------------------------------
console.log('\n=== E2: a search goes for the plan\'s missing piece ===');
{
  const rows = [main(38, FOREST), main(1, DRAGON), main(55, BEAR), main(5, TUTOR), cmd(CMDR)];
  const behaviors = new Map([[TUTOR.oracleId, tutorRule]]);
  const goals: SimGoal[] = [{ id: 'dragon', turn: 8, terms: [{ kind: 'cast', n: 1, q: 't:dragon' }] }];
  const without = simulate(buildSimDeck(rows, behaviors), opts);
  const withGoal = simulate(buildSimDeck(rows, behaviors, undefined, undefined, undefined, goals), opts);
  const dragonCast = (r: SimResult) => r.cards.find((c) => c.name === DRAGON.name)!.castByTurn[8]!;
  console.log(`  Dragon cast by turn 8: ${p(dragonCast(without))} with random tutors, ${p(dragonCast(withGoal))} with the goal`);
  check(dragonCast(withGoal) > dragonCast(without) + 0.1, 'the tutors fetch the Dragon once the plan asks for it');
  check(goalOf(withGoal, 'dragon').p > 0.3, `the goal itself: ${p(goalOf(withGoal, 'dragon').p)}`);
  // A goal the tutor cannot help (lands) listed first does not stop it helping the next one.
  const landsFirst: SimGoal[] = [{ id: 'lands', turn: 4, terms: [{ kind: 'inPlay', n: 4, q: 't:land' }] }, ...goals];
  const second = simulate(buildSimDeck(rows, behaviors, undefined, undefined, undefined, landsFirst), opts);
  check(Math.abs(dragonCast(second) - dragonCast(withGoal)) < 0.03, `with "four lands" listed first the tutors still fetch the Dragon: ${p(dragonCast(second))}`);
  // A tutor that cannot find it (lands only) leaves the plan alone.
  const landTutor: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'hand', q: 't:land' }] }] };
  const landOnly = simulate(buildSimDeck(rows, new Map([[TUTOR.oracleId, landTutor]]), undefined, undefined, undefined, goals), opts);
  const landPlain = simulate(buildSimDeck(rows, new Map([[TUTOR.oracleId, landTutor]])), opts);
  check(Math.abs(dragonCast(landOnly) - dragonCast(landPlain)) < 0.03, `a land tutor stays within its criteria: ${p(dragonCast(landOnly))} vs ${p(dragonCast(landPlain))}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== §6 step 5: a look at the top N ===');
{
  const rows = [main(38, FOREST), main(20, GOBLIN), main(37, BLANK), main(4, MUXUS), cmd(CMDR)];
  const goals: SimGoal[] = [{ id: 'gobs', turn: 8, terms: [{ kind: 'inPlay', n: 6, q: 't:goblin' }] }];
  const full = simulate(buildSimDeck(rows, new Map([[MUXUS.oracleId, muxusRule(undefined)]]), undefined, undefined, undefined, goals), opts);
  const six = simulate(buildSimDeck(rows, new Map([[MUXUS.oracleId, muxusRule(6)]]), undefined, undefined, undefined, goals), opts);
  const muxusCast = full.cards.find((c) => c.name === MUXUS.name)!.castByTurn[8]!;
  console.log(`  Muxus cast by turn 8 in ${p(muxusCast)} of games; six Goblins out by turn 8: ${p(goalOf(full, 'gobs').p)} searching, ${p(goalOf(six, 'gobs').p)} looking at six`);
  check(goalOf(full, 'gobs').p > goalOf(six, 'gobs').p + 0.05, 'a look at six puts far fewer Goblins out than a search of the library');
  check(goalOf(six, 'gobs').p >= 0, 'and still some');
  // The trace says what it looked at, and where the rest went.
  const deckSix = buildSimDeck(rows, new Map([[MUXUS.oracleId, muxusRule(6)]]));
  const deckYard = buildSimDeck(rows, new Map([[MUXUS.oracleId, muxusRule(6, 'graveyard')]]));
  let looked = '';
  let yardAfter = -1;
  for (let seed = 1; seed < 200 && !looked; seed++) {
    const g = traceGame(deckSix, opts, seed);
    for (const t of g.turns) {
      const line = t.lines.find((l) => l.text.includes('looks at the top 6'));
      if (line) {
        looked = line.text;
        break;
      }
    }
    if (looked) {
      const y = traceGame(deckYard, opts, seed);
      const turn = y.turns.find((t) => t.lines.some((l) => l.text.includes('looks at the top 6')));
      yardAfter = turn ? turn.board.graveyard.reduce((s, pile) => s + pile.count, 0) : -1;
    }
  }
  console.log(`  trace: ${looked}`);
  check(looked.includes('the rest on the bottom') || looked.includes('all of them on the bottom'), 'the trace names the look and where the rest went');
  check(yardAfter >= 4, `with "the rest into the graveyard" the yard holds them after the look: ${yardAfter} cards`);
}

// ---------------------------------------------------------------------------
console.log('\n=== D2: the speed signal ===');
{
  const fast = simulate(buildSimDeck([main(30, FOREST), main(69, HASTY), cmd(CMDR)]), { ...opts, combat: 'all' });
  const slow = simulate(buildSimDeck([main(38, FOREST), main(61, BEAR), cmd(CMDR)]), { ...opts, combat: 'none' });
  console.log(`  fast deck, dead by turn: ${fast.lethalByTurn.slice(1).map(p).join(' ')}`);
  check(monotone(fast.lethalByTurn.slice(1)), 'lethal-by-turn climbs');
  check(fast.lethalByTurn[5]! >= 0.5, `hasty 8/8s for one: an opponent dead by turn 5 in ${p(fast.lethalByTurn[5]!)} of games`);
  check(slow.lethalByTurn[8]! === 0, 'nobody attacking, nobody dies');
  const fastSpeed = bracketSpeed(fast);
  const slowSpeed = bracketSpeed(slow);
  check(fastSpeed.level === 4 && fastSpeed.halfTurn !== null && fastSpeed.halfTurn <= 5, `the clock reads Bracket ${fastSpeed.level}, half the games by turn ${fastSpeed.halfTurn}`);
  check(slowSpeed.level === null && slowSpeed.halfTurn === null, 'the slow deck says nothing');
  const rows = [main(30, FOREST), main(69, HASTY), cmd(CMDR)];
  const withClock = bracketReport(rows, noTags, fastSpeed);
  const cards = bracketReport(rows, noTags, null);
  check(cards.level.id === 2 && withClock.level.id === 4 && withClock.cardLevel.id === 2, `cards alone Bracket ${cards.level.id}; with the clock Bracket ${withClock.level.id}`);
  check(/goldfish kill by turn 5/.test(withClock.reasons.join()), `reason: ${withClock.reasons.join(' and ')}`);
  const slowReport = bracketReport([main(38, FOREST), main(61, BEAR), cmd(CMDR)], noTags, slowSpeed);
  check(slowReport.level.id === 2 && slowReport.reasons.length === 0, 'a slow deck with nothing flagged stays Core');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);

test('goals-sim: every check passes', () => {
  expect(failures).toBe(0);
});
