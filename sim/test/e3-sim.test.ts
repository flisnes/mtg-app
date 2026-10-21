import { expect, test } from 'vitest';
// Rebuild plan E3, played through the real simulator: end steps, dies and
// sacrifice watchers, activated abilities and their costs, conditions and
// once-a-turn, choosing which card a move takes, life, and the MDFC fix.
// Each deck is built so the answer can be worked out by hand. Ported from
// notes/checks/e3-sim.ts (G0); the cards come from fixtures/rigCards.json.
//
//   npx vitest run sim/test/e3-sim.test.ts
import { describeBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import type { DeckRow } from '../src/simDeck.js';
import { simulate, traceGame, type SimResult } from '../src/simulate.js';
import { b, card, cmd, deckWith, rigOpts, rows } from './fixtures/rigCards.js';

const opts = rigOpts();
const f = (xs: number[], t: number) => (xs[t] ?? 0).toFixed(2);
const run = (r: DeckRow[], m: Record<string, CardBehavior> = {}, o: Partial<typeof opts> = {}): SimResult => simulate(deckWith(r, m), { ...opts, ...o });
const show = (r: DeckRow[], m: Record<string, CardBehavior>, seed: number, upTo: number, filter = /./) => {
  const g = traceGame(deckWith(r, m), { ...opts, trace: true }, seed);
  for (const t of g.turns.slice(0, upTo)) {
    console.log(`     T${t.turn} avail ${t.available} spent ${t.spent} dmg ${t.damage}`);
    for (const l of t.lines) if (filter.test(l.text)) console.log(`       ${l.kind}: ${l.text}${l.taps ? `  [${l.taps.join('; ')}]` : ''}`);
  }
};
let failed = 0;
const check = (ok: boolean, what: string, got: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}  ${got}`);
};
const one = { kind: 'fixed', n: 1 };
const draw1 = { op: 'draw', x: one };
const fires = (r: SimResult, name: string, on: string) => r.fires.find((x) => x.oracleId === card(name).oracleId && x.on === on);

// 1. End step: a zero-cost artifact in the command zone that draws at every
//    end step. Cast on turn 1 every game, so by the end of turn 3 it has drawn
//    exactly 3, the turn it landed included.
{
  const deck: DeckRow[] = [...rows([60, 'Wastes'], [39, 'Hill Giant']), cmd('Ornithopter')];
  const beh = { Ornithopter: b({ v: 1, rules: [{ on: 'endstep', steps: [draw1] }] }) };
  const base = run(deck);
  const r = run(deck, beh);
  const extra = r.cardsSeenByTurn[3]! - base.cardsSeenByTurn[3]!;
  // Not exactly 3: with no land at all on turn 1 the spend loop never starts, so
  // a free spell waits a turn (older than E3, and the floor side).
  check(extra > 2.99 && extra <= 3 + 1e-9, '1. end step draws each turn, the turn it lands too', `+${extra.toFixed(4)} cards by t3 (expect 3)`);
  console.log(`   ${describeBehavior(beh.Ornithopter).join('; ')}`);
}

// 2. Dies watcher + sacrifice outlet: Blood Artist drains 1 whenever another
//    creature dies; Viscera Seer sacrifices a creature for scry 1, but only
//    fodder (tokens). An upkeep token maker feeds it.
{
  const deck = rows([45, 'Swamp'], [18, 'Blood Artist'], [18, 'Viscera Seer'], [18, 'Bitterblossom']);
  const artist = b({ v: 1, rules: [{ on: 'dies', q: 't:creature', steps: [{ op: 'damage', x: one }] }] });
  const seer = b({ v: 1, rules: [{ on: 'activate', cost: { sac: 1, sacq: 't:creature' }, steps: [{ op: 'scry', x: one }] }] });
  const blossom = b({ v: 1, rules: [{ on: 'upkeep', steps: [{ op: 'token', x: one, tk: 'custom', ty: 'C', tp: 1, tt: 1 }] }] });
  const none = run(deck, { 'Viscera Seer': seer, Bitterblossom: blossom }, { combat: 'none' });
  const all = run(deck, { 'Blood Artist': artist, 'Viscera Seer': seer, Bitterblossom: blossom }, { combat: 'none' });
  check(none.damageByTurn[8]! === 0 && all.damageByTurn[8]! > 0.5, '2. Blood Artist drains off tokens the Seer sacrifices', `dmg t8 without ${f(none.damageByTurn, 8)}, with ${f(all.damageByTurn, 8)}`);
  const seerFires = fires(all, 'Viscera Seer', 'activate');
  console.log(`   Seer used in ${((seerFires?.games ?? 0) * 100).toFixed(0)}% of games, ${(seerFires?.perGame ?? 0).toFixed(2)} times a game`);
  console.log(`   ${describeBehavior(seer).join('; ')} | ${describeBehavior(artist).join('; ')}`);
  // A Seer with only nontoken creatures around sacrifices nothing.
  const bare = run(rows([50, 'Swamp'], [25, 'Viscera Seer'], [24, 'Grizzly Bears']), { 'Viscera Seer': seer }, { combat: 'all' });
  check((fires(bare, 'Viscera Seer', 'activate')?.perGame ?? 0) === 0, '2b. no fodder, no sacrifice (Bears stay)', `fires ${(fires(bare, 'Viscera Seer', 'activate')?.perGame ?? 0).toFixed(2)}`);
  show(deck, { 'Blood Artist': artist, 'Viscera Seer': seer, Bitterblossom: blossom }, 3, 4, /Activates|Blood Artist|Upkeep|Casts/);
}

// 3. Sacrifice watcher sees Treasures: a card that makes a Treasure every
//    upkeep, and a watcher that draws whenever you sacrifice an artifact.
{
  const deck = rows([40, 'Wastes'], [30, 'Ornithopter'], [29, 'Hill Giant']);
  const maker = b({ v: 1, rules: [{ on: 'upkeep', steps: [{ op: 'treasure', x: one }] }] });
  const watcher = b({ v: 1, rules: [{ on: 'sacrifice', q: 't:artifact', steps: [draw1] }] });
  const only = run(deck, { Ornithopter: maker });
  const both = run(deck, { Ornithopter: { ...maker, rules: [...maker.rules, ...watcher.rules] } });
  check(both.cardsSeenByTurn[8]! > only.cardsSeenByTurn[8]!, '3. cracking a Treasure wakes a sacrifice watcher', `seen t8 ${f(only.cardsSeenByTurn, 8)} -> ${f(both.cardsSeenByTurn, 8)}`);
}

// 4. Mind Stone: {1}, {T}, sacrifice it: draw. Cashed in only with no spell in hand.
{
  const stone = b({ v: 1, rules: [{ on: 'activate', cost: { mana: '{1}', tap: true, self: true }, steps: [draw1] }] });
  console.log(`4. ${describeBehavior(stone).join('; ')}`);
  const flood = rows([60, 'Wastes'], [39, 'Mind Stone']);
  const r = run(flood, { 'Mind Stone': stone });
  const base = run(flood);
  check(r.cardsSeenByTurn[6]! > base.cardsSeenByTurn[6]! + 0.3, '4a. a hand of lands and rocks cashes the Stones in', `seen t6 ${f(base.cardsSeenByTurn, 6)} -> ${f(r.cardsSeenByTurn, 6)}`);
  // With a big spell stuck in hand the Stone is kept as mana.
  const busy = rows([45, 'Wastes'], [20, 'Mind Stone'], [34, 'Colossal Dreadmaw']);
  const rb = run(busy, { 'Mind Stone': stone });
  const bb = run(busy);
  const fb = fires(rb, 'Mind Stone', 'activate');
  check(Math.abs(rb.manaByTurn[4]! - bb.manaByTurn[4]!) < 0.15, '4b. holding a spell, the Stones stay mana', `mana t4 ${f(bb.manaByTurn, 4)} vs ${f(rb.manaByTurn, 4)}, used ${(fb?.perGame ?? 0).toFixed(2)}/game`);
  show(flood, { 'Mind Stone': stone }, 5, 4, /Activates|Mind Stone|Draws/);
}

// 5. Clues: an entry rule makes a Clue, and spare mana cracks it for a card.
{
  const deck = rows([50, 'Wastes'], [49, 'Ornithopter']);
  const clue = b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'token', x: one, tk: 'clue' }] }] });
  const base = run(deck);
  const r = run(deck, { Ornithopter: clue });
  check(r.cardsSeenByTurn[5]! > base.cardsSeenByTurn[5]! + 1, '5. Clues crack for cards with spare mana', `seen t5 ${f(base.cardsSeenByTurn, 5)} -> ${f(r.cardsSeenByTurn, 5)}`);
  show(deck, { Ornithopter: clue }, 2, 3, /Activates|Clue|Casts/);
}

// 6. Conditions: threshold (upkeep draw only with 7+ in the graveyard) never
//    fires in a deck that bins nothing; the same rule with no condition does.
//    And once each turn: landfall draw with two land drops a turn draws once.
{
  const deck = rows([50, 'Wastes'], [49, 'Ornithopter']);
  const thr = b({ v: 1, rules: [{ on: 'upkeep', cond: { x: { kind: 'graveyard' }, op: '>=', n: 7 }, steps: [draw1] }] });
  const plain = b({ v: 1, rules: [{ on: 'upkeep', steps: [draw1] }] });
  const rt = run(deck, { Ornithopter: thr });
  const rp = run(deck, { Ornithopter: plain });
  const ft = fires(rt, 'Ornithopter', 'upkeep');
  check((ft?.perGame ?? 1) === 0 && rp.cardsSeenByTurn[5]! > rt.cardsSeenByTurn[5]!, '6a. threshold holds the draw back', `fires ${(ft?.perGame ?? 0).toFixed(2)}, seen t5 ${f(rt.cardsSeenByTurn, 5)} vs ${f(rp.cardsSeenByTurn, 5)}`);
  console.log(`   ${describeBehavior(thr).join('; ')}`);
  // Two land drops a turn off an Exploration, a landfall draw on Ornithopter.
  const land = rows([60, 'Forest'], [20, 'Exploration'], [19, 'Ornithopter']);
  const every = b({ v: 1, rules: [{ on: 'enters', q: 't:land', steps: [draw1] }] });
  const once = b({ v: 1, rules: [{ on: 'enters', q: 't:land', once: true, steps: [draw1] }] });
  const re = run(land, { Ornithopter: every });
  const ro = run(land, { Ornithopter: once });
  const fe = fires(re, 'Ornithopter', 'enters');
  const fo = fires(ro, 'Ornithopter', 'enters');
  check((fo?.perGame ?? 0) < (fe?.perGame ?? 0) && (fo?.perGame ?? 0) <= 8, '6b. once each turn caps a landfall draw', `fires/game every ${(fe?.perGame ?? 0).toFixed(2)}, once ${(fo?.perGame ?? 0).toFixed(2)}`);
}

// 7. Choice: return the creature with the greatest mana value from the
//    graveyard, versus a random one. Entomb-style upkeep mill fills the yard.
{
  const deck = rows([40, 'Swamp'], [20, 'Grizzly Bears'], [20, 'Colossal Dreadmaw'], [19, 'Ornithopter']);
  const mill = { op: 'mill', x: { kind: 'fixed', n: 3 } };
  const back = (pick?: string) =>
    b({ v: 1, rules: [{ on: 'upkeep', steps: [mill, { op: 'move', x: one, from: 'graveyard', to: 'battlefield', q: 't:creature', ...(pick ? { pick } : {}) }] }] });
  const rand = run(deck, { Ornithopter: back() }, { combat: 'all' });
  const most = run(deck, { Ornithopter: back('most') }, { combat: 'all' });
  check(most.damageByTurn[8]! > rand.damageByTurn[8]! + 1, '7. greatest mana value first reanimates the Dreadmaw', `dmg t8 random ${f(rand.damageByTurn, 8)}, most ${f(most.damageByTurn, 8)}`);
  console.log(`   ${describeBehavior(back('most')).join('; ')}`);
}

// 8. Mox Opal: taps only with three artifacts out (metalcraft).
{
  const opal = b({ v: 1, rules: [{ on: 'tap', cond: { x: { kind: 'matching', q: 't:artifact' }, op: '>=', n: 3 }, steps: [{ op: 'tapsfor', x: one }] }] });
  console.log(`8. ${describeBehavior(opal).join('; ')}`);
  const lone = rows([60, 'Wastes'], [4, 'Mox Opal'], [35, 'Grizzly Bears']);
  const rich = rows([40, 'Wastes'], [4, 'Mox Opal'], [55, 'Ornithopter']);
  const rl = run(lone, { 'Mox Opal': opal });
  const bl = run(lone, { 'Mox Opal': b({ v: 1, rules: [{ on: 'tap', steps: [{ op: 'tapsfor', x: one }] }] }) });
  const rr = run(rich, { 'Mox Opal': opal });
  const br = run(rich, { 'Mox Opal': b({ v: 1, rules: [{ on: 'tap', steps: [{ op: 'tapsfor', x: one }] }] }) });
  check(rl.manaByTurn[5]! < bl.manaByTurn[5]! - 0.05, '8a. without artifacts the Opal is dead', `mana t5 ${f(bl.manaByTurn, 5)} -> ${f(rl.manaByTurn, 5)}`);
  check(Math.abs(rr.manaByTurn[5]! - br.manaByTurn[5]!) < 0.1, '8b. among Ornithopters it taps as normal', `mana t5 ${f(br.manaByTurn, 5)} vs ${f(rr.manaByTurn, 5)}`);
}

// 9. Life as a price: pay 2 life: draw, once each turn, never below 10 of 40.
{
  const deck = rows([50, 'Wastes'], [49, 'Ornithopter']);
  const ring = b({ v: 1, rules: [{ on: 'activate', cost: { life: 2 }, once: true, steps: [draw1] }] });
  console.log(`9. ${describeBehavior(ring).join('; ')}`);
  const r = run(deck, { Ornithopter: ring }, { maxTurn: 12 });
  const fr = fires(r, 'Ornithopter', 'activate');
  // 40 life, floor 10: fifteen payments at most across copies, and once a turn per copy.
  check((fr?.perGame ?? 0) > 5 && (fr?.perGame ?? 99) <= 15, '9. life is paid down to the floor and no further', `${(fr?.perGame ?? 0).toFixed(2)} activations a game over 12 turns`);
}

// 10. A land with {T}: draw needs its own mana spare: War Room shape.
{
  const room = b({ v: 1, rules: [{ on: 'activate', cost: { mana: '{3}', tap: true, life: 1 }, steps: [draw1] }] });
  const deck = rows([50, 'Wastes'], [10, 'War Room'], [39, 'Hill Giant']);
  const r = run(deck, { 'War Room': room });
  const base = run(deck);
  check(r.cardsSeenByTurn[8]! > base.cardsSeenByTurn[8]!, '10a. War Room draws with four lands spare', `seen t8 ${f(base.cardsSeenByTurn, 8)} -> ${f(r.cardsSeenByTurn, 8)}`);
  // With castable spells in hand it waits for the mana they leave over.
  const cast = rows([50, 'Wastes'], [10, 'War Room'], [39, 'Juggernaut']);
  const rc = run(cast, { 'War Room': room });
  const bc = run(cast);
  check(Math.abs(rc.manaSpentByTurn[4]! - bc.manaSpentByTurn[4]!) < 0.05 && rc.cardsSeenByTurn[8]! >= bc.cardsSeenByTurn[8]!, '10b. it never costs a spell', `spent t4 ${f(bc.manaSpentByTurn, 4)} vs ${f(rc.manaSpentByTurn, 4)}, seen t8 ${f(bc.cardsSeenByTurn, 8)} -> ${f(rc.cardsSeenByTurn, 8)}`);
  show(deck, { 'War Room': room }, 11, 6, /Activates|War Room|Casts|Stops/);
}

// 11. MDFC: a play rule on a modal card does not fire when it is played as its land.
{
  const mdfc = card('Bala Ged Recovery // Bala Ged Sanctuary');
  const deck: DeckRow[] = [{ quantity: 99, board: 'main', oracle: mdfc }];
  const drawer = b({ v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 3 } }] }] });
  const r = simulate(deckWith(deck, { [mdfc.name]: drawer }), opts);
  const base = simulate(deckWith(deck, {}), opts);
  // By turn 2 nothing is castable, so every extra card would be a land drop's.
  check(Math.abs(r.cardsSeenByTurn[2]! - base.cardsSeenByTurn[2]!) < 1e-6, '11. an MDFC played as a land does not run its play rule', `seen t2 ${f(base.cardsSeenByTurn, 2)} vs ${f(r.cardsSeenByTurn, 2)}`);
}

// 12. The card credit still sums with abilities tapping lands out of the pool.
{
  const room = b({ v: 1, rules: [{ on: 'activate', cost: { mana: '{3}', tap: true }, steps: [draw1] }] });
  const r = run(rows([50, 'Wastes'], [10, 'War Room'], [39, 'Hill Giant']), { 'War Room': room });
  let worst = 0;
  for (let t = 1; t <= 8; t++) {
    const sum = r.contributions.reduce((s, c) => s + (c.manaByTurn[t] ?? 0), 0);
    worst = Math.max(worst, Math.abs(sum - r.manaByTurn[t]!));
  }
  check(worst < 1e-6, '12. mana credit sums to the mana line', `worst gap ${worst.toExponential(2)}`);
}

console.log(failed === 0 ? '\nall E3 checks pass' : `\n${failed} E3 check(s) FAILED`);

test('e3-sim: every check passes', () => {
  expect(failed).toBe(0);
});
