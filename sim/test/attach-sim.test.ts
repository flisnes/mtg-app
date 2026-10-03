import { expect, test } from 'vitest';
// Rebuild plan §6 step 2: Equipment and Auras, the floor version. The printed
// bonus is read off the card and sits on your best attacker while the
// attachment is out; no targeting, no equip cost. Decks are built so the
// answer can be worked out by hand: lands, vanilla 2/2s and the card under test
// in the command zone, so it is cast on the same turn in every game.
//
//   npx vitest run sim/test/attach-sim.test.ts
import { MANA_TAPPED, type OracleCard } from '../../shared/src/card.js';
import { KW_DOUBLE, KW_HASTE, KW_LIFELINK, KW_VIGILANCE, buildSimDeck, describeAttach, printedAttach, type DeckRow } from '../src/simDeck.js';
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

const EQUIP = (name: string, text: string, cost = '{3}', cmc = 3) => card({ name, typeLine: 'Artifact — Equipment', manaCost: cost, cmc, oracleText: text });
const AURA = (name: string, text: string, cost = '{1}{G}', cmc = 2) => card({ name, typeLine: 'Enchantment — Aura', manaCost: cost, cmc, oracleText: `Enchant creature\n${text}` });

const base: SimOptions = { ...defaultSimOptions('commander', true), games: 2000, mulligan: false, combat: 'all' };
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
const run = (rows: DeckRow[], opts: Partial<SimOptions> = {}) => simulate(buildSimDeck(rows), { ...base, ...opts });
interface Swing {
  turn: number;
  /** The turn the attachment under test was cast, or 0 when it has not been. */
  cast: number;
  text: string;
  /** Copies of each card on the battlefield at the end of the turn, by name. */
  board: Map<string, number>;
}
/** Every "Attacks with" line over `games` traced games, with when `name` was cast and the board. */
const attacks = (rows: DeckRow[], name: string, games: number): Swing[] => {
  const deck = buildSimDeck(rows);
  const out: Swing[] = [];
  for (let seed = 1; seed <= games; seed++) {
    const g = traceGame(deck, { ...base, trace: true }, seed);
    let cast = 0;
    for (const t of g.turns) {
      for (const l of t.lines) {
        if (l.text.startsWith(`Casts ${name} `)) cast = t.turn;
        if (!l.text.startsWith('Attacks with')) continue;
        const board = new Map<string, number>();
        for (const p of t.board.permanents) board.set(deck.cards[p.card]!.name, (board.get(deck.cards[p.card]!.name) ?? 0) + p.count);
        out.push({ turn: t.turn, cast, text: l.text, board });
      }
    }
  }
  return out;
};
const worn = (text: string): number => Number(/\((\d+) of it from Equipment/.exec(text)?.[1] ?? 0);

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
console.log('\n=== the reading ===');
{
  const sofi = printedAttach('Artifact — Equipment', 'Equipped creature gets +2/+2 and has protection from red and from blue.\nWhenever equipped creature deals combat damage to a player, this Equipment deals 2 damage to any target and you draw a card.\nEquip {2}');
  check(!!sofi && sofi.equipment && sofi.power === 2 && sofi.toughness === 2 && sofi.kw === 0 && sofi.per.kind === 'fixed', `Sword of Fire and Ice: +2/+2 (${describeAttach(sofi!)})`);
  const hammer = printedAttach('Artifact — Equipment', 'Equipped creature gets +10/+10 and loses flying.\nEquip {8} ({8}: Attach to target creature you control. Equip only as a sorcery.)');
  check(hammer?.power === 10 && hammer.toughness === 10, 'Colossus Hammer: +10/+10, the reminder text ignored');
  const glitters = printedAttach('Enchantment — Aura', 'Enchant creature\nEnchanted creature gets +1/+1 for each artifact and/or enchantment you control.');
  check(glitters?.per.kind === 'matching' && glitters.per.q === 't:artifact or t:enchantment' && glitters.power === 1 && !glitters.equipment, `All That Glitters: ${glitters ? describeAttach(glitters) : 'null'}`);
  const plating = printedAttach('Artifact — Equipment', 'Equipped creature gets +1/+0 for each artifact you control.\n{B}{B}: Attach this Equipment to target creature you control.\nEquip {1}');
  check(plating?.per.q === 't:artifact' && plating.power === 1 && plating.toughness === 0, 'Cranial Plating: +1/+0 per artifact');
  const shrieker = printedAttach('Artifact — Equipment', 'Equipped creature has double strike. (It deals both first-strike and regular combat damage.)\nEquip {2}');
  check(shrieker?.kw === KW_DOUBLE && shrieker.power === 0, `Fireshrieker: double strike alone (${describeAttach(shrieker!)})`);
  const greaves = printedAttach('Artifact — Equipment', 'Equipped creature has haste and shroud. (It can\'t be the target of spells or abilities.)\nEquip {0}');
  check(greaves?.kw === KW_HASTE, 'Lightning Greaves: haste');
  const cleave = printedAttach('Legendary Artifact — Equipment', 'Flash\nThis spell costs {1} less to cast for each attacking creature you control.\nWhen Embercleave enters, attach it to target creature you control.\nEquipped creature gets +1/+1 and has double strike and trample.\nEquip {3}');
  check(cleave?.power === 1 && cleave.kw === KW_DOUBLE, 'Embercleave: +1/+1 and double strike');
  const excalibur = printedAttach('Legendary Artifact — Equipment', 'Equipped creature gets +10/+0 and has vigilance.\nEquip legendary creature {3}\nEquip {7}');
  check(excalibur?.power === 10 && excalibur.toughness === 0 && excalibur.kw === KW_VIGILANCE, 'Excalibur: +10/+0 and vigilance');
  const rancor = printedAttach('Enchantment — Aura', 'Enchant creature\nEnchanted creature gets +2/+0 and has trample.\nWhen this Aura is put into a graveyard from the battlefield, return it to its owner\'s hand.');
  check(rancor?.power === 2 && rancor.toughness === 0 && !rancor.equipment, 'Rancor: +2/+0, an Aura');

  // Not read.
  check(printedAttach('Legendary Artifact — Equipment', 'Living weapon\nIndestructible\nEquipped creature gets +5/+5 and has first strike, trample, indestructible, haste, and "Whenever this creature deals combat damage to a creature, exile that creature."\nEquip {7}') === null, 'Kaldra Compleat (living weapon) is left to its shipped token');
  check(printedAttach('Artifact Creature — Equipment Lizard', 'Double strike\nEquipped creature has double strike.\nReconfigure {2}') === null, 'Lizard Blades (reconfigure, a creature) is not read');
  check(printedAttach('Enchantment — Aura', 'Enchant Forest\nAs this Aura enters, choose a color.\nWhenever enchanted Forest is tapped for mana, its controller adds an additional one mana of the chosen color.') === null, 'Utopia Sprawl (Enchant Forest) is not read');
  check(printedAttach('Enchantment — Aura', 'Enchant creature with another Aura attached to it\nEnchanted creature gets +3/+3 and has first strike, vigilance, and lifelink.') === null, 'Daybreak Coronet (needs another Aura) is not read');
  const caduceus = printedAttach('Legendary Artifact — Equipment', 'Equipped creature has lifelink.\nAs long as you have 30 or more life, equipped creature gets +5/+5 and has indestructible.\nEquip {W}{W}');
  check(caduceus?.kw === KW_LIFELINK && caduceus.power === 0, 'Caduceus: lifelink read, the +5/+5 behind "as long as" is not');
  check(printedAttach('Artifact — Equipment', 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}') === null, 'Skullclamp (+1/-1) is not read');
  check(printedAttach('Enchantment — Aura', 'Enchant creature\nEnchanted creature gets +2/+2 for each other enchantment on the battlefield.') === null, 'Ancestral Mask (per other enchantment, everyone\'s) is not read');
  check(printedAttach('Artifact — Equipment', 'Equipped creature gets +1/+1 for each color among permanents you control.\nEquip {2}') === null, 'Conqueror\'s Flail (per color) is not read');
  check(printedAttach('Artifact — Equipment', 'Equipped creature has indestructible.\nEquip {2}') === null, 'Darksteel Plate: nothing the model acts on');
  check(printedAttach('Creature — Elf', 'Equipped creature gets +2/+2.') === null, 'not an Equipment or Aura');
}

// ---------------------------------------------------------------------------
console.log('\n=== an Equipment: on from the turn after it lands, on the best attacker ===');
{
  // Forests and Bears, a {3} Sword in the command zone. Attacks before and on
  // the turn it is cast are bare; every attack after carries exactly +2.
  const SWORD = EQUIP('Sword', 'Equipped creature gets +2/+2.\nEquip {2}');
  const deck = [main(50, FOREST), main(49, BEAR), cmd(SWORD)];
  const swings = attacks(deck, 'Sword', 40);
  const before = swings.filter((s) => s.cast === 0 || s.turn === s.cast);
  const after = swings.filter((s) => s.cast > 0 && s.turn > s.cast);
  check(before.length > 0 && before.every((s) => worn(s.text) === 0), `attacks up to the turn the Sword lands wear nothing (${before.length} lines)`);
  check(after.length > 0 && after.every((s) => worn(s.text) === 2), `every attack after carries exactly +2 (${after.length} lines)`);
  // And the power on the line is the bears plus the sword.
  const one = after[0]!.text;
  const m = /Attacks with (\d+) creatures? for (\d+)/.exec(one);
  check(!!m && Number(m[2]) === 2 * Number(m[1]) + 2, `turn ${after[0]!.turn}: ${one}`);
  // Against the same deck with a do-nothing {3} artifact in the command zone
  // (cast the same turn, same shuffles), combat damage by turn 8 is up by +2 a
  // swing from turn 4: five swings, minus the games with no bear out yet.
  const BRICK3 = card({ name: 'Paperweight', typeLine: 'Artifact', manaCost: '{3}', cmc: 3 });
  const plain = run([main(50, FOREST), main(49, BEAR), cmd(BRICK3)]);
  const sword = run(deck);
  const lift = sword.combatDamageByTurn[8]! - plain.combatDamageByTurn[8]!;
  check(lift > 6 && lift <= 10, `combat damage by turn 8 up by ${lift.toFixed(2)} (up to five swings of +2, fewer when the Sword or a bear is late)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== an Aura: on as it resolves ===');
{
  // A {1}{G} Aura in the command zone: an attack on the very turn it is cast
  // already carries +2, since the Aura goes on a creature that can swing.
  const ARMOR = AURA('Armor', 'Enchanted creature gets +2/+0 and has trample.');
  const swings = attacks([main(50, FOREST), main(49, BEAR), cmd(ARMOR)], 'Armor', 40);
  const sameTurn = swings.filter((s) => s.cast > 0 && s.turn === s.cast);
  const unseen = swings.filter((s) => s.cast === 0);
  check(sameTurn.length > 0 && sameTurn.every((s) => worn(s.text) === 2), `attacks on the turn the Aura resolves carry +2 (${sameTurn.length} lines)`);
  check(unseen.every((s) => worn(s.text) === 0), `and nothing before it is cast (${unseen.length} lines)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== per permanent: +1/+0 per artifact counts the Equipment itself ===');
{
  const PLATING = EQUIP('Plating', 'Equipped creature gets +1/+0 for each artifact you control.\nEquip {1}', '{2}', 2);
  const ROCK = card({ name: 'Rock', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, produces: 'C', mana: [1, 1, 0] });
  // Rocks arrive as drawn. On a turn after the Plating landed with k rocks out
  // the bonus is k + 1. The board is the end-of-turn snapshot, and nothing
  // leaves it after combat here, so it is the board the attack saw.
  const swings = attacks([main(40, FOREST), main(39, BEAR), main(20, ROCK), cmd(PLATING)], 'Plating', 30);
  const after = swings.filter((s) => s.cast > 0 && s.turn > s.cast);
  const ok = after.every((s) => worn(s.text) === (s.board.get('Rock') ?? 0) + 1);
  check(after.length > 0 && ok, `the bonus is the artifacts out, Plating included (${after.length} attacks checked)`);
}

// ---------------------------------------------------------------------------
console.log('\n=== haste from an Equipment lets a fresh creature swing ===');
{
  const BOOTS = EQUIP('Boots', 'Equipped creature has haste and hexproof.\nEquip {1}', '{1}', 1);
  // The Boots land turn 1; a bear cast turn 2 attacks that turn, which a bear
  // without them never does.
  const lines = attacks([main(60, FOREST), main(39, BEAR), cmd(BOOTS)], 'Boots', 60);
  const bare = attacks([main(60, FOREST), main(39, BEAR)], 'Boots', 60);
  const t2 = lines.filter((s) => s.turn === 2).length;
  const t2bare = bare.filter((s) => s.turn === 2).length;
  check(t2 > 0 && t2bare === 0, `turn 2 attacks: ${t2bare} without the Boots, ${t2} with`);
}

// ---------------------------------------------------------------------------
console.log('\n=== nothing else moves ===');
{
  // A deck with no attachment reads the same with the new pass in place: the
  // Sword deck's numbers that do not touch combat equal the plain deck's.
  const plain = run([main(50, FOREST), main(49, BEAR)]);
  const sword = run([main(50, FOREST), main(49, BEAR), cmd(EQUIP('Sword', 'Equipped creature gets +2/+2.\nEquip {2}'))]);
  check(Math.abs(plain.manaByTurn[6]! - sword.manaByTurn[6]!) < 0.5, `mana on turn 6 ${plain.manaByTurn[6]!.toFixed(2)} vs ${sword.manaByTurn[6]!.toFixed(2)}`);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);

test('attach-sim: every check passes', () => {
  expect(failures).toBe(0);
});
