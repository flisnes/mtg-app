import { expect, test } from 'vitest';
// v0.177.0, played through the real simulator: X = your devotion, and
// "count different names" on your permanents matching. Ported from
// notes/checks/devotion-sim.ts (G0); the cards come from fixtures/rigCards.json.
//
//   npx vitest run sim/test/devotion-sim.test.ts
import { compileBehavior, describeBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import { PREWRITTEN } from '../src/behaviorTemplates.js';
import edhDefaults from '../src/edhDefaults.json';
import type { DeckRow } from '../src/simDeck.js';
import { simulate } from '../src/simulate.js';
import { b, deckWith, gamesLines, rigOpts, rows } from './fixtures/rigCards.js';

const opts = { ...rigOpts(), games: 3000 };
const lines = (r: DeckRow[], m: Record<string, CardBehavior>, games: number): string[] => gamesLines(deckWith(r, m), opts, games).flat();
let failed = 0;
const check = (ok: boolean, what: string, got: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}  ${got}`);
};
const dealt = (ls: string[], who: string) =>
  ls.filter((l) => l.includes(who)).flatMap((l) => [...l.matchAll(/deals (\d+) damage/g)].map((m) => Number(m[1])));
const drain = (c: string) => b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'damage', x: { kind: 'devotion', c } }] }] });

// 0. The grammar: saves the same twice, reads out loud, and an empty color
//    list is black rather than nothing.
{
  const d = b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'damage', x: { kind: 'devotion', c: 'bw' } }] }] });
  check(d.rules[0]!.steps[0]!.x.c === 'WB', '0a. colors normalized to WUBRG order', JSON.stringify(d.rules[0]!.steps[0]!.x));
  const e = b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'damage', x: { kind: 'devotion' } }] }] });
  check(e.rules[0]!.steps[0]!.x.c === 'B', '0b. no colors is black', JSON.stringify(e.rules[0]!.steps[0]!.x));
  const u = b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'matching', q: 't:land', uniq: true } }] }] });
  check(u.rules[0]!.steps[0]!.x.uniq === true, '0c. uniq survives', JSON.stringify(u.rules[0]!.steps[0]!.x));
  const h = b({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'hand', uniq: true, c: 'G' } }] }] });
  check(JSON.stringify(h.rules[0]!.steps[0]!.x) === '{"kind":"hand"}', '0d. uniq and c dropped where they mean nothing', JSON.stringify(h.rules[0]!.steps[0]!.x));
  console.log(`   ${describeBehavior(d).join('; ')}`);
  console.log(`   ${describeBehavior(u).join('; ')}`);
  for (const n of ['The Necrobloom', "Karametra's Acolyte"]) {
    check(!!compileBehavior(PREWRITTEN[n]!), `0e. ${n} compiles`, describeBehavior(PREWRITTEN[n]!).join('; '));
  }
}

// 1. Gray Merchant in Swamps: every copy counts the ones before it, so the
//    drains run 2, 4, 6. Lands add nothing.
{
  const deck = rows([45, 'Swamp'], [54, 'Gray Merchant of Asphodel']);
  const ls = lines(deck, { 'Gray Merchant of Asphodel': drain('B') }, 40);
  const got = dealt(ls, 'Gray Merchant');
  const counts = new Map<number, number>();
  for (const x of got) counts.set(x, (counts.get(x) ?? 0) + 1);
  check(got.length > 20 && got.every((x) => x % 2 === 0 && x >= 2), '1a. drains are even, at least 2', JSON.stringify([...counts].sort((a, z) => a[0] - z[0])));
  check((counts.get(4) ?? 0) > 0 && (counts.get(6) ?? 0) > 0, '1b. later copies count earlier ones', '');
}

// 2. Hybrid counts once, gold counts toward each color.
{
  const run = (who: string, c: string) => {
    const deck = rows([45, 'Forest'], [45, 'Plains'], [9, who]);
    return dealt(lines(deck, { [who]: drain(c) }, 30), who)[0];
  };
  // Kitchen Finks {1}{G/W}{G/W}: two symbols, whichever colors you ask.
  // A zero is not traced, so no color it lacks shows as none.
  const finks = ['G', 'W', 'GW', 'B'].map((c) => `${c}=${run('Kitchen Finks', c) ?? 'none'}`).join(' ');
  check(finks === 'G=2 W=2 GW=2 B=none', '2a. Kitchen Finks, hybrid once', finks);
  // Watchwolf {G}{W}: one of each.
  const wolf = ['G', 'W', 'GW'].map((c) => `${c}=${run('Watchwolf', c) ?? 'none'}`).join(' ');
  check(wolf === 'G=1 W=1 GW=2', '2b. Watchwolf, gold', wolf);
  // Phyrexian and two-brid: {G/P} and {2/G} both count toward green.
  const mite = `${run('Birthing Pod', 'G') ?? 'none'} ${run('Reaper King', 'WG') ?? 'none'}`;
  check(mite === '1 2', '2c. {G/P} and {2/W} count', mite);
}

// 3. Field of the Dead: never on basics alone, often on a deck of different lands.
{
  const field = { 'Field of the Dead': b(PREWRITTEN['Field of the Dead'] ?? (edhDefaults as { behaviors: Record<string, unknown> }).behaviors['Field of the Dead']) };
  const zombies = (ls: string[]) => ls.filter((l) => /Field of the Dead/.test(l) && /Zombie/.test(l)).length;
  const basics = rows([80, 'Forest'], [19, 'Field of the Dead']);
  const zb = zombies(lines(basics, field, 40));
  check(zb === 0, '3a. two names never make a Zombie', `${zb}`);
  const many = [
    'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes', 'Command Tower', 'Exotic Orchard', 'Reliquary Tower', "Rogue's Passage",
    'Temple of the False God', 'Path of Ancestry', 'Thornwood Falls', 'Jungle Hollow', 'Tranquil Thicket', 'Blossoming Sands', 'Scoured Barrens',
  ];
  const varied = rows(...many.map((n) => [5, n] as [number, string]), [14, 'Field of the Dead']);
  const lv = lines(varied, field, 40);
  const zv = zombies(lv);
  check(zv > 10, '3b. seven names do', `${zv} Zombies in 40 games`);
  console.log(`   e.g. ${lv.find((l) => /Field of the Dead/.test(l) && /Zombie/.test(l))}`);
}

// 4. The Necrobloom: Plants until seven names, Zombies after.
{
  const many = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes', 'Command Tower', 'Exotic Orchard', 'Reliquary Tower', "Rogue's Passage", 'Path of Ancestry'];
  const deck = rows(...many.map((n) => [7, n] as [number, string]), [22, 'The Necrobloom']);
  const ls = lines(deck, { 'The Necrobloom': PREWRITTEN['The Necrobloom']! }, 40).filter((l) => l.includes('Necrobloom'));
  const plants = ls.filter((l) => /0\/1/.test(l)).length;
  const zombies = ls.filter((l) => /Zombie/.test(l)).length;
  check(plants > 0 && zombies > 0, '4. Necrobloom makes both', `${plants} Plant lines, ${zombies} Zombie lines`);
  console.log(`   e.g. ${ls.find((l) => /Zombie/.test(l))}`);
}

// 5. Karametra's Acolyte taps for more as green piles up.
{
  const deck = rows([40, 'Forest'], [10, "Karametra's Acolyte"], [49, 'Leatherback Baloth']);
  const flat = simulate(deckWith(deck, {}), opts);
  const dev = simulate(deckWith(deck, { "Karametra's Acolyte": PREWRITTEN["Karametra's Acolyte"]! }), opts);
  const t = 7;
  check(dev.manaByTurn[t]! > flat.manaByTurn[t]! + 0.3, '5. devotion mana beats the flat reading', `t${t} ${flat.manaByTurn[t]!.toFixed(2)} -> ${dev.manaByTurn[t]!.toFixed(2)}`);
}

console.log(failed ? `\n${failed} failed` : '\nall pass');

test('devotion-sim: every check passes', () => {
  expect(failed).toBe(0);
});
