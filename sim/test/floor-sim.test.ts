import { expect, test } from 'vitest';
// The v0.180.x floor fixes, played through the real simulator: a Theros god
// below devotion does not attack, at devotion it does, and defender stays home.
// Ported from notes/checks/floor-sim.ts (G0); the cards come from
// fixtures/rigCards.json.
//
//   npx vitest run sim/test/floor-sim.test.ts
import type { CardBehavior } from '../../shared/src/behavior.js';
import type { DeckRow } from '../src/simDeck.js';
import { b, deckWith, gamesLines, rigOpts, rows } from './fixtures/rigCards.js';

const opts = { ...rigOpts(), games: 1, combat: 'all' as const };
const lines = (r: DeckRow[], m: Record<string, CardBehavior>, games: number): string[] => gamesLines(deckWith(r, m), opts, games).flat();
let failed = 0;
const check = (ok: boolean, what: string, got: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}  ${got}`);
};

// 1. Four Erebos and Swamps: devotion tops out at 4, below the god's five, so
//    nothing ever attacks.
{
  const ls = lines(rows([4, 'Erebos, God of the Dead'], [36, 'Swamp']), {}, 60);
  const swings = ls.filter((l) => l.includes('Attacks with'));
  check(swings.length === 0, '1. god below devotion never attacks', `${swings.length} attack lines`);
}

// 2. Add Phyrexian Obliterator (four black pips): with one out beside Erebos,
//    devotion is five and the god swings too: some turn attacks for ten.
{
  const ls = lines(rows([4, 'Erebos, God of the Dead'], [4, 'Phyrexian Obliterator'], [32, 'Swamp']), {}, 80);
  const powers = ls.filter((l) => l.includes('Attacks with')).flatMap((l) => [...l.matchAll(/for (\d+)/g)].map((m) => Number(m[1])));
  check(powers.some((p) => p >= 10), '2. god at devotion attacks', `max swing ${Math.max(0, ...powers)}`);
}

// 3. A wall with an authored attack rule: defender keeps it home, so the rule
//    never fires. The same rule on Grizzly Bears fires, proving the rig.
{
  const rule = b({ v: 1, rules: [{ on: 'attack', steps: [{ op: 'damage', x: { kind: 'fixed', n: 3 } }] }] });
  const wall = lines(rows([4, 'Wall of Omens'], [36, 'Plains']), { 'Wall of Omens': rule }, 40);
  const bears = lines(rows([4, 'Grizzly Bears'], [36, 'Forest']), { 'Grizzly Bears': rule }, 40);
  const fired = (ls: string[], n: string) => ls.filter((l) => l.includes(`Attacks with ${n}`)).length;
  check(fired(wall, 'Wall of Omens') === 0, '3a. defender never attacks', `${fired(wall, 'Wall of Omens')} triggers`);
  check(fired(bears, 'Grizzly Bears') > 0, '3b. the same rule on Bears fires', `${fired(bears, 'Grizzly Bears')} triggers`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok');

test('floor-sim: every check passes', () => {
  expect(failed).toBe(0);
});
