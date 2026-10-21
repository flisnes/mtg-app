import { expect, test } from 'vitest';
// v0.175.0, played through the real simulator: tokens picked by name out of
// the card database, and a static that lets cards in a zone be cast (Six's
// retrace, a Future Sight), plus the land drop preferring the graveyard.
// Ported from notes/checks/grants-sim.ts (G0); the cards and the two named
// tokens come from fixtures/rigCards.json.
//
//   npx vitest run sim/test/grants-sim.test.ts
import { describeBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import { PREWRITTEN } from '../src/behaviorTemplates.js';
import type { DeckRow } from '../src/simDeck.js';
import { simulate, type SimResult } from '../src/simulate.js';
import { b, cmd, count, deckWith, gamesLines, rigOpts, rows } from './fixtures/rigCards.js';

const opts = rigOpts();
const f = (xs: number[], t: number) => (xs[t] ?? 0).toFixed(2);
const run = (r: DeckRow[], m: Record<string, CardBehavior> = {}, o: Partial<typeof opts> = {}, withTokens = true): SimResult =>
  simulate(deckWith(r, m, withTokens), { ...opts, ...o });
const lines = (r: DeckRow[], m: Record<string, CardBehavior>, games: number, o: Partial<typeof opts> = {}) => gamesLines(deckWith(r, m), { ...opts, ...o }, games);
let failed = 0;
const check = (ok: boolean, what: string, got: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}  ${got}`);
};
const one = { kind: 'fixed', n: 1 };

// 1. Overlord of the Hauntwoods makes Everywhere, a land token that taps for
//    any color. In a mono-Forest deck full of blue spells, only the token can
//    pay for {U}, so every Island-less blue cast is the token's doing.
{
  const deck = [...rows([40, 'Forest'], [59, 'Counterspell']), cmd('Overlord of the Hauntwoods')];
  const overlord = PREWRITTEN['Overlord of the Hauntwoods']!;
  console.log(`   ${describeBehavior(overlord).join('; ')}`);
  const without = run(deck, {}, { combat: 'all' });
  const withIt = run(deck, { 'Overlord of the Hauntwoods': overlord }, { combat: 'all' });
  const noTokens = run(deck, { 'Overlord of the Hauntwoods': overlord }, { combat: 'all' }, false);
  check(withIt.manaByTurn[8]! > without.manaByTurn[8]! + 0.3, '1a. Everywhere adds mana', `mana t8 ${f(without.manaByTurn, 8)} -> ${f(withIt.manaByTurn, 8)}`);
  const g = lines(deck, { 'Overlord of the Hauntwoods': overlord }, 30, { combat: 'all' });
  const made = count(g, /creates 1 Everywhere/);
  const counters = count(g, /Casts Counterspell/);
  check(made > 0 && counters > 0, '1b. Everywhere pays for {U} in a deck with no Island', `${made} Everywheres, ${counters} Counterspells in 30 games`);
  check(
    Math.abs(noTokens.manaByTurn[8]! - without.manaByTurn[8]!) < 0.05,
    '1c. a token that has not loaded makes nothing (floor)',
    `mana t8 ${f(without.manaByTurn, 8)} vs ${f(noTokens.manaByTurn, 8)}`,
  );
}

// 2. Mole Man: landfall makes a Moloid, a 1/1 creature. Under combat `all` the
//    Moloids swing, so damage goes up; and a Moloid is a creature, so a
//    t:creature watcher wakes for it.
{
  const deck = [...rows([45, 'Forest'], [54, 'Wood Elves']), cmd('Mole Man, Moloid Master')];
  const mole = PREWRITTEN['Mole Man, Moloid Master']!;
  const plain = b({ v: 1, rules: [mole.rules[0]] });
  const a = run(deck, { 'Mole Man, Moloid Master': plain }, { combat: 'all' });
  const z = run(deck, { 'Mole Man, Moloid Master': mole }, { combat: 'all' });
  check(z.damageByTurn[8]! > a.damageByTurn[8]! + 0.3, '2a. Moloids attack', `dmg t8 ${f(a.damageByTurn, 8)} -> ${f(z.damageByTurn, 8)}`);
  const g = lines(deck, { 'Mole Man, Moloid Master': mole }, 20, { combat: 'all' });
  check(count(g, /creates 1 Moloid/) > 0, '2b. the trace names the token', `${count(g, /creates 1 Moloid/)} Moloids in 20 games`);
}

// 3. The land drop prefers the graveyard while Mole Man lets it play from
//    there: an untapped Forest in hand and one in the yard, the yard's goes.
{
  // Bears that mill three as they enter, so Forests reach the graveyard.
  const deck = [...rows([45, 'Forest'], [54, 'Grizzly Bears']), cmd('Mole Man, Moloid Master')];
  const mill3 = b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'mill', x: { kind: 'fixed', n: 3 } }] }] });
  const mole = { 'Mole Man, Moloid Master': PREWRITTEN['Mole Man, Moloid Master']!, 'Grizzly Bears': mill3 };
  const g = lines(deck, mole, 40);
  const fromYard = count(g, /Plays Forest from the graveyard/);
  const both = count(g, /Plays Forest(?! from)/);
  check(fromYard > both, '3. lands come off the graveyard first', `${fromYard} from the graveyard, ${both} from hand in 40 games`);
}

// 4. Six: nonland permanent cards in the graveyard have retrace. Mulch fills
//    the yard with Bears; retrace casts them back by discarding a land. A
//    Lightning Bolt in the yard is not a permanent and is never retraced.
{
  const deck = [...rows([40, 'Forest'], [10, 'Mountain'], [20, 'Mulch'], [15, 'Grizzly Bears'], [14, 'Lightning Bolt']), cmd('Six')];
  const six = PREWRITTEN.Six!;
  console.log(`   ${describeBehavior(six).join('; ')}`);
  const noGrant = b({ v: 1, rules: [six.rules[1]] });
  const g = lines(deck, { Six: six }, 60);
  const retraced = count(g, /Casts Grizzly Bears from the graveyard \(retrace, discarding (Forest|Mountain)\)/);
  const bolts = count(g, /Casts Lightning Bolt from the graveyard/);
  const base = lines(deck, { Six: noGrant }, 60);
  check(retraced > 10, '4a. Bears come back with retrace', `${retraced} retrace casts in 60 games`);
  check(bolts === 0, '4b. a Bolt is not a permanent', `${bolts} Bolts cast from the graveyard`);
  check(count(base, /from the graveyard/) === 0, '4c. without the grant nothing is cast from there', `${count(base, /from the graveyard/)}`);
  // A trace line, for the reader.
  const sample = g.flat().find((l) => /retrace/.test(l));
  console.log(`   e.g. ${sample}`);
}

// 5. The grant ends with the card. A free Ornithopter carries Six's grant and
//    goes to the graveyard at its own end step, so it is out from its cast to
//    the end of that turn: every retrace has to follow a "Casts Ornithopter"
//    on the same turn (from hand, or retraced itself, which is fair).
{
  const deck = rows([45, 'Forest'], [44, 'Grizzly Bears'], [10, 'Ornithopter']);
  const grant = PREWRITTEN.Six!.rules[0]!;
  const brief = b({ v: 1, rules: [grant, { on: 'endstep', steps: [{ op: 'self', x: one, to: 'graveyard' }] }] });
  // Bears that mill three as they enter, so there are Bears to retrace.
  const mill3 = b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'mill', x: { kind: 'fixed', n: 3 } }] }] });
  const g = lines(deck, { Ornithopter: brief, 'Grizzly Bears': mill3 }, 120);
  let stray = 0;
  let fine = 0;
  for (const game of g) {
    let outOn = -1;
    for (const l of game) {
      const t = Number(l.slice(1, l.indexOf(' ')));
      if (/Casts Ornithopter/.test(l)) outOn = t;
      if (/Casts Grizzly Bears from the graveyard/.test(l)) {
        if (outOn === t) fine++;
        else stray++;
      }
    }
  }
  check(stray === 0 && fine > 0, '5. the grant ends when its card leaves', `${fine} retraces while it was out, ${stray} after it left`);
}

// 5b. The upkeep list, found by the check above: a card that exiles itself at
//     upkeep came off the list twice, so a commander recast after it never
//     fired its upkeep again. Six exiling itself every upkeep: it must go
//     every time it is out, not just the first.
{
  const deck = [...rows([45, 'Forest'], [54, 'Grizzly Bears']), cmd('Six')];
  const leaving = b({ v: 1, rules: [...PREWRITTEN.Six!.rules, { on: 'upkeep', steps: [{ op: 'self', x: one, to: 'exile' }] }] });
  const g = lines(deck, { Six: leaving }, 60);
  const casts = count(g, /Casts Six/);
  const gone = count(g, /Upkeep: Six puts itself into exile/);
  const last = g.reduce((n, game) => n + (game.filter((l) => /Casts Six/.test(l)).pop()?.startsWith('T8') ? 1 : 0), 0);
  check(gone === casts - last, '5b. a recast commander keeps its upkeep rule', `${casts} casts, ${gone} upkeep exiles, ${last} cast on the last turn`);
}

// 6. The top of the library: a grant to cast it (Future Sight). Every spell
//    cast off the top is a card the hand did not spend.
{
  const deck = [...rows([45, 'Forest'], [54, 'Grizzly Bears']), cmd('Ornithopter')];
  const sight = b({ v: 1, rules: [{ on: 'static', steps: [{ op: 'grantcast', x: one, from: 'librarytop', gk: 'cast' }] }] });
  const g = lines(deck, { Ornithopter: sight }, 30);
  const top = count(g, /Casts Grizzly Bears \{1\}\{G\} from the top of the library/);
  const a = run(deck);
  const z = run(deck, { Ornithopter: sight });
  check(top > 10, '6a. spells come off the top', `${top} in 30 games`);
  check(z.manaSpentByTurn[6]! > a.manaSpentByTurn[6]! + 0.3, '6b. and more of the turn is spent', `spent t6 ${f(a.manaSpentByTurn, 6)} -> ${f(z.manaSpentByTurn, 6)}`);
}

// 7. Granted flashback exiles the card after: with one copy of a sorcery in
//    the deck, no game casts it from the graveyard twice.
{
  const deck = [...rows([40, 'Forest'], [20, 'Mulch'], [38, 'Grizzly Bears'], [1, 'Harmonize']), cmd('Ornithopter')];
  const lier = b({ v: 1, rules: [{ on: 'static', steps: [{ op: 'grantcast', x: one, from: 'graveyard', gk: 'flashback', q: 't:instant or t:sorcery' }] }] });
  const g = lines(deck, { Ornithopter: lier }, 200);
  let twice = 0;
  let once = 0;
  for (const game of g) {
    const n = game.filter((l) => /Casts Harmonize from the graveyard \(flashback\)/.test(l)).length;
    if (n > 1) twice++;
    if (n === 1) once++;
  }
  check(once > 0 && twice === 0, '7. granted flashback exiles', `${once} games flashed it back once, ${twice} twice`);
}

console.log(failed ? `\n${failed} failed` : '\nall pass');

test('grants-sim: every check passes', () => {
  expect(failed).toBe(0);
});
