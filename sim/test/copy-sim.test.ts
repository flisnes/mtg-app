import { expect, test } from 'vitest';
// Rebuild plan §6 step 7: copies. A `copy` step makes token copies of the
// biggest permanent the criteria find (Rite of Replication, Kiki-Jiki), or
// lets the card holding the rule enter as one (Clone). Plus the `died` amount
// from the step 1 leftovers, which Mahadi's end step reads.
//
//   npx vitest run sim/test/copy-sim.test.ts
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
const BALOTH = card({ name: 'Baloth', typeLine: 'Creature — Beast', manaCost: '{2}{G}{G}', cmc: 4, power: '5', toughness: '5' });

const base: SimOptions = { ...defaultSimOptions('commander', true), games: 1000, mulligan: false, combat: 'all' };
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
const run = (rows: DeckRow[], behaviors?: Map<string, CardBehavior>, opts: Partial<SimOptions> = {}) => simulate(buildSimDeck(rows, behaviors), { ...base, ...opts });
const rules = (...pairs: [OracleCard, CardBehavior][]) => new Map<string, CardBehavior>(pairs.map(([o, b]) => [o.oracleId, b]));
const shape = (b: unknown) => JSON.stringify(b);
const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
console.log('\n=== the sanitizer keeps the copy step and the died amount ===');
{
  const b: CardBehavior = {
    v: 1,
    rules: [
      { on: 'play', steps: [{ op: 'copy', x: { kind: 'fixed', n: 1 }, q: 't:creature -t:legendary' }] },
      { on: 'activate', cost: { tap: true }, steps: [{ op: 'copy', x: { kind: 'fixed', n: 1 }, q: '-t:legendary t:creature', kw: 'H', eot: true }] },
      { on: 'etb', steps: [{ op: 'copy', x: { kind: 'fixed', n: 1 }, own: true }] },
      { on: 'endstep', steps: [{ op: 'treasure', x: { kind: 'died' } }] },
    ],
  };
  const clean = sanitizeCardBehavior(JSON.parse(shape(b)));
  check(shape(clean) === shape(b), `saves unchanged\n    wrote ${shape(b)}\n    saved ${shape(clean)}`);
  // A Clone's count is always one, so a stray count is normalized away.
  const own = sanitizeCardBehavior({ v: 1, rules: [{ on: 'etb', steps: [{ op: 'copy', x: { kind: 'fixed', n: 3 }, own: true }] }] });
  check(own?.rules[0]!.steps[0]!.x.n === 1, 'this-card-is-the-copy keeps a count of one');
  const compiled = compileBehavior(clean);
  check(!!compiled && compiled.play.length === 1 && compiled.activate.length === 1 && compiled.etb.length === 1 && compiled.endstep.length === 1, 'compiles into its buckets');
  for (const line of describeBehavior(clean)) console.log(`    ${line}`);
  const said = describeBehavior(clean).join(' | ');
  check(/create 1 token copy of your biggest permanent matching t:creature -t:legendary/.test(said), 'reads: a token copy of the biggest match');
  check(/with haste, sacrificed at the end of the turn/.test(said), 'reads: Kiki\'s haste and the end-step sacrifice');
  check(/this card enters as a copy of your biggest creature/.test(said), 'reads: Clone');
  check(/creatures of yours that died this turn/.test(said), 'reads: the died amount');
}

// ---------------------------------------------------------------------------
console.log('\n=== Rite of Replication: a token copy of the biggest creature, attacking next turn ===');
{
  // Forests, Bears, a few Baloths, and a {2}{U}{U}-shaped Rite in the command
  // zone that copies the biggest creature once. The copy is a 5/5 when a Baloth
  // is out, else a Bear, so combat damage goes up and the trace names it.
  const RITE = card({ name: 'Rite', typeLine: 'Sorcery', manaCost: '{2}{G}{G}', cmc: 4 });
  const rite = rules([RITE, { v: 1, rules: [{ on: 'play', steps: [{ op: 'copy', x: { kind: 'fixed', n: 1 } }] }] }]);
  const deck = [main(50, FOREST), main(39, BEAR), main(10, BALOTH), cmd(RITE)];
  const plain = run(deck);
  const copied = run(deck, rite);
  check(total(copied.damageByTurn) > total(plain.damageByTurn), `damage over the game rises with the copy: ${total(plain.damageByTurn).toFixed(1)} -> ${total(copied.damageByTurn).toFixed(1)}`);
  const g = traceGame(buildSimDeck(deck, rite), { ...base, trace: true }, 3);
  const line = g.turns.flatMap((t) => t.lines.map((l) => ({ turn: t.turn, text: l.text }))).find((l) => /creates 1 token copy of/.test(l.text));
  check(!!line, `the trace says so: ${line?.text ?? '(missing)'}`);
  // The copy is on the board as the card it copied, and there is one more of
  // that name than the library put there.
  if (line) {
    const turn = g.turns.find((t) => t.turn === line.turn)!;
    const name = /token copy of (.+)$/.exec(line.text)![1]!;
    const deckBuilt = buildSimDeck(deck, rite);
    const onBoard = turn.board.permanents.filter((p) => deckBuilt.cards[p.card]!.name === name).reduce((s, p) => s + p.count, 0);
    const castLines = g.turns.filter((t) => t.turn <= line.turn).flatMap((t) => t.lines).filter((l) => l.text.startsWith(`Casts ${name} `)).length;
    check(onBoard === castLines + 1, `${name}: ${castLines} cast, ${onBoard} on the battlefield at end of turn`);
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== Kiki-Jiki: a hasty copy for the turn, gone by the next ===');
{
  // Kiki in the command zone: {T}: a token copy of your biggest other creature
  // with haste, sacrificed at end of turn. The turn it activates, the attack is
  // one creature bigger; next turn the copy is nowhere.
  const KIKI = card({ name: 'Kiki', typeLine: 'Legendary Creature — Goblin Shaman', manaCost: '{2}{G}{G}{G}', cmc: 5, power: '2', toughness: '2', oracleText: 'Haste' });
  const kiki = rules([KIKI, { v: 1, rules: [{ on: 'activate', cost: { tap: true }, steps: [{ op: 'copy', x: { kind: 'fixed', n: 1 }, q: 't:creature -t:legendary', kw: 'H', eot: true }] }] }]);
  const deck = [main(50, FOREST), main(29, BEAR), main(20, BALOTH), cmd(KIKI)];
  const built = buildSimDeck(deck, kiki);
  let activations = 0;
  let hastyHits = 0;
  let goneNext = 0;
  let stayedNext = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const g = traceGame(built, { ...base, trace: true }, seed);
    for (let i = 0; i < g.turns.length; i++) {
      const t = g.turns[i]!;
      const made = t.lines.find((l) => /creates 1 token copy of (.+) until end of turn/.test(l.text));
      if (!made) continue;
      activations++;
      const name = /token copy of (.+) until end of turn/.exec(made.text)![1]!;
      const attack = t.lines.find((l) => l.text.startsWith('Attacks with'));
      // The copy swings: the attack line counts one more creature than the
      // board had of that name before the copy.
      const attackers = Number(/Attacks with (\d+) creature/.exec(attack?.text ?? '')?.[1] ?? 0);
      const bodies = t.board.permanents.filter((p) => (built.cards[p.card]!.types & 1) !== 0).reduce((s, p) => s + p.count, 0);
      if (attack && attackers >= 1 && bodies >= attackers) hastyHits++;
      const next = g.turns[i + 1];
      if (!next) continue;
      const nowOf = t.board.permanents.filter((p) => built.cards[p.card]!.name === name).reduce((s, p) => s + p.count, 0);
      const nextOf = next.board.permanents.filter((p) => built.cards[p.card]!.name === name).reduce((s, p) => s + p.count, 0);
      const castNext = next.lines.filter((l) => l.text.startsWith(`Casts ${name} `)).length;
      // Kiki goes again next turn, so a fresh copy of the same name may be there.
      const copiedNext = next.lines.filter((l) => new RegExp(`creates 1 token copy of ${name} until end of turn`).test(l.text)).length;
      const eatenNext = next.lines.filter((l) => new RegExp(`moves ${name} to`).test(l.text)).length;
      if (nextOf === nowOf - 1 + castNext + copiedNext - eatenNext) goneNext++;
      else stayedNext++;
    }
  }
  check(activations > 10, `Kiki activates in the traced games (${activations} times over 30 games)`);
  check(hastyHits === activations, `each copy is on the board the turn it is made (${hastyHits}/${activations})`);
  check(goneNext > 0 && stayedNext === 0, `and gone the next turn (${goneNext} gone, ${stayedNext} stayed)`);
  const plain = run(deck);
  const withKiki = run(deck, kiki);
  check(total(withKiki.damageByTurn) > total(plain.damageByTurn), `damage rises: ${total(plain.damageByTurn).toFixed(1)} -> ${total(withKiki.damageByTurn).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\n=== Clone: this card enters as a copy, and the copy\'s own entry rule fires ===');
{
  // Clone in the command zone copies the biggest creature. With Baloths that
  // draw a card on entry, the copy draws too (it is a Baloth), and the Clone
  // itself is nowhere on the board.
  const DRAWLOTH = card({ name: 'Drawloth', typeLine: 'Creature — Beast', manaCost: '{2}{G}{G}', cmc: 4, power: '5', toughness: '5' });
  const CLONE = card({ name: 'Clone', typeLine: 'Creature — Shapeshifter', manaCost: '{3}{G}', cmc: 4, power: '0', toughness: '0' });
  const both = rules(
    [DRAWLOTH, { v: 1, rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }] }],
    [CLONE, { v: 1, rules: [{ on: 'etb', steps: [{ op: 'copy', x: { kind: 'fixed', n: 1 }, own: true }] }] }],
  );
  const deck = [main(50, FOREST), main(20, BEAR), main(29, DRAWLOTH), cmd(CLONE)];
  const built = buildSimDeck(deck, both);
  let cloned = 0;
  let drewToo = 0;
  let cloneOnBoard = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const g = traceGame(built, { ...base, trace: true }, seed);
    for (const t of g.turns) {
      const line = t.lines.find((l) => /Clone enters as a copy of Drawloth/.test(l.text));
      if (!line) continue;
      cloned++;
      if (/draws/.test(line.text) || t.lines.some((l) => /Drawloth draws/.test(l.text))) drewToo++;
      if (t.board.permanents.some((p) => built.cards[p.card]!.name === 'Clone')) cloneOnBoard++;
    }
  }
  check(cloned > 5, `Clone entered as a Drawloth in ${cloned} traced turns`);
  check(drewToo === cloned, `the copied entry rule fired each time (${drewToo}/${cloned})`);
  check(cloneOnBoard === 0, 'and no Clone is left on the board as itself');
}

// ---------------------------------------------------------------------------
console.log('\n=== a token copy leaving the battlefield leaves no card behind ===');
{
  // A sacrifice spell in the deck eats a creature each time. With copies about,
  // a sacrificed copy fires the death and goes nowhere: the graveyard never
  // holds more Baloths than were cast.
  const RITE = card({ name: 'Rite', typeLine: 'Sorcery', manaCost: '{2}{G}{G}', cmc: 4 });
  const EAT = card({ name: 'Eat', typeLine: 'Sorcery', manaCost: '{G}', cmc: 1 });
  const b = rules(
    [RITE, { v: 1, rules: [{ on: 'play', steps: [{ op: 'copy', x: { kind: 'fixed', n: 2 } }] }] }],
    [EAT, { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'battlefield', to: 'graveyard', q: 't:beast' }] }] }],
  );
  const deck = [main(45, FOREST), main(20, EAT), main(24, BALOTH), main(10, RITE)];
  const built = buildSimDeck(deck, b);
  let violations = 0;
  let eaten = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = traceGame(built, { ...base, trace: true }, seed);
    let cast = 0;
    for (const t of g.turns) {
      cast += t.lines.filter((l) => l.text.startsWith('Casts Baloth ')).length;
      eaten += t.lines.filter((l) => /moves Baloth to your graveyard/.test(l.text)).length;
      const inYard = t.board.graveyard.filter((p) => built.cards[p.card]!.name === 'Baloth').reduce((s, p) => s + p.count, 0);
      if (inYard > cast) violations++;
    }
  }
  check(eaten > 20, `Baloths were sacrificed (${eaten} times over 40 games)`);
  check(violations === 0, `the graveyard never holds more Baloths than were cast (${violations} turns did)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== died: Mahadi makes a Treasure at end step for each creature that died ===');
{
  const MAHADI = card({ name: 'Mahadi', typeLine: 'Legendary Creature — Devil', manaCost: '{1}{G}{G}', cmc: 3, power: '3', toughness: '3' });
  const EAT = card({ name: 'Eat', typeLine: 'Sorcery', manaCost: '{G}', cmc: 1 });
  const b = rules(
    [MAHADI, { v: 1, rules: [{ on: 'endstep', steps: [{ op: 'treasure', x: { kind: 'died' } }] }] }],
    [EAT, { v: 1, rules: [{ on: 'play', steps: [{ op: 'move', x: { kind: 'fixed', n: 1 }, from: 'battlefield', to: 'graveyard', q: 't:bear' }] }] }],
  );
  const deck = [main(50, FOREST), main(24, EAT), main(25, BEAR), cmd(MAHADI)];
  const built = buildSimDeck(deck, b);
  let turnsWithDeaths = 0;
  let matched = 0;
  let quietTurns = 0;
  let quietRight = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const g = traceGame(built, { ...base, trace: true }, seed);
    let out = false;
    for (const t of g.turns) {
      if (t.lines.some((l) => l.text.startsWith('Casts Mahadi '))) out = true;
      if (!out) continue;
      const deaths = t.lines.filter((l) => /moves Grizzly Bears to your graveyard/.test(l.text)).length;
      const made = Number(/End step: Mahadi makes (\d+) Treasure/.exec(t.lines.find((l) => l.text.startsWith('End step: Mahadi'))?.text ?? '')?.[1] ?? 0);
      if (deaths > 0) {
        turnsWithDeaths++;
        if (made === deaths) matched++;
      } else {
        quietTurns++;
        if (made === 0) quietRight++;
      }
    }
  }
  check(turnsWithDeaths > 5, `turns with a Bear dying while Mahadi is out: ${turnsWithDeaths}`);
  check(matched === turnsWithDeaths, `each of them made exactly that many Treasures at the end step (${matched}/${turnsWithDeaths})`);
  check(quietRight === quietTurns, `and a turn with no deaths made none (${quietRight}/${quietTurns})`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('copy-sim: every check passes', () => {
  expect(failures).toBe(0);
});
