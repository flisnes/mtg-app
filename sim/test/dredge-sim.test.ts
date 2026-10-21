import { expect, test } from 'vitest';
// v0.176.0, played through the real simulator: dredge replacing a draw
// (printed, authored, and granted by The Necrobloom), and milled cards counted
// as seen. Ported from notes/checks/dredge-sim.ts (G0); the cards come from
// fixtures/rigCards.json.
//
//   npx vitest run sim/test/dredge-sim.test.ts
import { compileBehavior, describeBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import { PREWRITTEN } from '../src/behaviorTemplates.js';
import { printedDredge, type DeckRow } from '../src/simDeck.js';
import { simulate, type SimResult } from '../src/simulate.js';
import { b, card, cmd, count, deckWith, gamesLines, rigOpts, rows } from './fixtures/rigCards.js';

const opts = rigOpts();
const f = (xs: number[], t: number) => (xs[t] ?? 0).toFixed(2);
const run = (r: DeckRow[], m: Record<string, CardBehavior> = {}, o: Partial<typeof opts> = {}): SimResult => simulate(deckWith(r, m), { ...opts, ...o });
const lines = (r: DeckRow[], m: Record<string, CardBehavior>, games: number, o: Partial<typeof opts> = {}) => gamesLines(deckWith(r, m), { ...opts, ...o }, games);
let failed = 0;
const check = (ok: boolean, what: string, got: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}  ${got}`);
};
/** The cards line adds back up: opener + draw step + every card's credit. */
const sumsUp = (r: SimResult, t: number): [number, number] => {
  const credit = r.contributions.reduce((s, c) => s + (c.cardsByTurn[t] ?? 0), 0);
  return [r.cardsSeenByTurn[t]!, r.seenFromOpener[t]! + r.seenFromDrawStep[t]! + credit];
};
const mill = (n: number) => b({ v: 1, rules: [{ on: 'play', steps: [{ op: 'mill', x: { kind: 'fixed', n } }] }] });
const loot = b({ v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }, { op: 'discard', x: { kind: 'fixed', n: 1 } }] }] });

// 0. The printed keyword, read off the text.
{
  const got = ['Golgari Grave-Troll', 'Life from the Loam', 'Dakmor Salvage', 'Trash Panda', 'The Necrobloom', 'Grizzly Bears'].map((n) => `${n}=${printedDredge(card(n).oracleText)}`);
  check(got.join() === 'Golgari Grave-Troll=6,Life from the Loam=3,Dakmor Salvage=2,Trash Panda=0,The Necrobloom=0,Grizzly Bears=0', '0. printed Dredge N', got.join(', '));
  const nb = PREWRITTEN['The Necrobloom']!;
  console.log(`   ${describeBehavior(nb).join('; ')}`);
  check(!!compileBehavior(nb), '0b. Necrobloom compiles', '');
}

// 1. Mills count as seen. Grizzly Bears that mill 3 as they are cast: the
//    cards line goes up by about three a cast, and it still adds up.
{
  const deck = rows([40, 'Forest'], [59, 'Grizzly Bears']);
  const a = run(deck);
  const z = run(deck, { 'Grizzly Bears': mill(3) });
  const bears = z.contributions.find((c) => c.name === 'Grizzly Bears');
  check(z.cardsSeenByTurn[8]! > a.cardsSeenByTurn[8]! + 5, '1a. milled cards are seen', `seen t8 ${f(a.cardsSeenByTurn, 8)} -> ${f(z.cardsSeenByTurn, 8)}`);
  check((bears?.cards ?? 0) > 0.05, '1b. credited to the card that milled', `Bears ${(bears?.cards ?? 0).toFixed(2)}`);
  const [s, parts] = sumsUp(z, 8);
  check(Math.abs(s - parts) < 0.01, '1c. the cards line still adds up', `${s.toFixed(3)} vs ${parts.toFixed(3)}`);
  const mv = b({ v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 3 }, from: 'library', to: 'graveyard' }] }] });
  const y = run(deck, { 'Grizzly Bears': mv });
  check(Math.abs(y.cardsSeenByTurn[8]! - z.cardsSeenByTurn[8]!) < 0.4, '1d. a move library -> graveyard counts the same', `${f(y.cardsSeenByTurn, 8)} vs ${f(z.cardsSeenByTurn, 8)}`);
}

// 2. Golgari Grave-Troll, printed Dredge 6. Looting bins it; every later draw
//    dredges it back while there is a library to mill.
{
  const deck = rows([40, 'Forest'], [10, 'Swamp'], [4, 'Golgari Grave-Troll'], [45, 'Faithless Looting']);
  const m = { 'Faithless Looting': loot };
  const g = lines(deck, m, 60);
  const dredges = count(g, /Dredges back Golgari Grave-Troll \(dredge 6, milling [^)]+\) instead of drawing/);
  // Bears that mill six and then draw: the draw right after the mill is the
  // chance to dredge whatever the mill binned.
  const millDraw = b({ v: 1, rules: [{ on: 'play', steps: [{ op: 'mill', x: { kind: 'fixed', n: 6 } }, { op: 'draw', x: { kind: 'fixed', n: 1 } }] }] });
  const g2 = lines(rows([40, 'Forest'], [10, 'Swamp'], [15, 'Golgari Grave-Troll'], [34, 'Grizzly Bears']), { 'Grizzly Bears': millDraw }, 60);
  const inRule = count(g2, /draws Golgari Grave-Troll \(dredge 6/);
  console.log(`   e.g. ${g2.flat().find((l) => /draws Golgari Grave-Troll \(dredge 6/.test(l))}`);
  check(dredges > 10, '2a. the draw step dredges', `${dredges} draw-step dredges in 60 games`);
  check(inRule > 0, '2b. a rule\'s draw can dredge too', `${inRule} in 60 games`);
  console.log(`   e.g. ${g.flat().find((l) => /Dredges back/.test(l))}`);
  const r = run(deck, m);
  const troll = r.contributions.find((c) => c.name === 'Golgari Grave-Troll');
  check((troll?.cards ?? 0) > 1, '2c. the Troll is credited its mills', `Troll ${(troll?.cards ?? 0).toFixed(2)} cards by t8`);
  const fire = r.fires.find((x) => x.on === 'graveyard');
  check(!!fire && fire.games > 0.05 && fire.perGame > fire.games, '2d. firing count for the dredge', fire ? `${(fire.games * 100).toFixed(0)}% of games, ${fire.perGame.toFixed(2)} a game` : 'none');
  const [s, parts] = sumsUp(r, 8);
  check(Math.abs(s - parts) < 0.01, '2e. the cards line still adds up', `${s.toFixed(3)} vs ${parts.toFixed(3)}`);
}

// 3. An authored "While it is in your graveyard: dredge 3" on a card that has
//    none, and a rule replacing a printed number.
{
  const deck = rows([40, 'Forest'], [10, 'Swamp'], [4, 'Grizzly Bears'], [45, 'Faithless Looting']);
  const dr = (n: number) => b({ v: 1, rules: [{ on: 'graveyard', steps: [{ op: 'dredge', x: { kind: 'fixed', n } }] }] });
  console.log(`   ${describeBehavior(dr(3)).join('; ')}`);
  const g = lines(deck, { 'Faithless Looting': loot, 'Grizzly Bears': dr(3) }, 60);
  check(count(g, /Grizzly Bears \(dredge 3/) > 0, '3a. authored dredge dredges', `${count(g, /Grizzly Bears \(dredge 3/)}`);
  const none = lines(deck, { 'Faithless Looting': loot }, 60);
  check(count(none, /dredge/) === 0, '3b. without it, nothing dredges', `${count(none, /dredge/)}`);
  const troll = rows([40, 'Forest'], [10, 'Swamp'], [4, 'Golgari Grave-Troll'], [45, 'Faithless Looting']);
  const t = lines(troll, { 'Faithless Looting': loot, 'Golgari Grave-Troll': dr(2) }, 60);
  check(count(t, /dredge 2/) > 5 && count(t, /dredge 6/) === 0, '3c. a rule replaces the printed number', `${count(t, /dredge 2/)} at 2, ${count(t, /dredge 6/)} at 6`);
}

// 4. The Necrobloom: lands in the graveyard have dredge 2. Mill fills the yard
//    with Forests; a land comes back only when the hand holds none.
{
  const deck = [...rows([13, 'Forest'], [13, 'Plains'], [13, 'Swamp'], [60, 'Grizzly Bears']), cmd('The Necrobloom')];
  const m = { 'The Necrobloom': PREWRITTEN['The Necrobloom']!, 'Grizzly Bears': mill(3) };
  const g = lines(deck, m, 80);
  const landDredges = count(g, /(Forest|Plains|Swamp) \(dredge 2/);
  check(landDredges > 0, '4a. Forests dredge under The Necrobloom', `${landDredges} in 80 games`);
  const off = lines(deck, { 'Grizzly Bears': mill(3) }, 80);
  check(count(off, /dredge/) === 0, '4b. not without it', `${count(off, /dredge/)}`);
  // Only with no land in hand: the turn's land drop right after a draw-step
  // dredge must be that Forest, from the hand it was just returned to.
  let followed = 0;
  let total = 0;
  for (const game of g) {
    for (let i = 0; i < game.length; i++) {
      if (!/Dredges back (Forest|Plains|Swamp)/.test(game[i]!)) continue;
      total++;
      const turn = game[i]!.split(' ')[0];
      if (game.slice(i + 1).some((l) => l.startsWith(`${turn} `) && /Plays (Forest|Plains|Swamp)/.test(l))) followed++;
    }
  }
  check(total > 0 && followed === total, '4c. a dredged land is the land drop', `${followed} of ${total}`);
  console.log(`   e.g. ${g.flat().find((l) => /Dredges back (Forest|Plains|Swamp)/.test(l))}`);
}

// 5. No dredge with fewer cards in the library than the number: a deck of 12.
{
  const deck = rows([6, 'Swamp'], [2, 'Golgari Grave-Troll'], [4, 'Faithless Looting']);
  const g = lines(deck, { 'Faithless Looting': loot }, 40, { format: 'standard' });
  let bad = 0;
  for (const game of g) for (const l of game) if (/dredge 6, milling/.test(l) && (l.match(/milling ([^)]*)\)/)?.[1] ?? '').split(', ').length < 6) bad++;
  check(bad === 0, '5. never dredges short', `${bad} short dredges`);
}

console.log(failed ? `\n${failed} failed` : '\nall pass');

test('dredge-sim: every check passes', () => {
  expect(failed).toBe(0);
});
