import { expect, test } from 'vitest';
// Rebuild plan §6 step 4: ways to cast. Evoke, foretell, plot, warp, madness,
// convoke, delve and a printed "as an additional cost, sacrifice" are read off
// the card; an impulse draw is a `move` into exile the cards can be played
// from. Decks are built so the answer can be worked out by hand: lands, one
// creature kind, and the card under test.
//
//   npx vitest run sim/test/cast-sim.test.ts
import { MANA_TAPPED, type OracleCard } from '../../shared/src/card.js';
import { compileBehavior, describeBehavior, sanitizeCardBehavior, type CardBehavior } from '../../shared/src/behavior.js';
import { buildSimDeck, printedAdditionalSacrifice, printedCastOptions, type DeckRow } from '../src/simDeck.js';
import { defaultSimOptions, simulate, traceGame, type SimOptions } from '../src/simulate.js';

let seq = 0;
const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `o${seq++}`,
    typeLine: o.typeLine ?? 'Sorcery',
    cmc: o.cmc ?? 2,
    manaCost: o.manaCost ?? '{1}{U}',
    oracleText: o.oracleText ?? null,
    colorIdentity: '',
    colors: '',
    rarity: 'common',
    ...o,
  }) as OracleCard;
const land = (name: string, color: string, adds = 1, tapped = false, typeLine = 'Land') =>
  card({ name, typeLine, cmc: 0, manaCost: '', produces: color, mana: [0, adds, tapped ? MANA_TAPPED : 0] });
const ISLAND = land('Island', 'U', 1, false, 'Basic Land — Island');
const BEAR = card({ name: 'Grizzly Bears', typeLine: 'Creature — Bear', manaCost: '{1}{U}', cmc: 2, power: '2', toughness: '2' });
/** A spell nobody can cast inside eight turns: the filler that keeps a hand full. */
const BRICK = card({ name: 'Brick', manaCost: '{20}', cmc: 20 });

const base: SimOptions = { ...defaultSimOptions('commander', true), games: 2000, mulligan: false, combat: 'all' };
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
const run = (rows: DeckRow[], behaviors?: Map<string, CardBehavior>, opts: Partial<SimOptions> = {}) => simulate(buildSimDeck(rows, behaviors), { ...base, ...opts });
const rules = (...pairs: [OracleCard, CardBehavior][]) => new Map<string, CardBehavior>(pairs.map(([o, b]) => [o.oracleId, b]));
const lines = (rows: DeckRow[], behaviors: Map<string, CardBehavior> | undefined, seed: number) =>
  traceGame(buildSimDeck(rows, behaviors), { ...base, trace: true }, seed).turns.flatMap((t) => t.lines.map((l) => ({ turn: t.turn, text: l.text })));
const anyLine = (rows: DeckRow[], behaviors: Map<string, CardBehavior> | undefined, re: RegExp, seeds = 12): { turn: number; text: string } | undefined => {
  for (let s = 1; s <= seeds; s++) {
    const hit = lines(rows, behaviors, s).find((l) => re.test(l.text));
    if (hit) return hit;
  }
  return undefined;
};
const castBy = (r: ReturnType<typeof run>, o: OracleCard, turn: number) => r.cards.find((c) => c.oracleId === o.oracleId)?.castByTurn[turn] ?? 0;
const shape = (b: unknown) => JSON.stringify(b);
const f2 = (x: number) => x.toFixed(2);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
console.log('\n=== the grammar: new cast kinds and the playable-exile flag survive the sanitizer ===');
{
  const b: CardBehavior = {
    v: 1,
    rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 2 }, from: 'library', to: 'exile', play: 1 }] }],
    cast: [
      { kind: 'evoke', cost: '{2}{U}' },
      { kind: 'foretell', cost: '{1}{U}' },
      { kind: 'convoke' },
      { kind: 'madness', cost: '{U}' },
    ],
  };
  const clean = sanitizeCardBehavior(JSON.parse(shape(b)));
  check(shape(clean) === shape(b), `saves unchanged\n    wrote ${shape(b)}\n    saved ${shape(clean)}`);
  const text = describeBehavior(clean!);
  check(text[0]!.includes('playable this turn'), `the sentence says it is playable: ${text[0]}`);
  check(text.length === 5 && text.every((l) => l.length > 10), `every option has a sentence (${text.length})`);
  // `play` only means something into exile.
  const wrong = sanitizeCardBehavior({ v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'library', to: 'hand', play: 1 }] }] });
  check(!('play' in (wrong!.rules[0]!.steps[0] as object)), 'play is dropped on a move that is not into exile');
  // A fifth option is one too many; convoke and delve want no cost; a cost on them is dropped.
  const five = sanitizeCardBehavior({ v: 1, rules: [], cast: [{ kind: 'delve', cost: '{1}' }, { kind: 'plot', cost: '{2}{U}' }, { kind: 'warp', cost: '{U}' }, { kind: 'kicker', cost: '{1}' }, { kind: 'suspend', cost: '{U}', n: 3 }] });
  check(five!.cast!.length === 4 && !('cost' in five!.cast![0]!), `four options kept, delve without a cost (${shape(five!.cast)})`);
  check(compileBehavior(clean)!.options.length === 4, 'compiles with all four options');
}

// ---------------------------------------------------------------------------
console.log('\n=== the reading: printed keywords ===');
{
  const read = (text: string, b: CardBehavior | null = null) => printedCastOptions(text, compileBehavior(b ?? undefined)).map((o) => `${o.kind}${o.cost ? ` ${o.cost}` : ''}${o.n !== undefined ? ` n${o.n}` : ''}`);
  check(shape(read('Flying\nWhen this creature enters, draw two cards.\nEvoke {2}{U} (You may cast this spell for its evoke cost. If you do, it\'s sacrificed when it enters.)')) === shape(['evoke {2}{U}']), 'Mulldrifter: evoke, the reminder text ignored');
  check(shape(read('Foretell {1}{U} (During your turn, you may pay {2} and exile this card from your hand face down. Cast it on a later turn for its foretell cost.)')) === shape(['foretell {1}{U}']), 'foretell');
  check(shape(read('Plot {3}{R}')) === shape(['plot {3}{R}']), 'plot');
  check(shape(read('Warp {1}{U}')) === shape(['warp {1}{U}']), 'warp');
  check(shape(read('Madness {R}, cycling {1}{R}, kicker {2}{R}, flashback {3}{R}, buyback {4}{R}')) === shape(['madness {R}', 'flashback {3}{R}']), `a keyword list: madness and flashback read, cycling and buyback not, kicker not without a rule reading it (${read('Madness {R}, cycling {1}{R}, kicker {2}{R}, flashback {3}{R}, buyback {4}{R}').join(', ')})`);
  const kickRule: CardBehavior = { v: 1, rules: [{ on: 'etb', steps: [{ op: 'counter', x: { kind: 'kicked' }, ck: 'charge' }] }] };
  check(shape(read('Multikicker {2}', kickRule)) === shape(['multikicker {2}']), 'multikicker, when a rule reads the times it was kicked');
  check(read('Kicker—Sacrifice an artifact or Goblin.', kickRule).length === 0, 'a kicker that is not plain mana is not read');
  check(read('Kicker {B} and/or {R}', kickRule).length === 0, 'an and/or kicker is not read');
  check(shape(read('Convoke\nFlying')) === shape(['convoke']), 'convoke on its own line');
  check(shape(read('Flying, convoke')) === shape(['convoke']), 'convoke after another keyword');
  check(shape(read('Delve\nDraw two cards.')) === shape(['delve']), 'delve');
  check(shape(read('Escape—{2}{U}, Exile five other cards from your graveyard. (You may cast this card from your graveyard for its escape cost.)')) === shape(['escape {2}{U} n5']), 'escape with its exile count');
  check(shape(read('Suspend 4—{U} (Rather than cast this card from your hand, pay {U} and exile it with four time counters on it.)')) === shape(['suspend {U} n4']), 'suspend');
  check(shape(read('Retrace')) === shape(['retrace']), 'retrace');
  check(read('Creatures you control have convoke.').length === 0, 'a sentence granting a keyword is not one');
}

// ---------------------------------------------------------------------------
console.log('\n=== the reading: additional sacrifice ===');
{
  check(printedAdditionalSacrifice('As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.') === 't:creature', 'sacrifice a creature');
  check(printedAdditionalSacrifice('As an additional cost to cast this spell, sacrifice an artifact or creature.\nDraw two cards.') === 't:artifact or t:creature', 'an artifact or creature');
  check(printedAdditionalSacrifice('As an additional cost to cast this spell, sacrifice a permanent.') === '', 'a permanent is any');
  check(printedAdditionalSacrifice('As an additional cost to cast this spell, sacrifice a Goblin.') === null, 'a Goblin is not read');
  check(printedAdditionalSacrifice('As an additional cost to cast this spell, discard a card.') === null, 'a discard is not a sacrifice');
  check(printedAdditionalSacrifice('As an additional cost to cast this spell, sacrifice a creature or discard a card.') === null, 'an either/or is not read');
}

// ---------------------------------------------------------------------------
console.log('\n=== evoke: the cheap way in when the mana cost is out of reach ===');
{
  // Mulldrifter at five on Islands: hard cast on turn 5, evoked on turn 3 for
  // its two cards. The command zone keeps it in hand every game.
  const DRIFTER = card({ name: 'Mulldrifter', typeLine: 'Creature — Elemental', manaCost: '{4}{U}', cmc: 5, power: '2', toughness: '2', oracleText: 'Flying\nWhen this creature enters, draw two cards.\nEvoke {2}{U}' });
  const PLAIN = card({ name: 'Plain Drifter', typeLine: 'Creature — Elemental', manaCost: '{4}{U}', cmc: 5, power: '2', toughness: '2', oracleText: 'Flying\nWhen this creature enters, draw two cards.' });
  const etbDraw: CardBehavior = { v: 1, rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] };
  const evoked = run([main(99, ISLAND), cmd(DRIFTER)], rules([DRIFTER, etbDraw]));
  const hard = run([main(99, ISLAND), cmd(PLAIN)], rules([PLAIN, etbDraw]));
  const seenE3 = evoked.cardsSeenByTurn[3]! - hard.cardsSeenByTurn[3]!;
  check(Math.abs(seenE3 - 2) < 0.01, `evoked on turn 3: two more cards seen by turn 3 (${f2(seenE3)})`);
  check(evoked.combatDamageByTurn[8]! < hard.combatDamageByTurn[8]!, `an evoked Mulldrifter never attacks: damage ${f2(evoked.combatDamageByTurn[8]!)} vs ${f2(hard.combatDamageByTurn[8]!)} hard cast`);
  const t = lines([main(99, ISLAND), cmd(DRIFTER)], rules([DRIFTER, etbDraw]), 2);
  check(t.some((l) => l.turn === 3 && /Casts Mulldrifter for its evoke cost \(3 mana\)/.test(l.text)), 'the trace says it was evoked');
  check(t.some((l) => l.turn === 3 && /Mulldrifter is sacrificed \(evoked\)/.test(l.text)), 'and sacrificed');
  // Back in the command zone, it is evoked again on turn 5 (tax 2) and hard cast by turn 7.
  check(t.filter((l) => /Casts Mulldrifter/.test(l.text)).length >= 2, `cast more than once over the game (${t.filter((l) => /Casts Mulldrifter/.test(l.text)).length})`);
  // A card with nothing on arrival is not worth evoking.
  const BLANK = card({ name: 'Blank Elemental', typeLine: 'Creature — Elemental', manaCost: '{4}{U}', cmc: 5, power: '2', toughness: '2', oracleText: 'Evoke {2}{U}' });
  const deck = buildSimDeck([main(99, ISLAND), cmd(BLANK)]);
  check(deck.cards.find((c) => c.oracleId === BLANK.oracleId)!.evoke === null, 'a blank is not evoked');
  // A death watcher counts the evoked creature dying.
  const WATCHER = card({ name: 'Blood Artist', typeLine: 'Creature — Vampire', manaCost: '{U}', cmc: 1, power: '0', toughness: '1' });
  const dies: CardBehavior = { v: 1, rules: [{ on: 'dies', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] };
  const watched = run([main(60, ISLAND), main(39, WATCHER), cmd(DRIFTER)], rules([DRIFTER, etbDraw], [WATCHER, dies]));
  const fired = watched.fires.find((f) => f.oracleId === WATCHER.oracleId && f.on === 'dies');
  check(!!fired && fired.perGame > 0.5, `a dies watcher sees the evoked creature die (${fired?.perGame.toFixed(2)} a game)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== foretell and plot: set aside with spare mana, cast later ===');
{
  // Behold the Multiverse at {3}{U}, foretold for {2} and cast for {1}{U}: a
  // hand with one and nothing else to do foretells it the turn it has two
  // spare, then casts it for two, a turn before the hard cast at four. The
  // commander is never foretold (it is not in your hand), so the card rides
  // in the library.
  const BEHOLD = card({ name: 'Behold the Multiverse', typeLine: 'Instant', manaCost: '{3}{U}', cmc: 4, oracleText: 'Scry 2, then draw two cards.\nForetell {1}{U}' });
  const PLAIN = card({ name: 'Plain Behold', typeLine: 'Instant', manaCost: '{3}{U}', cmc: 4 });
  const draw2: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] };
  const told = run([main(70, ISLAND), main(29, BEHOLD)], rules([BEHOLD, draw2]));
  const hard = run([main(70, ISLAND), main(29, PLAIN)], rules([PLAIN, draw2]));
  check(told.cardsSeenByTurn[3]! > hard.cardsSeenByTurn[3]! + 0.5, `foretold: more cards by turn 3 (${f2(told.cardsSeenByTurn[3]!)} vs ${f2(hard.cardsSeenByTurn[3]!)})`);
  const hit = anyLine([main(70, ISLAND), main(29, BEHOLD)], rules([BEHOLD, draw2]), /Foretells Behold the Multiverse for \{2\}/);
  check(!!hit && hit.turn === 2, `the trace says it was foretold on turn 2${hit ? ` (turn ${hit.turn})` : ''}`);
  const cast = anyLine([main(70, ISLAND), main(29, BEHOLD)], rules([BEHOLD, draw2]), /Casts Behold the Multiverse from exile \(foretold, for its foretell cost\)/);
  check(!!cast && cast.turn === 3, `and cast from exile on turn 3${cast ? ` (turn ${cast.turn})` : ''}`);
  // A card castable now is cast, not foretold: once four lands are out, a
  // Behold is only ever foretold on a turn whose mana already went on a cast.
  const deckMany = buildSimDeck([main(70, ISLAND), main(29, BEHOLD)], rules([BEHOLD, draw2]));
  let idleTell = false;
  let hardCast = false;
  for (let s = 1; s <= 30; s++) {
    for (const t of traceGame(deckMany, { ...base, trace: true }, s).turns) {
      if (t.turn < 4) continue;
      const told = t.lines.some((l) => /Foretells/.test(l.text));
      const cast = t.lines.some((l) => /^Casts /.test(l.text));
      if (told && !cast) idleTell = true;
      if (t.lines.some((l) => /Casts Behold the Multiverse \{3\}\{U\}/.test(l.text))) hardCast = true;
    }
  }
  check(!idleTell && hardCast, 'with four lands out it is hard cast; a foretell only takes the mana a cast left over');
  const commanderTold = anyLine([main(99, ISLAND), cmd(BEHOLD)], rules([BEHOLD, draw2]), /Foretells/);
  check(!commanderTold, 'the commander is never foretold');

  // Plot: a five-drop plotted for {3}{U} on turn 4 (the first turn with four
  // mana and no five), cast for free on turn 5, leaving that turn's mana for
  // something else.
  const PLOTTER = card({ name: 'Pyretic Charge', typeLine: 'Sorcery', manaCost: '{4}{U}', cmc: 5, oracleText: 'Draw two cards.\nPlot {3}{U}' });
  const deckPlot = [main(70, ISLAND), main(29, PLOTTER)];
  const plot = anyLine(deckPlot, rules([PLOTTER, draw2]), /Plots Pyretic Charge for 4 mana/);
  check(!!plot && plot.turn === 4, `plotted on turn 4${plot ? ` (turn ${plot.turn})` : ''}`);
  const free = anyLine(deckPlot, rules([PLOTTER, draw2]), /Casts Pyretic Charge from exile \(plotted, for free\)/);
  check(!!free && free.turn === 5, `cast for free on turn 5${free ? ` (turn ${free.turn})` : ''}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== warp: in cheap, out at end step, back from exile ===');
{
  const WHALE = card({ name: 'Starbreach Whale', typeLine: 'Creature — Whale', manaCost: '{4}{U}', cmc: 5, power: '5', toughness: '5', oracleText: 'When this creature enters, draw a card.\nWarp {1}{U}' });
  const PLAIN = card({ name: 'Plain Whale', typeLine: 'Creature — Whale', manaCost: '{4}{U}', cmc: 5, power: '5', toughness: '5', oracleText: 'When this creature enters, draw a card.' });
  const etbDraw: CardBehavior = { v: 1, rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] };
  const deck = [main(70, ISLAND), main(29, WHALE)];
  const warped = run(deck, rules([WHALE, etbDraw]));
  const hard = run([main(70, ISLAND), main(29, PLAIN)], rules([PLAIN, etbDraw]));
  const inCheap = anyLine(deck, rules([WHALE, etbDraw]), /Casts Starbreach Whale for its warp cost \(2 mana\)/);
  check(!!inCheap && inCheap.turn <= 3, `warped early${inCheap ? ` (turn ${inCheap.turn})` : ''}`);
  check(!!anyLine(deck, rules([WHALE, etbDraw]), /Starbreach Whale is exiled at end of turn \(warp\)/), 'exiled at that end step');
  const back = anyLine(deck, rules([WHALE, etbDraw]), /Casts Starbreach Whale \{4\}\{U\} from exile \(warped\)/);
  check(!!back && back.turn >= 5, `cast again from exile for its mana cost${back ? ` (turn ${back.turn})` : ''}`);
  const fired = warped.fires.find((f) => f.oracleId === WHALE.oracleId && f.on === 'etb');
  const firedHard = hard.fires.find((f) => f.oracleId === PLAIN.oracleId && f.on === 'etb');
  check(!!fired && !!firedHard && fired.perGame > firedHard.perGame + 0.3, `its arrival fires more often a game (${fired?.perGame.toFixed(2)} vs ${firedHard?.perGame.toFixed(2)} hard cast)`);
  check(warped.combatDamageByTurn[8]! > 0, `and it attacks once it is back for good (${f2(warped.combatDamageByTurn[8]!)} damage by turn 8)`);
  // A warped commander goes back to the command zone instead of exile, and can be warped again.
  const t = lines([main(99, ISLAND), cmd(WHALE)], rules([WHALE, etbDraw]), 1);
  check(t.filter((l) => /for its warp cost/.test(l.text)).length >= 3, `a warped commander comes back to the command zone and is warped again (${t.filter((l) => /for its warp cost/.test(l.text)).length} times)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== madness: cast as it is discarded ===');
{
  const LOOT = card({ name: 'Faithless Looting', typeLine: 'Sorcery', manaCost: '{U}', cmc: 1 });
  const loot: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }, { op: 'discard', x: { kind: 'fixed', n: 2 } }] }] };
  const MAD = card({ name: 'Muck Drubb', typeLine: 'Creature — Beast', manaCost: '{3}{U}{U}', cmc: 5, power: '3', toughness: '3', oracleText: 'Madness {2}{U}' });
  // Islands, loots and the madness creature: the loot's discard takes the
  // card it would least miss, and a five-drop in a hand of lands is it.
  const deck = [main(40, ISLAND), main(30, LOOT), main(29, MAD)];
  const hit = anyLine(deck, rules([LOOT, loot]), /Casts Muck Drubb from the graveyard \(madness\)/, 30);
  check(!!hit, `a discarded Muck Drubb is cast for its madness cost the same turn${hit ? ` (turn ${hit.turn})` : ''}`);
  const withMad = run(deck, rules([LOOT, loot]));
  const PLAIN = card({ name: 'Plain Drubb', typeLine: 'Creature — Beast', manaCost: '{3}{U}{U}', cmc: 5, power: '3', toughness: '3' });
  const without = run([main(40, ISLAND), main(30, LOOT), main(29, PLAIN)], rules([LOOT, loot]));
  check(withMad.combatDamageByTurn[8]! > without.combatDamageByTurn[8]!, `madness puts more Drubbs on the board: ${f2(withMad.combatDamageByTurn[8]!)} vs ${f2(without.combatDamageByTurn[8]!)} damage`);
}

// ---------------------------------------------------------------------------
console.log('\n=== convoke: creatures pay the generic part ===');
{
  // A {4}{G} convoke creature with Bears out: turn 3, three lands and two
  // Bears pay five; without convoke it waits for turn 5.
  const PRIMARCH = card({ name: 'Kavu Primarch', typeLine: 'Creature — Kavu', manaCost: '{3}{U}', cmc: 4, power: '3', toughness: '3', oracleText: 'Convoke' });
  const PLAIN = card({ name: 'Plain Kavu', typeLine: 'Creature — Kavu', manaCost: '{3}{U}', cmc: 4, power: '3', toughness: '3' });
  const convoked = run([main(60, ISLAND), main(39, BEAR), cmd(PRIMARCH)]);
  const hard = run([main(60, ISLAND), main(39, BEAR), cmd(PLAIN)]);
  check(castBy(convoked, PRIMARCH, 4) === castBy(hard, PLAIN, 4), 'the castable-on-time mark still reads the printed cost (floor)');
  const t = lines([main(60, ISLAND), main(39, BEAR), cmd(PRIMARCH)], undefined, 1);
  const line = t.find((l) => /Casts Kavu Primarch .*convoking \d creature/.test(l.text));
  check(!!line && line.turn < 4, `cast with convoke before turn 4${line ? ` (turn ${line.turn}: ${line.text})` : ''}`);
  // The convoking Bears do not attack that turn.
  check(convoked.combatDamageByTurn[3]! <= hard.combatDamageByTurn[3]!, `tapped Bears skip combat: turn 3 damage ${f2(convoked.combatDamageByTurn[3]!)} vs ${f2(hard.combatDamageByTurn[3]!)}`);
  // Mana creatures are not convoked: with Elves only, nothing convokes.
  const ELF = card({ name: 'Llanowar Elves', typeLine: 'Creature — Elf Druid', manaCost: '{U}', cmc: 1, power: '1', toughness: '1', produces: 'U', mana: [2, 1, 0] });
  const elves = lines([main(60, ISLAND), main(39, ELF), cmd(PRIMARCH)], undefined, 1);
  check(!elves.some((l) => /convoking/.test(l.text)), 'a mana creature is not tapped for convoke');
}

// ---------------------------------------------------------------------------
console.log('\n=== delve: the graveyard pays the generic part ===');
{
  // Cantrips fill the graveyard; a {6}{U} delve draw spell comes down with
  // four lands and three cards in the yard.
  const CANTRIP = card({ name: 'Opt', typeLine: 'Instant', manaCost: '{U}', cmc: 1 });
  const draw1: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] };
  const CRUISE = card({ name: 'Treasure Cruise', typeLine: 'Sorcery', manaCost: '{6}{U}', cmc: 7, oracleText: 'Delve\nDraw three cards.' });
  const PLAIN = card({ name: 'Plain Cruise', typeLine: 'Sorcery', manaCost: '{6}{U}', cmc: 7, oracleText: 'Draw three cards.' });
  const draw3: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 3 } }] }] };
  const delved = run([main(50, ISLAND), main(49, CANTRIP), cmd(CRUISE)], rules([CANTRIP, draw1], [CRUISE, draw3]));
  const hard = run([main(50, ISLAND), main(49, CANTRIP), cmd(PLAIN)], rules([CANTRIP, draw1], [PLAIN, draw3]));
  check(delved.cardsSeenByTurn[6]! > hard.cardsSeenByTurn[6]! + 1, `delve casts it earlier: ${f2(delved.cardsSeenByTurn[6]!)} vs ${f2(hard.cardsSeenByTurn[6]!)} cards by turn 6`);
  const hit = anyLine([main(50, ISLAND), main(49, CANTRIP), cmd(CRUISE)], rules([CANTRIP, draw1], [CRUISE, draw3]), /Casts Treasure Cruise .*delving \d cards? from the graveyard/);
  check(!!hit && hit.turn <= 6, `the trace says what was delved${hit ? ` (turn ${hit.turn}: ${hit.text})` : ''}`);
  // A flashback card in the yard is kept.
  const FLASH = card({ name: 'Deep Analysis', typeLine: 'Sorcery', manaCost: '{3}{U}', cmc: 4, oracleText: 'Draw two cards.\nFlashback—{1}{U}, Pay 3 life.' });
  const deck = buildSimDeck([main(50, ISLAND), main(49, FLASH), cmd(CRUISE)]);
  check(deck.cards.find((c) => c.oracleId === FLASH.oracleId)!.gyCast === null, 'a flashback with life in its price is not read (floor)');
}

// ---------------------------------------------------------------------------
console.log('\n=== an additional sacrifice is a real cost ===');
{
  const RITES = card({ name: 'Village Rites', typeLine: 'Instant', manaCost: '{U}', cmc: 1, oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.' });
  // With no creature in the deck the Rites are never cast.
  const none = run([main(60, ISLAND), main(39, BRICK), cmd(RITES)]);
  const t = lines([main(60, ISLAND), main(39, BRICK), cmd(RITES)], undefined, 1);
  check(!t.some((l) => /Casts Village Rites/.test(l.text)), 'with nothing to sacrifice it waits in hand');
  check(none.manaSpentByTurn[8]! === 0, `and no mana is spent (${f2(none.manaSpentByTurn[8]!)})`);
  // With Bears, the card with no rule of its own sacrifices one as it is cast.
  const bears = lines([main(60, ISLAND), main(39, BEAR), cmd(RITES)], undefined, 1);
  const hit = bears.find((l) => /Casts Village Rites .*sacrificing Grizzly Bears/.test(l.text));
  check(!!hit, `with a Bear out it is cast, sacrificing the Bear${hit ? ` (turn ${hit.turn})` : ''}`);
  // With a rule of its own (the shipped verdicts' shape), the rule pays.
  const rites: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'battlefield', to: 'graveyard', q: 't:creature' }, { op: 'draw', x: { kind: 'prev', op: '*', by: 2 } }] }] };
  const ruled = lines([main(60, ISLAND), main(39, BEAR), cmd(RITES)], rules([RITES, rites]), 1);
  const cast = ruled.find((l) => /Casts Village Rites/.test(l.text));
  check(!!cast && !/sacrificing/.test(cast.text), 'with a rule, the rule does the sacrificing');
  check(ruled.some((l) => /Village Rites moves Grizzly Bears to your graveyard, draws \w+/.test(l.text)), 'and it draws');
  // The gate still holds for the ruled card: no Bear, no cast.
  const gated = lines([main(60, ISLAND), main(39, BRICK), cmd(RITES)], rules([RITES, rites]), 1);
  check(!gated.some((l) => /Casts Village Rites/.test(l.text)), 'a ruled card still waits for something to sacrifice');
}

// ---------------------------------------------------------------------------
console.log('\n=== impulse: exiled playable this turn, or through the next ===');
{
  // Light Up the Stage at {R} on Mountains and Bears: the two cards off the
  // top are playable through next turn; a Bear among them gets cast.
  const STAGE = card({ name: 'Light Up the Stage', typeLine: 'Sorcery', manaCost: '{U}', cmc: 1 });
  const impulse2: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 2 }, from: 'library', to: 'exile', play: 2 }] }] };
  const impulse1: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 2 }, from: 'library', to: 'exile', play: 1 }] }] };
  const asDraw: CardBehavior = { v: 1, rules: [{ on: 'play', steps: [{ op: 'draw', x: { kind: 'fixed', n: 2 } }] }] };
  const deck = [main(40, ISLAND), main(49, BEAR), main(10, STAGE)];
  const next = run(deck, rules([STAGE, impulse2]));
  const now = run(deck, rules([STAGE, impulse1]));
  const drawn = run(deck, rules([STAGE, asDraw]));
  // Seen, like a draw; a little under it, since fewer of the exiled Stages get cast in their window.
  check(next.cardsSeenByTurn[8]! > 16 && next.cardsSeenByTurn[8]! <= drawn.cardsSeenByTurn[8]!, `the exiled cards count as seen (${f2(next.cardsSeenByTurn[8]!)}, a draw reads ${f2(drawn.cardsSeenByTurn[8]!)})`);
  check(now.combatDamageByTurn[8]! < next.combatDamageByTurn[8]! && next.combatDamageByTurn[8]! < drawn.combatDamageByTurn[8]!, `fewer Bears reach the board than a draw would give, fewer still with one turn: ${f2(now.combatDamageByTurn[8]!)} < ${f2(next.combatDamageByTurn[8]!)} < ${f2(drawn.combatDamageByTurn[8]!)} damage`);
  const hit = anyLine(deck, rules([STAGE, impulse2]), /Casts Grizzly Bears \{1\}\{U\} from exile \(exiled\)/);
  check(!!hit, `a Bear is cast out of exile${hit ? ` (turn ${hit.turn})` : ''}`);
  const stays = anyLine(deck, rules([STAGE, impulse1]), /stays in exile: the turn to play it has passed/);
  check(!!stays, `an unplayed card stays in exile when its turn passes${stays ? ` (turn ${stays.turn}: ${stays.text})` : ''}`);
  // A land exiled this way is not played (the floor): no Island is ever cast or played from exile.
  check(!anyLine(deck, rules([STAGE, impulse2]), /Island.*from exile/), 'a land is not played from exile');
}

// ---------------------------------------------------------------------------
console.log('\n=== a deck with none of this reads as before ===');
{
  const a = run([main(60, ISLAND), main(39, BEAR)]);
  const b = run([main(60, ISLAND), main(39, BEAR)]);
  check(shape(a.cardsSeenByTurn) === shape(b.cardsSeenByTurn) && shape(a.combatDamageByTurn) === shape(b.combatDamageByTurn), 'deterministic');
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('cast-sim', () => {
  expect(failures).toBe(0);
});
