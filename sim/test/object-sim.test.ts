import { expect, test } from 'vitest';
// Rebuild plan F: the object layer. One section per step, each on a deck built
// so the answer is a number you can work out by hand: every deck is lands plus
// the card under test, mulligans are off, and we are on the play.
//
//   npx tsx notes/checks/object-sim.ts
import {
  compileBehavior,
  describeBehavior,
  sanitizeCardBehavior,
  type BehaviorRule,
  type CardBehavior,
  type CastOption,
} from '../../shared/src/behavior.js';
import { FETCH_BASIC_ONLY, MANA_TAPPED, type OracleCard } from '../../shared/src/card.js';
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
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;

const land = (name: string, color: string, adds = 1, tapped = false, typeLine = 'Land') =>
  card({ name, typeLine, cmc: 0, manaCost: '', produces: color, mana: [0, adds, tapped ? MANA_TAPPED : 0] });
const FOREST = land('Forest', 'G', 1, false, 'Basic Land — Forest');
const ISLAND = land('Island', 'U', 1, false, 'Basic Land — Island');
const WASTES = land('Wastes', 'C', 1, false, 'Basic Land');
/** A spell nobody can cast inside eight turns: the filler that keeps a hand full. */
const BRICK = card({ name: 'Brick', manaCost: '{20}', cmc: 20 });

const GAMES = 4000;
const base: SimOptions = { ...defaultSimOptions('commander', true), games: GAMES, mulligan: false };
const b = (...rules: BehaviorRule[]): CardBehavior => ({ v: 1, rules });
const withCast = (behavior: CardBehavior, ...cast: CastOption[]): CardBehavior => ({ ...behavior, cast });

const run = (rows: DeckRow[], behaviors: [OracleCard, CardBehavior][] = [], opts: Partial<SimOptions> = {}): SimResult => {
  const map = new Map(behaviors.map(([o, beh]) => [o.oracleId, sanitizeCardBehavior(beh)!]));
  return simulate(buildSimDeck(rows, map), { ...base, ...opts });
};
const trace = (rows: DeckRow[], behaviors: [OracleCard, CardBehavior][], seed: number, opts: Partial<SimOptions> = {}) => {
  const map = new Map(behaviors.map(([o, beh]) => [o.oracleId, sanitizeCardBehavior(beh)!]));
  return traceGame(buildSimDeck(rows, map), { ...base, ...opts }, seed);
};
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};
const near = (a: number, e: number, tol = 1e-6) => Math.abs(a - e) <= tol;
const f2 = (x: number) => x.toFixed(2);

// ---------------------------------------------------------------------------
console.log('\n=== grammar: every new field survives the sanitizer, twice ===');
{
  const all: CardBehavior = {
    v: 1,
    rules: [
      { on: 'etb', steps: [{ op: 'counter', x: { kind: 'kicked' }, ck: 'charge' }, { op: 'token', x: { kind: 'fixed', n: 2 }, tk: 'beast' }] },
      { on: 'play', steps: [{ op: 'token', x: { kind: 'fixed', n: 1 }, tk: 'custom', tp: 3, tt: 2, ty: 'CA', kw: 'H' }] },
      { on: 'attack', steps: [{ op: 'pump', x: { kind: 'creatures' }, q: 't:elf' }, { op: 'keyword', x: { kind: 'fixed', n: 1 }, kw: 'H' }] },
      {
        on: 'static',
        q: 't:creature -t:token',
        steps: [
          { op: 'addtype', x: { kind: 'fixed', n: 1 }, ty: 'L', sub: 'G' },
          { op: 'pump', x: { kind: 'fixed', n: 1 } },
          { op: 'extramana', x: { kind: 'fixed', n: 1 }, colors: 'G' },
          { op: 'landfrom', x: { kind: 'fixed', n: 1 }, from: 'graveyard' },
          { op: 'nomaxhand', x: { kind: 'fixed', n: 1 } },
        ],
      },
      { on: 'tap', steps: [{ op: 'tapsfor', x: { kind: 'counters' }, colors: 'C' }] },
      { on: 'play', steps: [{ op: 'draw', x: { kind: 'matching', q: 't:elf' } }] },
    ],
    cast: [
      { kind: 'multikicker', cost: '{2}' },
      { kind: 'flashback', cost: '{2}{u}' },
      { kind: 'suspend', cost: '{U}', n: 4 },
    ],
  };
  const once = sanitizeCardBehavior(all);
  const twice = sanitizeCardBehavior(once);
  check(!!once && JSON.stringify(once) === JSON.stringify(twice), 'sanitizing is idempotent');
  check(once?.rules.length === 6, `all six rules kept (${once?.rules.length})`);
  check(once?.rules[3]?.steps.length === 5, 'the static keeps all five grants');
  check(once?.cast?.[1]?.cost === '{2}{U}', `a cost is normalized to upper case (${once?.cast?.[1]?.cost})`);
  const c = compileBehavior(once);
  check(!!c && c.statics.length === 1 && !!c.tap && c.options.length === 3, 'compiles into statics, tap and options');
  // A static-only step on a trigger, and a trigger step on a static, are dropped.
  const wrong = sanitizeCardBehavior(b({ on: 'play', steps: [{ op: 'nomaxhand', x: { kind: 'fixed', n: 1 } }] }, { on: 'static', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }));
  check(wrong === null, 'a step in the wrong kind of rule does not survive');
  const lines = describeBehavior(once);
  check(lines.length === 9 && lines.every((l) => l.length > 10), `every rule and option has a sentence (${lines.length})`);
  for (const l of lines) console.log(`       ${l}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== F1: cleanup, no maximum hand size, matching, commander tax ===');
{
  // Nothing castable: the hand grows by one a turn and cleanup trims it to 7.
  const bricks = [main(30, WASTES), main(69, BRICK)];
  const r = run(bricks);
  const max = Math.max(...r.handSizeByTurn.slice(1));
  check(max <= 7 + 1e-9, `a hand of bricks ends every turn at 7 or fewer (max ${f2(max)})`);
  const TOWER = land('Reliquary Tower', 'C');
  const tower = run([main(30, TOWER), main(69, BRICK)], [[TOWER, b({ on: 'static', steps: [{ op: 'nomaxhand', x: { kind: 'fixed', n: 1 } }] })]]);
  check(tower.handSizeByTurn[8]! > 8, `Reliquary Tower lifts it (turn 8 hand ${f2(tower.handSizeByTurn[8]!)})`);

  // Distant Melody on five Elves: every land is an Elf, the Melody is the
  // commander at five mana, so on turn 5 exactly five Elves are out.
  const ELF_LAND = land('Elfhame', 'U', 1, false, 'Land — Elf');
  const MELODY = card({ name: 'Distant Melody', manaCost: '{4}{U}', cmc: 5 });
  const melodyRule = b({ on: 'play', steps: [{ op: 'draw', x: { kind: 'matching', q: 't:elf' } }] });
  const plain = run([main(99, ELF_LAND), cmd(MELODY)]);
  const melody = run([main(99, ELF_LAND), cmd(MELODY)], [[MELODY, melodyRule]]);
  check(near(melody.cardsSeenByTurn[5]! - plain.cardsSeenByTurn[5]!, 5), `Distant Melody on 5 Elves draws 5 (${f2(melody.cardsSeenByTurn[5]! - plain.cardsSeenByTurn[5]!)})`);

  // A commander that sacrifices itself as it resolves: cast on 2, then 4, 6, 8.
  const PHOENIX = card({ name: 'Ashen Phoenix', typeLine: 'Creature — Phoenix', manaCost: '{2}', cmc: 2, power: '2' });
  const sac = b({ on: 'play', steps: [{ op: 'self', x: { kind: 'fixed', n: 1 }, to: 'graveyard' }] });
  const recast = run([main(99, WASTES), cmd(PHOENIX)], [[PHOENIX, sac]]);
  const fired = recast.fires.find((f) => f.on === 'play')!;
  check(near(fired.perGame, 4), `commander recast costs +2 each time: cast 4 times in 8 turns (${f2(fired.perGame)})`);
  const t = trace([main(99, WASTES), cmd(PHOENIX)], [[PHOENIX, sac]], 7);
  const taxLines = t.turns.flatMap((tt) => tt.lines).filter((l) => l.text.includes('commander tax'));
  check(taxLines.length === 3 && taxLines[0]!.text.includes('with 2 commander tax'), `the trace names the tax (${taxLines.map((l) => l.text).join(' | ')})`);
}

// ---------------------------------------------------------------------------
console.log('\n=== F2: a creature tapped for mana does not attack ===');
{
  const ELF = card({ name: 'Llanowar Elves', typeLine: 'Creature — Elf Druid', manaCost: '{G}', cmc: 1, power: '1' });
  const elfTap = b({ on: 'tap', steps: [{ op: 'tapsfor', x: { kind: 'fixed', n: 1 }, colors: 'G' }] });
  const FIREBALL = card({ name: 'Green Fireball', manaCost: '{X}{G}', cmc: 1 });
  const idle = run([main(60, FOREST), main(39, BRICK), cmd(ELF)], [[ELF, elfTap]], { combat: 'all' });
  const busy = run([main(60, FOREST), main(39, FIREBALL), cmd(ELF)], [[ELF, elfTap]], { combat: 'all' });
  console.log(`       combat damage by turn 8: nothing to spend on ${f2(idle.combatDamage)}, an X spell to pour it into ${f2(busy.combatDamage)}`);
  // Not quite 7: an opener with no Forest casts the Elf a turn late.
  check(near(idle.combatDamage, 7, 0.05), `an Elf with nothing to pay for attacks every turn from 2 (${f2(idle.combatDamage)})`);
  check(busy.combatDamage < idle.combatDamage - 4, `an Elf paying for X spells attacks far less (${f2(busy.combatDamage)})`);
  // And never on a turn it paid: the note and an attack never share a turn.
  let tappedTurns = 0;
  let clash = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const tr = trace([main(60, FOREST), main(39, FIREBALL), cmd(ELF)], [[ELF, elfTap]], seed, { combat: 'all' });
    for (const tt of tr.turns) {
      const tapped = tt.lines.some((l) => l.text.includes('tapped for mana, so it does not attack'));
      const attacked = tt.lines.some((l) => l.text.startsWith('Attacks with'));
      if (tapped) tappedTurns++;
      if (tapped && attacked) clash++;
    }
  }
  check(tappedTurns > 100 && clash === 0, `it is tapped out on ${tappedTurns} turns in 40 games and attacks on none of them`);
  // Printed haste: attacks the turn it arrives.
  const GOBLIN = card({ name: 'Raging Goblin', typeLine: 'Creature — Goblin Berserker', manaCost: '{R}', cmc: 1, power: '1', oracleText: 'Haste' });
  const MOUNTAIN = land('Mountain', 'R', 1, false, 'Basic Land — Mountain');
  const hasty = run([main(99, MOUNTAIN), cmd(GOBLIN)], [], { combat: 'all' });
  check(near(hasty.combatDamage, 8), `a creature with haste attacks on turn 1 too (${f2(hasty.combatDamage)})`);
}

// ---------------------------------------------------------------------------
console.log('\n=== F3: tokens ===');
{
  const BALOTHS = card({ name: 'Rampaging Baloths', typeLine: 'Creature — Beast', manaCost: '{4}{G}{G}', cmc: 6, power: '6' });
  const beast = b({ on: 'enters', q: 't:land', steps: [{ op: 'token', x: { kind: 'fixed', n: 1 }, tk: 'beast' }] });
  const off = run([main(99, FOREST), cmd(BALOTHS)], [], { combat: 'all' });
  const on = run([main(99, FOREST), cmd(BALOTHS)], [[BALOTHS, beast]], { combat: 'all' });
  // Baloths on 6, attacks on 7 and 8 for 6. Beasts from the land drops on 7
  // and 8: the one from 7 attacks on 8, so +4.
  console.log(`       combat damage by turn 8: ${f2(off.combatDamage)} without the rule, ${f2(on.combatDamage)} with`);
  check(near(off.combatDamage, 12) && near(on.combatDamage, 16), 'Rampaging Baloths raises combat damage by turn 8 (12 -> 16)');
  // A Beast is a creature entering: it wakes a t:creature watcher.
  const WATCHER = card({ name: 'Guardian Project', typeLine: 'Enchantment', manaCost: '{3}{G}', cmc: 4 });
  const watch = b({ on: 'enters', q: 't:creature', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] });
  const deck: DeckRow[] = [main(99, FOREST), cmd(BALOTHS), { quantity: 1, board: 'commander', oracle: WATCHER }];
  const plain = run(deck, [[WATCHER, watch]], { combat: 'all' });
  const tokens = run(deck, [[WATCHER, watch], [BALOTHS, beast]], { combat: 'all' });
  const plainFires = plain.fires.find((f) => f.oracleId === WATCHER.oracleId)!.perGame;
  const tokenFires = tokens.fires.find((f) => f.oracleId === WATCHER.oracleId)!.perGame;
  check(near(plainFires, 1) && near(tokenFires, 3), `a Beast wakes a t:creature watcher (${f2(plainFires)} -> ${f2(tokenFires)} a game: Baloths, then two Beasts)`);
  const tr = trace(deck, [[WATCHER, watch], [BALOTHS, beast]], 3, { combat: 'all' });
  const board8 = tr.turns[7]!.board.permanents.map((p) => `${p.count}x ${p.card}`);
  check(tr.turns.some((tt) => tt.lines.some((l) => l.text.includes('creates 1 Beast'))), `the trace says it (${board8.join(', ')})`);
}

// ---------------------------------------------------------------------------
console.log('\n=== F4 + F5: Everflowing Chalice ===');
{
  // Lands that tap for four and arrive tapped: turn 1 has no mana, turn 2 has
  // four, so the Chalice is cast on turn 2 kicked twice and taps for two.
  const QUAD = land('Quad Land', 'C', 4, true);
  const CHALICE = card({ name: 'Everflowing Chalice', typeLine: 'Artifact', manaCost: '{0}', cmc: 0 });
  const chalice = withCast(
    b(
      { on: 'etb', steps: [{ op: 'counter', x: { kind: 'kicked' }, ck: 'charge' }] },
      { on: 'tap', steps: [{ op: 'tapsfor', x: { kind: 'counters' }, colors: 'C' }] },
    ),
    { kind: 'multikicker', cost: '{2}' },
  );
  const r = run([main(99, QUAD), cmd(CHALICE)], [[CHALICE, chalice]]);
  console.log(`       mana by turn: ${r.manaByTurn.slice(1, 5).map(f2).join('  ')}`);
  check(near(r.manaByTurn[2]!, 4) && near(r.manaByTurn[3]!, 10), 'cast for 4, it taps for {C}{C} (turn 3: 8 from lands + 2)');
  const t = trace([main(99, QUAD), cmd(CHALICE)], [[CHALICE, chalice]], 1);
  const castLine = t.turns[1]!.lines.find((l) => l.kind === 'cast')?.text ?? '';
  check(castLine.includes('kicked 2 times'), `the kick count follows the mana left (${castLine})`);
  // Plain lands: cast on 2 for two, kicked once, taps for one.
  const slow = run([main(99, WASTES), cmd(CHALICE)], [[CHALICE, chalice]]);
  check(near(slow.manaByTurn[3]!, 4), `cast for 2 it taps for {C} (turn 3 mana ${f2(slow.manaByTurn[3]!)})`);
}

// ---------------------------------------------------------------------------
console.log('\n=== F5: flashback and suspend ===');
{
  const THINK = card({ name: 'Think Twice', typeLine: 'Instant', manaCost: '{1}{U}', cmc: 2 });
  const draw1 = b({ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] });
  const deck = [main(60, ISLAND), main(39, THINK)];
  const once = run(deck, [[THINK, draw1]]);
  const twice = run(deck, [[THINK, withCast(draw1, { kind: 'flashback', cost: '{2}{U}' })]]);
  const a = once.fires[0]!.perGame;
  const f = twice.fires[0]!.perGame;
  console.log(`       Think Twice resolves ${f2(a)} times a game from hand alone, ${f2(f)} with flashback`);
  check(f > a * 1.3, 'a flashback draw spell casts again from the graveyard');
  const t = trace(deck, [[THINK, withCast(draw1, { kind: 'flashback', cost: '{2}{U}' })]], 11);
  const fb = t.turns.flatMap((tt) => tt.lines).filter((l) => l.text.includes('from the graveyard (flashback)'));
  const exiled = t.turns[7]!.board.exile.reduce((sum, p) => sum + p.count, 0);
  check(fb.length > 0 && exiled === fb.length, `and is exiled after (${fb.length} flashbacks, ${exiled} in exile)`);

  // Ancestral Visions as the commander: suspended on turn 1 with 4 counters,
  // cast for free at the upkeep of turn 5.
  const VISIONS = card({ name: 'Ancestral Visions', manaCost: '', cmc: 0 });
  const visions = withCast(b({ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 3 } }] }), { kind: 'suspend', cost: '{U}', n: 4 });
  const plain = run([main(99, ISLAND), cmd(VISIONS)]);
  const sus = run([main(99, ISLAND), cmd(VISIONS)], [[VISIONS, visions]]);
  const diff = (t: number) => sus.cardsSeenByTurn[t]! - plain.cardsSeenByTurn[t]!;
  check(near(diff(4), 0) && near(diff(5), 3), `a suspended card resolves 4 turns later for free (extra cards by 4: ${f2(diff(4))}, by 5: ${f2(diff(5))})`);
  const tv = trace([main(99, ISLAND), cmd(VISIONS)], [[VISIONS, visions]], 2);
  check(tv.turns[4]!.lines.some((l) => l.text.includes('comes off suspend')), 'the trace shows it coming off suspend on turn 5');
}

// ---------------------------------------------------------------------------
console.log('\n=== F6: statics ===');
{
  // Craterhoof on turn 1 off an eight-mana land, alone: 5 power, +1/+1.
  const BIG = land('Eight Land', 'G', 8);
  const HOOF = card({
    name: 'Craterhoof Behemoth',
    typeLine: 'Creature — Beast',
    manaCost: '{5}{G}{G}{G}',
    cmc: 8,
    power: '5',
    toughness: '5',
    oracleText: 'Haste\nWhen Craterhoof Behemoth enters, creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.',
  });
  const hoof = b({ on: 'etb', steps: [{ op: 'pump', x: { kind: 'creatures' } }] });
  const plain = run([main(99, BIG), cmd(HOOF)], [], { combat: 'all' });
  const pumped = run([main(99, BIG), cmd(HOOF)], [[HOOF, hoof]], { combat: 'all' });
  check(near(plain.combatDamageByTurn[1]!, 5) && near(pumped.combatDamageByTurn[1]!, 6), `Craterhoof alone swings for 5+1 (${f2(pumped.combatDamageByTurn[1]!)})`);
  check(near(pumped.combatDamageByTurn[2]! - pumped.combatDamageByTurn[1]!, 5), 'and the pump is gone next turn');
  // With four 1/1s out first it is 5 + 4 + 5 creatures x 5.
  const TOKEN_MAKER = card({ name: 'Raise the Alarm', typeLine: 'Instant', manaCost: '{W}', cmc: 1 });
  const alarm = b({ on: 'play', steps: [{ op: 'token', x: { kind: 'fixed', n: 4 }, tk: 'soldier' }] });
  const both: DeckRow[] = [main(99, land('Nine Land', 'GW', 9)), cmd(HOOF), { quantity: 1, board: 'commander', oracle: TOKEN_MAKER }];
  const army = run(both, [[HOOF, hoof], [TOKEN_MAKER, alarm]], { combat: 'all' });
  // Turn 1: Hoof (8) first, it is the priciest; Raise the Alarm (1) after,
  // so the Hoof counts only itself: 5+1 = 6. Turn 2 the soldiers are sick no
  // more: 5 + 4 = 9.
  check(near(army.combatDamageByTurn[1]!, 6) && near(army.combatDamageByTurn[2]! - army.combatDamageByTurn[1]!, 9), `soldiers made after the Hoof are not pumped (${army.combatDamageByTurn.slice(1, 3).map(f2).join(', ')})`);

  // Ashaya: nontoken creatures are Forest lands.
  const ASHAYA = card({ name: 'Ashaya, Soul of the Wild', typeLine: 'Legendary Creature — Elemental', manaCost: '{1}{G}', cmc: 2, power: '0' });
  const ashaya = b({ on: 'static', q: 't:creature -t:token', steps: [{ op: 'addtype', x: { kind: 'fixed', n: 1 }, ty: 'L', sub: 'G' }] });
  const COUNT = card({ name: 'Count the Lands', typeLine: 'Creature — Elf', manaCost: '{2}{G}', cmc: 3, power: '1' });
  const counter = b({ on: 'etb', steps: [{ op: 'draw', x: { kind: 'lands' } }] });
  const deckA: DeckRow[] = [main(99, FOREST), cmd(ASHAYA), { quantity: 1, board: 'commander', oracle: COUNT }];
  const noStatic = run(deckA, [[COUNT, counter]]);
  const withStatic = run(deckA, [[COUNT, counter], [ASHAYA, ashaya]]);
  // Turn 2 Ashaya, turn 3 the counter: 3 Forests, plus Ashaya and itself.
  const extra = withStatic.cardsSeenByTurn[3]! - noStatic.cardsSeenByTurn[3]!;
  check(near(extra, 2), `Ashaya makes creatures count in lands (+${f2(extra)} cards on turn 3: itself and the counter)`);
  const mana4 = withStatic.manaByTurn[4]! - noStatic.manaByTurn[4]!;
  check(near(mana4, 2), `and they tap for {G}: +${f2(mana4)} mana on turn 4`);
  const LANDFALL = card({ name: 'Lotus Cobra', typeLine: 'Creature — Snake', manaCost: '{G}', cmc: 1, power: '2' });
  const landfall = b({ on: 'enters', q: 't:land', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] });
  const deckB: DeckRow[] = [main(99, FOREST), cmd(ASHAYA), { quantity: 1, board: 'commander', oracle: LANDFALL }];
  const cobra = run(deckB, [[LANDFALL, landfall]]).fires[0]!.perGame;
  const cobraAshaya = run(deckB, [[LANDFALL, landfall], [ASHAYA, ashaya]]).fires.find((f) => f.oracleId === LANDFALL.oracleId)!.perGame;
  // Ashaya entering is a land entering too.
  check(near(cobraAshaya - cobra, 1), `a creature entering wakes a t:land watcher (${f2(cobra)} -> ${f2(cobraAshaya)} a game)`);

  // Badgermole Cub: one more {G} per creature tapped for mana.
  const ELF = card({ name: 'Llanowar Elves', typeLine: 'Creature — Elf Druid', manaCost: '{G}', cmc: 1, power: '1' });
  const elfTap = b({ on: 'tap', steps: [{ op: 'tapsfor', x: { kind: 'fixed', n: 1 }, colors: 'G' }] });
  const CUB = card({ name: 'Badgermole Cub', typeLine: 'Creature — Badger Mole', manaCost: '{1}{G}', cmc: 2, power: '2' });
  const cub = b({ on: 'static', q: 't:creature', steps: [{ op: 'extramana', x: { kind: 'fixed', n: 1 }, colors: 'G' }] });
  const deckC: DeckRow[] = [main(99, FOREST), cmd(ELF), { quantity: 1, board: 'commander', oracle: CUB }];
  const noCub = run(deckC, [[ELF, elfTap]]);
  const withCub = run(deckC, [[ELF, elfTap], [CUB, cub]]);
  check(near(withCub.manaByTurn[3]! - noCub.manaByTurn[3]!, 1), `Badgermole adds {G} per mana creature tapped (turn 3: ${f2(noCub.manaByTurn[3]!)} -> ${f2(withCub.manaByTurn[3]!)})`);

  // Ramunap: lands from the graveyard. A land-light deck of fetches.
  const WILDS = card({ name: 'Evolving Wilds', typeLine: 'Land', manaCost: '', cmc: 0, fetch: ['WUBRG', FETCH_BASIC_ONLY | MANA_TAPPED] });
  const RAMUNAP = card({ name: 'Ramunap Excavator', typeLine: 'Creature — Naga Cleric', manaCost: '{2}{G}', cmc: 3, power: '2' });
  const ramunap = b({ on: 'static', steps: [{ op: 'landfrom', x: { kind: 'fixed', n: 1 }, from: 'graveyard' }] });
  const light: DeckRow[] = [main(8, WILDS), main(12, FOREST), main(79, BRICK), cmd(RAMUNAP)];
  const noRamunap = run(light, [], { games: 8000 });
  const withRamunap = run(light, [[RAMUNAP, ramunap]], { games: 8000 });
  console.log(`       land drop on turn 8: ${f2(noRamunap.landDropByTurn[8]!)} -> ${f2(withRamunap.landDropByTurn[8]!)}`);
  check(withRamunap.landDropByTurn[8]! > noRamunap.landDropByTurn[8]! + 0.05, 'Ramunap replays a fetched land');
  let replayed = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const tr = trace(light, [[RAMUNAP, ramunap]], seed);
    replayed += tr.turns.flatMap((tt) => tt.lines).filter((l) => l.text.includes('Evolving Wilds from the graveyard')).length;
  }
  check(replayed > 0, `the trace shows Evolving Wilds played from the graveyard (${replayed} times in 30 games)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== cost ===');
{
  const deck = [main(38, FOREST), main(61, card({ name: 'Two', manaCost: '{1}{G}', cmc: 2 }))];
  for (const turns of [8, 10, 12]) {
    const t0 = performance.now();
    run(deck, [], { games: 20000, maxTurn: turns });
    console.log(`       20,000 games to turn ${turns}: ${Math.round(performance.now() - t0)}ms`);
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('object-sim: every check passes', () => {
  expect(failures).toBe(0);
});
