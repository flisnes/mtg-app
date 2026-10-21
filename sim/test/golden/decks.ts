// The golden deck set (rebuild plan §5 G0).
//
// One deck per grammar family, each lifted from the suite that owns the
// family, so a restructure of simulate() (G1-G3) has to reproduce every code
// path the suites exercise, byte for byte, before it is allowed in. The decks
// are not built to be worked out by hand the way the suites' are: they are
// built to *touch* things. A pile of ninety-nine with eight mechanics in it is
// a better tripwire than eight clean decks, and the suites already hold the
// clean ones.
//
// Synthetic cards with name-derived oracle ids, so adding a deck later moves
// nothing in the ones before it. Never reorder or rename a card in a deck that
// has a snapshot: that is a new deck, so give it a new id.
import type { OracleCard } from '../../../shared/src/card.js';
import { FETCH_BASIC_ONLY, MANA_ONE_SHOT, MANA_TAPPED, MANA_UNKNOWN } from '../../../shared/src/card.js';
import type { CardBehavior } from '../../../shared/src/behavior.js';
import type { SimGoal } from '../../src/goals.js';
import type { DeckRow } from '../../src/simDeck.js';
import type { SimOptions } from '../../src/simConfig.js';

export interface GoldenDeck {
  /** The snapshot file stem. */
  id: string;
  /** What the deck is for, one line. */
  note: string;
  rows: DeckRow[];
  behaviors?: [OracleCard, CardBehavior][];
  goals?: SimGoal[];
  /** Over the Commander defaults at 2,000 games. */
  opts?: Partial<SimOptions>;
  /** Three seeds, each traced in full. */
  seeds: [number, number, number];
}

const card = (o: Partial<OracleCard> & { name: string }): OracleCard =>
  ({
    oracleId: `g:${o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
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
const creature = (name: string, manaCost: string, cmc: number, power: number, toughness = power, extra: Partial<OracleCard> = {}) =>
  card({ name, typeLine: 'Creature — Beast', manaCost, cmc, power: String(power), toughness: String(toughness), ...extra });
const main = (quantity: number, oracle: OracleCard): DeckRow => ({ quantity, board: 'main', oracle });
const cmd = (oracle: OracleCard): DeckRow => ({ quantity: 1, board: 'commander', oracle });
const n = (k: number) => ({ kind: 'fixed' as const, n: k });
const b = (...rules: CardBehavior['rules']): CardBehavior => ({ v: 1, rules });

// The basics. `mana` is [kind, adds, flags]; kind 0 land, 1 rock, 2 dork, 3 landramp, 4 ritual, 5 extraland.
const FOREST = land('Forest', 'G', 1, false, 'Basic Land — Forest');
const ISLAND = land('Island', 'U', 1, false, 'Basic Land — Island');
const SWAMP = land('Swamp', 'B', 1, false, 'Basic Land — Swamp');
const MOUNTAIN = land('Mountain', 'R', 1, false, 'Basic Land — Mountain');
const PLAINS = land('Plains', 'W', 1, false, 'Basic Land — Plains');
const BEAR = creature('Grizzly Bears', '{1}{G}', 2, 2, 2, { typeLine: 'Creature — Bear' });
/** A spell nobody can cast inside eight turns: the filler that keeps a hand full. */
const BRICK = card({ name: 'Brick', manaCost: '{20}', cmc: 20 });

export const GOLDEN_DECKS: GoldenDeck[] = [];
const deck = (d: GoldenDeck) => GOLDEN_DECKS.push(d);

// ---------------------------------------------------------------------------
// 1. A plain curve under the app's defaults: mulligans, the table, answers held.
// ---------------------------------------------------------------------------
{
  const TWO = card({ name: 'Two Drop', manaCost: '{1}{G}', cmc: 2 });
  const THREE = card({ name: 'Three Drop', manaCost: '{2}{G}', cmc: 3 });
  const FIVE = card({ name: 'Five Drop', manaCost: '{4}{G}', cmc: 5 });
  deck({
    id: 'plain',
    note: 'flow-sim: 38 Forests under a 2/3/5 curve, every default knob as the app ships it',
    rows: [main(38, FOREST), main(21, TWO), main(21, THREE), main(19, FIVE)],
    seeds: [5, 155, 1],
  });
}

// ---------------------------------------------------------------------------
// 2. Ramp, rocks, draw and a watched trigger: the credit accounting.
// ---------------------------------------------------------------------------
{
  const OPT = card({ name: 'Opt', typeLine: 'Instant', manaCost: '{U}', cmc: 1, effect: [0, 1] });
  const DIVINATION = card({ name: 'Divination', manaCost: '{2}{U}', cmc: 3, effect: [0, 2] });
  const RAMPANT = card({ name: 'Rampant Growth', manaCost: '{1}{G}', cmc: 2, produces: 'G', mana: [3, 1, 0] });
  const CLAIM = card({ name: 'Skyshroud Claim', manaCost: '{3}{G}', cmc: 4, produces: 'G', mana: [3, 2, 0] });
  const SOL_RING = card({ name: 'Sol Ring', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, produces: 'C', mana: [1, 2, 0] });
  const SIGNET = card({ name: 'Simic Signet', typeLine: 'Artifact', manaCost: '{2}', cmc: 2, produces: 'GU', mana: [1, 1, 0] });
  const ELF = creature('Llanowar Elves', '{G}', 1, 1, 1, { typeLine: 'Creature — Elf Druid', produces: 'G', mana: [2, 1, 0] });
  const ARCHMAGE = creature('Archmage Emeritus', '{2}{U}{U}', 4, 2, 2, { typeLine: 'Creature — Human Wizard' });
  const BLANK = card({ name: 'Blank Spell', manaCost: '{1}{G}', cmc: 2 });
  deck({
    id: 'credit',
    note: 'credit-sim: land ramp, rocks, a dork, cantrips and a magecraft watcher, spend policy draw',
    rows: [main(20, FOREST), main(18, ISLAND), main(6, RAMPANT), main(4, CLAIM), main(3, SOL_RING), main(4, SIGNET), main(6, ELF), main(8, OPT), main(6, DIVINATION), main(4, ARCHMAGE), main(20, BLANK)],
    behaviors: [[ARCHMAGE, b({ on: 'cast', q: 't:instant OR t:sorcery', steps: [{ op: 'draw', x: n(1) }] })]],
    opts: { spend: 'draw' },
    seeds: [228, 1, 91],
  });
}

// ---------------------------------------------------------------------------
// 3. Rituals and the mana pool, landfall mana against a Treasure, an X spell.
// ---------------------------------------------------------------------------
{
  const DARK_RITUAL = card({ name: 'Dark Ritual', typeLine: 'Instant', manaCost: '{B}', cmc: 1, produces: 'B', mana: [4, 3, MANA_ONE_SHOT] });
  const FLOORED = card({ name: 'Floored Ritual', manaCost: '{2}{B}', cmc: 3, produces: 'B', mana: [4, 1, MANA_ONE_SHOT | MANA_UNKNOWN] });
  const COBRA = creature('Lotus Cobra', '{1}{B}', 2, 2, 1, { typeLine: 'Creature — Snake' });
  const DRYAD = creature('Treasure Dryad', '{1}{B}', 2, 1, 1, { typeLine: 'Creature — Dryad' });
  const FOUR_DROP = card({ name: 'Four Drop', manaCost: '{3}{B}', cmc: 4 });
  const FIREBALL = card({ name: 'Fireball', manaCost: '{X}{B}', cmc: 1 });
  deck({
    id: 'rituals',
    note: 'ritual-sim: Dark Ritual into four-drops, a floored ritual, landfall mana vs Treasure, an X spell last',
    rows: [main(36, SWAMP), main(10, DARK_RITUAL), main(5, FLOORED), main(8, COBRA), main(8, DRYAD), main(24, FOUR_DROP), main(8, FIREBALL)],
    behaviors: [
      [COBRA, b({ on: 'enters', q: 't:land', steps: [{ op: 'mana', x: n(1) }] })],
      [DRYAD, b({ on: 'enters', q: 't:land', steps: [{ op: 'treasure', x: n(1) }] })],
      [FIREBALL, b({ on: 'play', steps: [{ op: 'draw', x: { kind: 'xpaid' } }] })],
    ],
    opts: { opponents: 0 },
    seeds: [165, 7, 53],
  });
}

// ---------------------------------------------------------------------------
// 4. The limiter and the source recorder: colors, taplands, a granter, a fetch.
// ---------------------------------------------------------------------------
{
  const TAPPED_FOREST = land('Tapped Forest', 'G', 1, true);
  const UTILITY = land('Utility Land', 'C');
  const DUAL = land('Dual Land', 'GR');
  const YAVIMAYA = card({ name: 'Yavimaya, Cradle of Growth', typeLine: 'Land', cmc: 0, manaCost: '', produces: 'G', mana: [0, 1, 0], grants: 'G' });
  const WILDS = card({ name: 'Evolving Wilds', typeLine: 'Land', manaCost: '', cmc: 0, fetch: ['WUBRG', FETCH_BASIC_ONLY | MANA_TAPPED] });
  const STRAND = card({ name: 'Wooded Strand', typeLine: 'Land', cmc: 0, manaCost: '', fetch: ['GR', 0] });
  const GGG = card({ name: 'Triple Green', manaCost: '{G}{G}{G}', cmc: 3 });
  const RR = card({ name: 'Double Red Two', manaCost: '{R}{R}', cmc: 2 });
  const FIVE = card({ name: 'Five Generic', manaCost: '{4}{R}', cmc: 5 });
  const HYBRID = card({ name: 'Hybrid Three', manaCost: '{1}{R/G}{R/G}', cmc: 3 });
  deck({
    id: 'manabase',
    note: 'limiter-sim + sources-sim: a two-color base with taplands, a Yavimaya, two fetches, costs that miss on color, mana and tapped',
    rows: [main(10, FOREST), main(10, MOUNTAIN), main(6, TAPPED_FOREST), main(4, UTILITY), main(3, DUAL), main(1, YAVIMAYA), main(3, WILDS), main(3, STRAND), main(20, GGG), main(15, RR), main(14, FIVE), main(10, HYBRID)],
    opts: { opponents: 0 },
    seeds: [188, 44, 131],
  });
}

// ---------------------------------------------------------------------------
// 5. Statics: added types, extra mana, no max hand, lands from the yard, pump, haste.
// ---------------------------------------------------------------------------
{
  const ASHAYA = creature('Ashaya, Soul of the Wild', '{1}{G}', 2, 0, 0, { typeLine: 'Legendary Creature — Elemental' });
  const CUB = creature('Badgermole Cub', '{1}{G}', 2, 2);
  const ELF = creature('Llanowar Elves', '{G}', 1, 1, 1, { typeLine: 'Creature — Elf Druid' });
  const COUNT = creature('Count the Lands', '{2}{G}', 3, 1, 1, { typeLine: 'Creature — Elf' });
  const HOOF = creature('Craterhoof Behemoth', '{5}{G}{G}{G}', 8, 5, 5, { oracleText: 'Haste' });
  const TOWER = land('Reliquary Tower', 'C');
  const RAMUNAP = creature('Ramunap Excavator', '{2}{G}', 3, 2, 3, { typeLine: 'Creature — Naga Cleric' });
  const WILDS = card({ name: 'Evolving Wilds', typeLine: 'Land', manaCost: '', cmc: 0, fetch: ['WUBRG', FETCH_BASIC_ONLY | MANA_TAPPED] });
  const ANTHEM = card({ name: 'Glorious Anthem', typeLine: 'Enchantment', manaCost: '{1}{G}{G}', cmc: 3 });
  const FIRES = card({ name: 'Fires of Yavimaya', typeLine: 'Enchantment', manaCost: '{1}{G}', cmc: 2 });
  const LOTUS_COBRA = creature('Lotus Cobra', '{G}', 1, 2, 1, { typeLine: 'Creature — Snake' });
  deck({
    id: 'statics',
    note: 'object-sim F6: Ashaya, Badgermole, Reliquary Tower, Ramunap, an anthem, a haste grant, Craterhoof, a landfall watcher',
    rows: [main(36, FOREST), main(6, WILDS), main(2, TOWER), main(8, ELF), main(6, CUB), main(6, COUNT), main(4, RAMUNAP), main(4, ANTHEM), main(3, FIRES), main(6, LOTUS_COBRA), main(10, BEAR), main(8, BRICK), cmd(ASHAYA), cmd(HOOF)],
    behaviors: [
      [ASHAYA, b({ on: 'static', q: 't:creature -t:token', steps: [{ op: 'addtype', x: n(1), ty: 'L', sub: 'G' }] })],
      [CUB, b({ on: 'static', q: 't:creature', steps: [{ op: 'extramana', x: n(1), colors: 'G' }] })],
      [ELF, b({ on: 'tap', steps: [{ op: 'tapsfor', x: n(1), colors: 'G' }] })],
      [COUNT, b({ on: 'etb', steps: [{ op: 'draw', x: { kind: 'lands' } }] })],
      [HOOF, b({ on: 'etb', steps: [{ op: 'pump', x: { kind: 'creatures' } }] })],
      [TOWER, b({ on: 'static', steps: [{ op: 'nomaxhand', x: n(1) }] })],
      [RAMUNAP, b({ on: 'static', steps: [{ op: 'landfrom', x: n(1), from: 'graveyard' }] })],
      [ANTHEM, b({ on: 'static', q: 't:creature', steps: [{ op: 'pump', x: n(1) }] })],
      [FIRES, b({ on: 'static', q: 't:creature', steps: [{ op: 'keyword', x: n(1), kw: 'H' }] })],
      [LOTUS_COBRA, b({ on: 'enters', q: 't:land', steps: [{ op: 'draw', x: n(1) }] })],
    ],
    opts: { mulligan: false, combat: 'all', spend: 'creatures', opponents: 0 },
    seeds: [99, 116, 15],
  });
}

// ---------------------------------------------------------------------------
// 6. Tokens and copies: landfall beasts, a watcher, Rite, Kiki, Clone, Eat, Mahadi.
// ---------------------------------------------------------------------------
{
  const BALOTHS = creature('Rampaging Baloths', '{4}{G}{G}', 6, 6);
  const WATCHER = card({ name: 'Guardian Project', typeLine: 'Enchantment', manaCost: '{3}{G}', cmc: 4 });
  const RITE = card({ name: 'Rite of Replication', manaCost: '{2}{G}{G}', cmc: 4 });
  const KIKI = creature('Kiki-Jiki', '{2}{G}{G}{G}', 5, 2, 2, { typeLine: 'Legendary Creature — Goblin Shaman', oracleText: 'Haste' });
  const CLONE = creature('Clone', '{3}{G}', 4, 0, 0, { typeLine: 'Creature — Shapeshifter' });
  const DRAWLOTH = creature('Drawloth', '{2}{G}{G}', 4, 5);
  const EAT = card({ name: 'Eat', manaCost: '{G}', cmc: 1 });
  const MAHADI = creature('Mahadi', '{1}{G}{G}', 3, 3, 3, { typeLine: 'Legendary Creature — Devil' });
  const ALARM = card({ name: 'Raise the Alarm', typeLine: 'Instant', manaCost: '{G}', cmc: 1 });
  const BLOSSOM = card({ name: 'Bitterblossom', typeLine: 'Enchantment', manaCost: '{1}{G}', cmc: 2 });
  deck({
    id: 'tokens-copies',
    note: 'object-sim F3 + copy-sim: beasts off landfall, a creature watcher, Rite, Kiki, Clone, a sacrifice spell, Mahadi, Bitterblossom',
    rows: [main(40, FOREST), main(6, BALOTHS), main(4, WATCHER), main(5, RITE), main(8, DRAWLOTH), main(10, BEAR), main(8, EAT), main(6, ALARM), main(4, BLOSSOM), main(4, CLONE), main(4, BRICK), cmd(KIKI), cmd(MAHADI)],
    behaviors: [
      [BALOTHS, b({ on: 'enters', q: 't:land', steps: [{ op: 'token', x: n(1), tk: 'beast' }] })],
      [WATCHER, b({ on: 'enters', q: 't:creature', steps: [{ op: 'draw', x: n(1) }] })],
      [RITE, b({ on: 'play', steps: [{ op: 'copy', x: n(1), q: 't:creature -t:legendary' }] })],
      [KIKI, b({ on: 'activate', cost: { tap: true }, steps: [{ op: 'copy', x: n(1), q: 't:creature -t:legendary', kw: 'H', eot: true }] })],
      [CLONE, b({ on: 'etb', steps: [{ op: 'copy', x: n(1), own: true }] })],
      [DRAWLOTH, b({ on: 'etb', steps: [{ op: 'draw', x: n(1) }] })],
      [EAT, b({ on: 'play', steps: [{ op: 'move', x: n(1), from: 'battlefield', to: 'graveyard', q: 't:bear' }] })],
      [MAHADI, b({ on: 'endstep', steps: [{ op: 'treasure', x: { kind: 'died' } }] })],
      [ALARM, b({ on: 'play', steps: [{ op: 'token', x: n(2), tk: 'soldier' }] })],
      [BLOSSOM, b({ on: 'upkeep', steps: [{ op: 'loselife', x: n(1) }, { op: 'token', x: n(1), tk: 'custom', ty: 'C', tp: 1, tt: 1 }] })],
    ],
    opts: { mulligan: false, combat: 'all', opponents: 0 },
    seeds: [275, 390, 199],
  });
}

// ---------------------------------------------------------------------------
// 7. Attach: an Equipment, an Aura, per-permanent, haste boots, and a sweeper.
// ---------------------------------------------------------------------------
{
  const SWORD = card({ name: 'Sword', typeLine: 'Artifact — Equipment', manaCost: '{3}', cmc: 3, oracleText: 'Equipped creature gets +2/+2.\nEquip {2}' });
  const PLATING = card({ name: 'Plating', typeLine: 'Artifact — Equipment', manaCost: '{2}', cmc: 2, oracleText: 'Equipped creature gets +1/+0 for each artifact you control.\nEquip {1}' });
  const BOOTS = card({ name: 'Boots', typeLine: 'Artifact — Equipment', manaCost: '{1}', cmc: 1, oracleText: 'Equipped creature has haste and hexproof.\nEquip {1}' });
  const ARMOR = card({ name: 'Armor', typeLine: 'Enchantment — Aura', manaCost: '{1}{G}', cmc: 2, oracleText: 'Enchant creature\nEnchanted creature gets +2/+0 and has trample.' });
  const ROCK = card({ name: 'Rock', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, produces: 'C', mana: [1, 1, 0] });
  const EAT = card({ name: 'Eat', manaCost: '{G}', cmc: 1 });
  deck({
    id: 'attach',
    note: 'attach-sim: a Sword, a Plating, Boots, an Aura that dies with its bear, rocks to count, a sweeper',
    rows: [main(42, FOREST), main(28, BEAR), main(8, ROCK), main(4, PLATING), main(4, BOOTS), main(5, ARMOR), main(8, EAT), cmd(SWORD)],
    behaviors: [[EAT, b({ on: 'play', steps: [{ op: 'move', x: n(20), from: 'battlefield', to: 'graveyard', q: 't:creature' }] })]],
    opts: { mulligan: false, combat: 'all', opponents: 0 },
    seeds: [115, 91, 134],
  });
}

// ---------------------------------------------------------------------------
// 8. Ways to cast: evoke, foretell, plot, warp, madness, convoke, delve, an
//    additional sacrifice, impulse, flashback, suspend, multikicker.
// ---------------------------------------------------------------------------
{
  const DRIFTER = creature('Mulldrifter', '{4}{U}', 5, 2, 2, { typeLine: 'Creature — Elemental', oracleText: 'Flying\nWhen this creature enters, draw two cards.\nEvoke {2}{U}' });
  const BEHOLD = card({ name: 'Behold the Multiverse', typeLine: 'Instant', manaCost: '{3}{U}', cmc: 4, oracleText: 'Scry 2, then draw two cards.\nForetell {1}{U}' });
  const PLOTTER = card({ name: 'Pyretic Charge', manaCost: '{4}{U}', cmc: 5, oracleText: 'Draw two cards.\nPlot {3}{U}' });
  const WHALE = creature('Starbreach Whale', '{4}{U}', 5, 5, 5, { typeLine: 'Creature — Whale', oracleText: 'When this creature enters, draw a card.\nWarp {1}{U}' });
  const LOOT = card({ name: 'Faithless Looting', manaCost: '{U}', cmc: 1 });
  const MAD = creature('Muck Drubb', '{3}{U}{U}', 5, 3, 3, { oracleText: 'Madness {2}{U}' });
  const PRIMARCH = creature('Kavu Primarch', '{3}{U}', 4, 3, 3, { typeLine: 'Creature — Kavu', oracleText: 'Convoke' });
  const CANTRIP = card({ name: 'Opt', typeLine: 'Instant', manaCost: '{U}', cmc: 1 });
  const CRUISE = card({ name: 'Treasure Cruise', manaCost: '{6}{U}', cmc: 7, oracleText: 'Delve\nDraw three cards.' });
  const RITES = card({ name: 'Village Rites', typeLine: 'Instant', manaCost: '{U}', cmc: 1, oracleText: 'As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards.' });
  const STAGE = card({ name: 'Light Up the Stage', manaCost: '{U}', cmc: 1 });
  const THINK = card({ name: 'Think Twice', typeLine: 'Instant', manaCost: '{1}{U}', cmc: 2 });
  const VISIONS = card({ name: 'Ancestral Visions', manaCost: '', cmc: 0 });
  const CHALICE = card({ name: 'Everflowing Chalice', typeLine: 'Artifact', manaCost: '{0}', cmc: 0 });
  const BLUE_BEAR = creature('Blue Bears', '{1}{U}', 2, 2, 2, { typeLine: 'Creature — Bear' });
  const draw = (k: number) => b({ on: 'play', steps: [{ op: 'draw', x: n(k) }] });
  deck({
    id: 'cast-options',
    note: 'cast-sim + object-sim F4/F5: every printed way to cast, plus authored flashback, suspend and multikicker, spend policy curve',
    rows: [main(38, ISLAND), main(8, BLUE_BEAR), main(4, DRIFTER), main(4, BEHOLD), main(3, PLOTTER), main(4, WHALE), main(8, LOOT), main(6, MAD), main(3, PRIMARCH), main(6, CANTRIP), main(2, CRUISE), main(3, RITES), main(3, STAGE), main(4, THINK), main(3, CHALICE), cmd(VISIONS)],
    behaviors: [
      [DRIFTER, b({ on: 'etb', steps: [{ op: 'draw', x: n(2) }] })],
      [BEHOLD, draw(2)],
      [PLOTTER, draw(2)],
      [WHALE, b({ on: 'etb', steps: [{ op: 'draw', x: n(1) }] })],
      [LOOT, b({ on: 'play', steps: [{ op: 'draw', x: n(2) }, { op: 'discard', x: n(2) }] })],
      [CANTRIP, draw(1)],
      [CRUISE, draw(3)],
      [STAGE, b({ on: 'play', steps: [{ op: 'move', x: n(2), from: 'library', to: 'exile', play: 2 }] })],
      [THINK, { ...draw(1), cast: [{ kind: 'flashback', cost: '{2}{U}' }] }],
      [VISIONS, { ...draw(3), cast: [{ kind: 'suspend', cost: '{U}', n: 4 }] }],
      [
        CHALICE,
        {
          v: 1,
          rules: [
            { on: 'etb', steps: [{ op: 'counter', x: { kind: 'kicked' }, ck: 'charge' }] },
            { on: 'tap', steps: [{ op: 'tapsfor', x: { kind: 'counters' }, colors: 'C' }] },
          ],
          cast: [{ kind: 'multikicker', cost: '{2}' }],
        },
      ],
    ],
    opts: { mulligan: false, combat: 'all', spend: 'curve', opponents: 0 },
    seeds: [227, 386, 106],
  });
}

// ---------------------------------------------------------------------------
// 9. Grants and dredge: retrace, Future Sight, a flashback grant, lands with
//    dredge, a printed Dredge 6, an authored dredge, mills and loots.
// ---------------------------------------------------------------------------
{
  const SIX = creature('Six', '{2}{G}', 3, 3, 3, { typeLine: 'Legendary Creature — Treefolk' });
  const SIGHT = card({ name: 'Future Sight', typeLine: 'Enchantment', manaCost: '{2}{U}{U}{U}', cmc: 5 });
  const LIER = card({ name: 'Lier', typeLine: 'Legendary Creature — Human Wizard', manaCost: '{3}{U}{U}', cmc: 5, power: '3', toughness: '4' });
  const NECROBLOOM = creature('The Necrobloom', '{2}{G}{G}', 4, 3, 3, { typeLine: 'Legendary Creature — Plant Elemental' });
  const TROLL = creature('Golgari Grave-Troll', '{4}{G}', 5, 0, 0, { typeLine: 'Creature — Skeleton Troll', oracleText: 'Dredge 6 (If you would draw a card, you may mill six cards instead. If you do, return this card from your graveyard to your hand.)' });
  const LOAM = card({ name: 'Life from the Loam', manaCost: '{1}{G}', cmc: 2, oracleText: 'Return up to three target land cards from your graveyard to your hand.\nDredge 3' });
  const LOOT = card({ name: 'Faithless Looting', manaCost: '{U}', cmc: 1 });
  const MULCH = card({ name: 'Mulch', manaCost: '{1}{G}', cmc: 2 });
  const SELF_DREDGER = creature('Stinkweed Imp', '{2}{U}', 3, 1, 2, { typeLine: 'Creature — Imp' });
  const BOLT = card({ name: 'Lightning Bolt', typeLine: 'Instant', manaCost: '{U}', cmc: 1 });
  const HARMONIZE = card({ name: 'Harmonize', manaCost: '{2}{G}{G}', cmc: 4 });
  deck({
    id: 'grants-dredge',
    note: 'grants-sim + dredge-sim: Six, Future Sight, Lier, The Necrobloom, Grave-Troll, Loam, an authored dredge, Mulch and Looting',
    rows: [main(20, FOREST), main(18, ISLAND), main(6, MULCH), main(6, LOOT), main(3, TROLL), main(3, LOAM), main(3, SELF_DREDGER), main(4, BOLT), main(3, HARMONIZE), main(4, SIGHT), main(2, LIER), main(3, NECROBLOOM), main(24, BEAR), cmd(SIX)],
    behaviors: [
      [SIX, b({ on: 'static', steps: [{ op: 'grantcast', x: n(1), from: 'graveyard', gk: 'retrace', q: 'is:permanent -t:land' }] }, { on: 'attack', steps: [{ op: 'mill', x: n(3) }] })],
      [SIGHT, b({ on: 'static', steps: [{ op: 'grantcast', x: n(1), from: 'librarytop', gk: 'cast' }] })],
      [LIER, b({ on: 'static', steps: [{ op: 'grantcast', x: n(1), from: 'graveyard', gk: 'flashback', q: 't:instant or t:sorcery' }] })],
      [
        NECROBLOOM,
        b(
          { on: 'static', steps: [{ op: 'grantdredge', x: n(2), q: 't:land' }] },
          { on: 'enters', q: 't:land', cond: { x: { kind: 'matching', q: 't:land', uniq: true }, op: '<=', n: 6 }, steps: [{ op: 'token', x: n(1), tk: 'custom', ty: 'C', tp: 0, tt: 1 }] },
          { on: 'enters', q: 't:land', cond: { x: { kind: 'matching', q: 't:land', uniq: true }, op: '>=', n: 7 }, steps: [{ op: 'token', x: n(1), tk: 'zombie' }] },
        ),
      ],
      [LOOT, b({ on: 'play', steps: [{ op: 'draw', x: n(2) }, { op: 'discard', x: n(2) }] })],
      [MULCH, b({ on: 'play', steps: [{ op: 'mill', x: n(4) }, { op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand', q: 't:land' }] })],
      [SELF_DREDGER, b({ on: 'graveyard', steps: [{ op: 'dredge', x: n(5) }] })],
      [HARMONIZE, b({ on: 'play', steps: [{ op: 'draw', x: n(3) }] })],
      [BEAR, b({ on: 'etb', steps: [{ op: 'mill', x: n(2) }] })],
    ],
    opts: { mulligan: false, combat: 'all', opponents: 0 },
    seeds: [358, 343, 128],
  });
}

// ---------------------------------------------------------------------------
// 10. Goals and tutors: the plan's missing piece, a look at the top N, lethal.
// ---------------------------------------------------------------------------
{
  const DRAGON = creature('Big Dragon', '{3}{G}{G}', 5, 5, 5, { typeLine: 'Creature — Dragon' });
  const GOBLIN = creature('Goblin', '{G}', 1, 1, 1, { typeLine: 'Creature — Goblin' });
  const TUTOR = card({ name: 'Creature Tutor', manaCost: '{1}{G}', cmc: 2 });
  const TOP = card({ name: 'Top Tutor', typeLine: 'Instant', manaCost: '{G}', cmc: 1 });
  const MUXUS = creature('Muxus', '{2}{G}{G}', 4, 4, 4, { typeLine: 'Legendary Creature — Goblin Noble' });
  const HASTY = creature('Hasty Giant', '{2}{G}', 3, 5, 5, { typeLine: 'Creature — Giant', oracleText: 'Haste' });
  const CMDR = creature('Bear Commander', '{1}{G}', 2, 2, 2, { typeLine: 'Legendary Creature — Bear' });
  deck({
    id: 'goals',
    note: 'goals-sim: eight goals, a creature tutor steered by the plan, a tutor to the top, Muxus looking at six, hasty giants for the clock',
    rows: [main(36, FOREST), main(2, DRAGON), main(16, GOBLIN), main(6, TUTOR), main(4, TOP), main(3, MUXUS), main(12, HASTY), main(20, BEAR), cmd(CMDR)],
    behaviors: [
      [TUTOR, b({ on: 'play', steps: [{ op: 'move', x: n(1), from: 'library', to: 'hand', q: 't:creature' }] })],
      [TOP, b({ on: 'play', steps: [{ op: 'move', x: n(1), from: 'library', to: 'librarytop', q: 't:dragon' }] })],
      [MUXUS, b({ on: 'etb', steps: [{ op: 'move', x: { kind: 'all' }, from: 'library', to: 'battlefield', q: 't:goblin', win: 6, rest: 'graveyard' }] })],
    ],
    goals: [
      { id: 'lands4', turn: 4, terms: [{ kind: 'inPlay', n: 4, q: 't:land' }] },
      { id: 'mana4', turn: 4, terms: [{ kind: 'mana', n: 4 }] },
      { id: 'bear2', turn: 2, terms: [{ kind: 'cast', n: 1, q: 't:creature' }] },
      { id: 'cmdr4', turn: 4, terms: [{ kind: 'commander', n: 1 }] },
      { id: 'land1', turn: 1, terms: [{ kind: 'have', n: 1, q: 't:land' }] },
      { id: 'seen10', turn: 8, terms: [{ kind: 'drawn', n: 10, q: 't:creature' }] },
      { id: 'dragon', turn: 8, terms: [{ kind: 'cast', n: 1, q: 't:dragon' }] },
      { id: 'gobs', turn: 8, terms: [{ kind: 'inPlay', n: 6, q: 't:goblin' }, { kind: 'cast', n: 1, q: 't:creature' }] },
    ],
    opts: { combat: 'all', opponents: 0 },
    seeds: [120, 53, 11],
  });
}

// ---------------------------------------------------------------------------
// 11. The table: taxes, counters, removal, edicts, wheels, arrivals, amounts.
// ---------------------------------------------------------------------------
{
  const STUDY = card({ name: 'Study', typeLine: 'Enchantment', manaCost: '{2}{G}', cmc: 3 });
  const TITHE = card({ name: 'Tithe', typeLine: 'Enchantment', manaCost: '{3}{G}', cmc: 4 });
  const SENTINEL = creature('Sentinel', '{G}', 1, 1, 1, { typeLine: 'Creature — Human' });
  const COUNTER = card({ name: 'Counter', typeLine: 'Instant', manaCost: '{G}{G}', cmc: 2, oracleText: 'Counter target spell.' });
  const SWORDS = card({ name: 'Swords', typeLine: 'Instant', manaCost: '{G}', cmc: 1, oracleText: 'Exile target creature. Its controller gains life equal to its power.' });
  const ARTIST = creature('Artist', '{1}{G}', 2, 0, 1, { typeLine: 'Creature — Vampire' });
  const EDICT = card({ name: 'Edict', manaCost: '{1}{G}', cmc: 2 });
  const WHEEL = card({ name: 'Wheel', manaCost: '{2}{G}', cmc: 3 });
  const SHEOLDRED = creature('Sheoldred', '{2}{G}{G}', 4, 4, 5, { typeLine: 'Legendary Creature — Phyrexian' });
  const PRIEST = creature('Priest', '{1}{G}', 2, 1, 1, { typeLine: 'Creature — Cleric' });
  const TALLY = card({ name: 'Tally', manaCost: '{1}{G}', cmc: 2 });
  const rows = [main(36, FOREST), main(14, BEAR), main(5, STUDY), main(4, TITHE), main(4, SENTINEL), main(6, COUNTER), main(6, SWORDS), main(5, ARTIST), main(5, EDICT), main(4, WHEEL), main(3, SHEOLDRED), main(4, PRIEST), main(3, TALLY)];
  const behaviors: [OracleCard, CardBehavior][] = [
    [STUDY, b({ on: 'oppcast', tax: 1, steps: [{ op: 'draw', x: n(1) }] })],
    [TITHE, b({ on: 'oppdraw', tax: 2, steps: [{ op: 'treasure', x: n(1) }] })],
    [SENTINEL, b({ on: 'oppcast', q: '-t:creature', tax: 1, once: true, steps: [{ op: 'draw', x: n(1) }] })],
    [ARTIST, b({ on: 'oppdies', steps: [{ op: 'damage', x: n(1) }] })],
    [EDICT, b({ on: 'play', steps: [{ op: 'oppsac', x: n(1) }] })],
    [WHEEL, b({ on: 'play', steps: [{ op: 'oppdraws', x: n(1) }] })],
    [SHEOLDRED, b({ on: 'oppdraw', steps: [{ op: 'damage', x: n(2) }] })],
    [PRIEST, b({ on: 'oppenters', steps: [{ op: 'damage', x: n(1) }] })],
    [TALLY, b({ on: 'play', steps: [{ op: 'draw', x: { kind: 'opponents' } }] })],
  ];
  deck({
    id: 'table',
    note: 'table-sim: three busy opponents who rarely pay, answers held',
    rows,
    behaviors,
    opts: { opponents: 3, tempo: 'busy', pay: 'rarely', interaction: 'answer', combat: 'all' },
    seeds: [357, 13, 7],
  });
  deck({
    id: 'table-hold',
    note: 'table-sim: one quiet opponent who usually pays, every instant held up',
    rows,
    behaviors,
    opts: { opponents: 1, tempo: 'quiet', pay: 'usually', interaction: 'hold', combat: 'triggers' },
    seeds: [357, 88, 53],
  });
}

// ---------------------------------------------------------------------------
// 12. Lifegain and poison: lifelink, Pridemate, Bond, a tally, infect, toxic, Triumph.
// ---------------------------------------------------------------------------
{
  const LINKER = creature('Vampire Nighthawk', '{1}{W}', 2, 2, 3, { typeLine: 'Creature — Vampire', oracleText: 'Flying, deathtouch, lifelink' });
  const INFECTOR = creature('Blight Mamba', '{1}{W}', 2, 1, 1, { typeLine: 'Creature — Snake', oracleText: 'Infect (This creature deals damage to creatures in the form of -1/-1 counters and to players in the form of poison counters.)' });
  const TOXIC = creature('Venomous Rat', '{1}{W}', 2, 2, 2, { typeLine: 'Creature — Rat', oracleText: 'Toxic 1 (Players dealt combat damage by this creature also get a poison counter.)' });
  const PRIDEMATE = creature('Pridemate', '{1}{W}', 2, 2, 2, { typeLine: 'Creature — Cat Soldier' });
  const BOND = card({ name: 'Bond', typeLine: 'Enchantment', manaCost: '{3}{W}{W}', cmc: 5 });
  const TALLY = card({ name: 'Tally', typeLine: 'Enchantment', manaCost: '{1}{W}', cmc: 2 });
  const TRIUMPH = card({ name: 'Triumph', manaCost: '{2}{W}{W}', cmc: 4 });
  const WARDEN = creature('Soul Warden', '{W}', 1, 1, 1, { typeLine: 'Creature — Human Cleric' });
  const WHITE_BEAR = creature('White Bears', '{1}{W}', 2, 2, 2, { typeLine: 'Creature — Bear' });
  deck({
    id: 'lifegain-poison',
    note: 'lifegain-sim: lifelinkers, infect, toxic, Pridemate, Sanguine Bond, a life-gained tally, Soul Warden, Triumph of the Hordes',
    rows: [main(40, PLAINS), main(14, LINKER), main(8, INFECTOR), main(8, TOXIC), main(10, WHITE_BEAR), main(4, BOND), main(4, TALLY), main(3, TRIUMPH), main(4, WARDEN), main(4, BRICK), cmd(PRIDEMATE)],
    behaviors: [
      [PRIDEMATE, b({ on: 'lifegain', steps: [{ op: 'counter', x: n(1), ck: 'p1p1' }] })],
      [BOND, b({ on: 'lifegain', steps: [{ op: 'damage', x: { kind: 'cause' } }] })],
      [TALLY, b({ on: 'endstep', steps: [{ op: 'damage', x: { kind: 'lifegained' } }] })],
      [TRIUMPH, b({ on: 'play', steps: [{ op: 'pump', x: n(1) }, { op: 'keyword', x: n(1), kw: 'I' }] })],
      [WARDEN, b({ on: 'enters', q: 't:creature', steps: [{ op: 'gainlife', x: n(1) }] })],
    ],
    opts: { mulligan: false, combat: 'all', opponents: 0 },
    seeds: [392, 340, 12],
  });
}

// ---------------------------------------------------------------------------
// 13. Cost reduction: a Medallion, Animar, printed affinity.
// ---------------------------------------------------------------------------
{
  const MANCER = creature('Electromancer', '{R}{R}', 2, 2, 2, { typeLine: 'Creature — Goblin' });
  const ANIMAR = creature('Animar', '{U}{R}{G}', 3, 1, 1, { typeLine: 'Legendary Creature — Elemental' });
  const BOLT4 = card({ name: 'Big Bolt', typeLine: 'Instant', manaCost: '{3}{R}', cmc: 4 });
  const BEAR4 = creature('Big Bear', '{3}{R}', 4, 4, 4, { typeLine: 'Creature — Bear' });
  const ROCK = card({ name: 'Rock', typeLine: 'Artifact', manaCost: '{1}', cmc: 1, produces: 'C', mana: [1, 1, 0] });
  const MYR = creature('Myr Enforcer', '{7}', 7, 4, 4, { typeLine: 'Artifact Creature — Myr', oracleText: 'Affinity for artifacts (This spell costs {1} less to cast for each artifact you control.)' });
  const TOWER = land('Command Tower', 'URG');
  deck({
    id: 'discounts',
    note: 'discount-sim: an Electromancer, Animar counting its counters, Myr Enforcers off a pile of rocks',
    rows: [main(30, MOUNTAIN), main(10, TOWER), main(14, BOLT4), main(14, BEAR4), main(16, ROCK), main(10, MYR), main(5, BRICK), cmd(MANCER), cmd(ANIMAR)],
    behaviors: [
      [MANCER, b({ on: 'static', steps: [{ op: 'discount', x: n(1), q: 't:instant or t:sorcery' }] })],
      [ANIMAR, b({ on: 'cast', q: 't:creature', steps: [{ op: 'counter', x: n(1), ck: 'p1p1' }] }, { on: 'static', steps: [{ op: 'discount', x: { kind: 'counters' }, q: 't:creature' }] })],
    ],
    opts: { mulligan: false, combat: 'all', opponents: 0 },
    seeds: [397, 60, 31],
  });
}

// ---------------------------------------------------------------------------
// 14. Activations and E3: end steps, dies and sacrifice watchers, costs,
//     conditions, once a turn, picks, metalcraft, life as a price, War Room.
// ---------------------------------------------------------------------------
{
  const THOPTER = creature('Ornithopter', '{0}', 0, 0, 2, { typeLine: 'Artifact Creature — Thopter' });
  const ARTIST = creature('Blood Artist', '{1}{B}', 2, 0, 1, { typeLine: 'Creature — Vampire' });
  const SEER = creature('Viscera Seer', '{B}', 1, 1, 1, { typeLine: 'Creature — Vampire Wizard' });
  const BLOSSOM = card({ name: 'Bitterblossom', typeLine: 'Enchantment', manaCost: '{1}{B}', cmc: 2 });
  const STONE = card({ name: 'Mind Stone', typeLine: 'Artifact', manaCost: '{2}', cmc: 2, produces: 'C', mana: [1, 1, 0] });
  const DREADMAW = creature('Colossal Dreadmaw', '{4}{B}{B}', 6, 6, 6, { typeLine: 'Creature — Dinosaur' });
  const OPAL = card({ name: 'Mox Opal', typeLine: 'Legendary Artifact', manaCost: '{0}', cmc: 0, produces: 'WUBRG' });
  const ROOM = land('War Room', 'C');
  const THRESHOLD = card({ name: 'Threshold Engine', typeLine: 'Enchantment', manaCost: '{1}{B}', cmc: 2 });
  const EXPLORATION = card({ name: 'Exploration', typeLine: 'Enchantment', manaCost: '{B}', cmc: 1, mana: [5, 1, 0] });
  const LANDFALL = card({ name: 'Landfall Draw', typeLine: 'Enchantment', manaCost: '{1}{B}', cmc: 2 });
  const REANIMATOR = card({ name: 'Graveyard Engine', typeLine: 'Enchantment', manaCost: '{2}{B}', cmc: 3 });
  const RING = card({ name: 'Life Ring', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
  const CLUE_MAKER = creature('Investigator', '{1}{B}', 2, 1, 1, { typeLine: 'Creature — Human' });
  const BLACK_BEAR = creature('Black Bears', '{1}{B}', 2, 2, 2, { typeLine: 'Creature — Bear' });
  deck({
    id: 'activations',
    note: 'e3-sim: Blood Artist + Viscera Seer + Bitterblossom, Mind Stone, Clues, Mox Opal, War Room, threshold, once a turn, pick most, life as a price, ten turns',
    rows: [main(34, SWAMP), main(4, ROOM), main(6, THOPTER), main(5, ARTIST), main(5, SEER), main(4, BLOSSOM), main(5, STONE), main(4, DREADMAW), main(2, OPAL), main(3, THRESHOLD), main(3, EXPLORATION), main(3, LANDFALL), main(3, REANIMATOR), main(3, RING), main(5, CLUE_MAKER), main(10, BLACK_BEAR)],
    behaviors: [
      [THOPTER, b({ on: 'endstep', steps: [{ op: 'draw', x: n(1) }] }, { on: 'sacrifice', q: 't:artifact', steps: [{ op: 'draw', x: n(1) }] })],
      [ARTIST, b({ on: 'dies', q: 't:creature', steps: [{ op: 'damage', x: n(1) }] }, { on: 'death', steps: [{ op: 'damage', x: n(1) }] })],
      [SEER, b({ on: 'activate', cost: { sac: 1, sacq: 't:creature' }, steps: [{ op: 'scry', x: n(1) }] })],
      [BLOSSOM, b({ on: 'upkeep', steps: [{ op: 'loselife', x: n(1) }, { op: 'token', x: n(1), tk: 'custom', ty: 'C', tp: 1, tt: 1 }] })],
      [STONE, b({ on: 'activate', cost: { mana: '{1}', tap: true, self: true }, steps: [{ op: 'draw', x: n(1) }] })],
      [OPAL, b({ on: 'tap', cond: { x: { kind: 'matching', q: 't:artifact' }, op: '>=', n: 3 }, steps: [{ op: 'tapsfor', x: n(1) }] })],
      [ROOM, b({ on: 'activate', cost: { mana: '{3}', tap: true, life: 1 }, steps: [{ op: 'draw', x: n(1) }] })],
      [THRESHOLD, b({ on: 'upkeep', cond: { x: { kind: 'graveyard' }, op: '>=', n: 7 }, steps: [{ op: 'draw', x: n(1) }] })],
      [LANDFALL, b({ on: 'enters', q: 't:land', once: true, steps: [{ op: 'draw', x: n(1) }] })],
      [REANIMATOR, b({ on: 'upkeep', steps: [{ op: 'mill', x: n(3) }, { op: 'move', x: n(1), from: 'graveyard', to: 'battlefield', q: 't:creature', pick: 'most' }] })],
      [RING, b({ on: 'activate', cost: { life: 2 }, once: true, steps: [{ op: 'draw', x: n(1) }] })],
      [CLUE_MAKER, b({ on: 'etb', steps: [{ op: 'token', x: n(1), tk: 'clue' }] })],
    ],
    opts: { mulligan: false, combat: 'none', opponents: 0, maxTurn: 10 },
    seeds: [51, 16, 6],
  });
}

// ---------------------------------------------------------------------------
// 15. The cheap grammar batch: prowess, +X/+0, a criteria on a pump, counters
//     on each, "what woke it", a conditioned static, combat tokens, one-shots.
// ---------------------------------------------------------------------------
{
  const MONK = creature('Monk', '{1}{G}', 2, 2, 2, { typeLine: 'Creature — Monk' });
  const BOLT = card({ name: 'Bolt', typeLine: 'Instant', manaCost: '{G}', cmc: 1 });
  const BANNER = card({ name: 'Banner', typeLine: 'Enchantment', manaCost: '{1}{G}', cmc: 2 });
  const LORD = creature('Lord', '{1}{G}', 2, 1, 1, { typeLine: 'Creature — Elf' });
  const ELF = creature('Elf', '{1}{G}', 2, 1, 1, { typeLine: 'Creature — Elf' });
  const ANGEL = creature('Angel', '{3}{G}{G}', 5, 3, 4, { typeLine: 'Creature — Angel' });
  const SURGE = card({ name: 'Surge', typeLine: 'Enchantment', manaCost: '{1}{G}', cmc: 2 });
  const OX = creature('Ox', '{2}{G}', 3, 3, 3, { typeLine: 'Creature — Ox' });
  const SERRA = creature('Serra', '{G}', 1, 1, 1, { typeLine: 'Creature — Human Monk' });
  const CAPTAIN = creature('Captain', '{1}{G}', 2, 2, 2, { typeLine: 'Creature — Human' });
  const WARLORD = creature('Warlord', '{2}{G}', 3, 2, 2, { typeLine: 'Creature — Human' });
  const SAGA = card({ name: 'Saga', typeLine: 'Enchantment — Saga', manaCost: '{1}{G}', cmc: 2 });
  const STING = creature('Stinger', '{1}{G}', 2, 1, 1, { typeLine: 'Creature — Insect' });
  deck({
    id: 'grammar6',
    note: 'grammar6-sim: prowess, a +2/+0 anthem, a Lord pumping Elves, Thune counters, Warstorm Surge, Serra Ascendant, combat and attack tokens, a one-shot Saga, poison',
    rows: [main(38, FOREST), main(10, BOLT), main(10, ELF), main(8, BEAR), main(6, OX), main(4, BANNER), main(3, ANGEL), main(3, SURGE), main(3, SERRA), main(3, CAPTAIN), main(3, WARLORD), main(4, SAGA), main(4, STING), cmd(MONK), cmd(LORD)],
    behaviors: [
      [MONK, b({ on: 'cast', q: '-t:creature', steps: [{ op: 'pump', x: n(1), own: true }] })],
      [BANNER, b({ on: 'static', q: 't:creature', steps: [{ op: 'pump', x: n(2), po: true }] })],
      [LORD, b({ on: 'activate', cost: { tap: true }, steps: [{ op: 'pump', x: n(1), q: 't:elf' }, { op: 'keyword', x: n(1), kw: 'H', q: 't:elf' }] })],
      [ANGEL, b({ on: 'endstep', steps: [{ op: 'gainlife', x: n(1) }] }, { on: 'lifegain', steps: [{ op: 'counter', x: n(1), ck: 'p1p1', each: true, q: 't:creature' }] })],
      [SURGE, b({ on: 'enters', q: 't:creature', steps: [{ op: 'damage', x: { kind: 'cause' } }] })],
      [SERRA, b({ on: 'etb', oneshot: true, steps: [{ op: 'loselife', x: n(5) }] }, { on: 'static', cond: { x: { kind: 'life' }, op: '>=', n: 30 }, steps: [{ op: 'pump', x: n(5), own: true }] })],
      [CAPTAIN, b({ on: 'combat', steps: [{ op: 'token', x: n(1), tk: 'soldier', attacking: true }] })],
      [WARLORD, b({ on: 'attack', steps: [{ op: 'token', x: n(2), tk: 'soldier', attacking: true }] })],
      [SAGA, b({ on: 'upkeep', oneshot: true, steps: [{ op: 'draw', x: n(2) }] })],
      [STING, b({ on: 'attack', steps: [{ op: 'poison', x: n(1) }] })],
    ],
    opts: { mulligan: false, combat: 'all', onPlay: false, opponents: 0 },
    seeds: [139, 60, 153],
  });
}

// ---------------------------------------------------------------------------
// 16. Devotion and the floor: Gray Merchant, an Acolyte, Field of the Dead's
//     seven names, hybrid and gold pips, a Theros god, defender.
// ---------------------------------------------------------------------------
{
  const MERCHANT = creature('Gray Merchant of Asphodel', '{3}{B}{B}', 5, 2, 4, { typeLine: 'Creature — Zombie' });
  const ACOLYTE = creature("Karametra's Acolyte", '{3}{G}', 4, 1, 4, { typeLine: 'Creature — Human Druid' });
  const FIELD = land('Field of the Dead', 'C', 1, true);
  const FINKS = creature('Kitchen Finks', '{1}{G/W}{G/W}', 3, 3, 2, { typeLine: 'Creature — Ouphe' });
  const WOLF = creature('Watchwolf', '{G}{W}', 2, 3, 3, { typeLine: 'Creature — Wolf' });
  const POD = card({ name: 'Birthing Pod', typeLine: 'Artifact', manaCost: '{3}{G/P}', cmc: 4 });
  const KING = creature('Reaper King', '{2/W}{2/U}{2/B}{2/R}{2/G}', 10, 6, 6, { typeLine: 'Legendary Artifact Creature — Scarecrow' });
  const EREBOS = creature('Erebos, God of the Dead', '{3}{B}', 4, 5, 6, { typeLine: 'Legendary Enchantment Creature — God', oracleText: "Indestructible\nAs long as your devotion to black is less than five, Erebos isn't a creature.\nYour opponents can't gain life.\n{1}{B}, Pay 2 life: Draw a card." });
  const OBLITERATOR = creature('Phyrexian Obliterator', '{B}{B}{B}{B}', 4, 5, 5, { typeLine: 'Creature — Phyrexian Horror', oracleText: 'Trample' });
  const WALL = creature('Wall of Omens', '{1}{W}', 2, 0, 4, { typeLine: 'Creature — Wall', oracleText: 'Defender\nWhen this creature enters, draw a card.' });
  const BALOTH = creature('Leatherback Baloth', '{G}{G}{G}', 3, 4, 5);
  const COMMAND_TOWER = land('Command Tower', 'WBG');
  const ORCHARD = land('Exotic Orchard', 'WBG');
  const TEMPLE = land('Temple of the False God', 'C');
  const PATH = land('Path of Ancestry', 'WBG', 1, true);
  const FALLS = land('Thornwood Falls', 'G', 1, true);
  const HOLLOW = land('Jungle Hollow', 'BG', 1, true);
  const SANDS = land('Blossoming Sands', 'GW', 1, true);
  deck({
    id: 'devotion',
    note: 'devotion-sim + floor-sim: Gray Merchant drains, an Acolyte tapping for devotion, Field of the Dead over eleven land names, hybrid and gold pips, Erebos under and over five, a Wall with defender',
    rows: [main(7, SWAMP), main(7, FOREST), main(7, PLAINS), main(3, COMMAND_TOWER), main(3, ORCHARD), main(3, TEMPLE), main(3, PATH), main(3, FALLS), main(3, HOLLOW), main(3, SANDS), main(4, FIELD), main(10, MERCHANT), main(6, ACOLYTE), main(8, FINKS), main(8, WOLF), main(2, POD), main(1, KING), main(4, EREBOS), main(4, OBLITERATOR), main(4, WALL), main(6, BALOTH)],
    behaviors: [
      [MERCHANT, b({ on: 'etb', steps: [{ op: 'damage', x: { kind: 'devotion', c: 'B' } }] })],
      [ACOLYTE, b({ on: 'tap', steps: [{ op: 'tapsfor', x: { kind: 'devotion', c: 'G' }, colors: 'G' }] })],
      [FIELD, b({ on: 'enters', q: 't:land', cond: { x: { kind: 'matching', q: 't:land', uniq: true }, op: '>=', n: 7 }, steps: [{ op: 'token', x: n(1), tk: 'zombie' }] })],
      [WALL, b({ on: 'etb', steps: [{ op: 'draw', x: n(1) }] }, { on: 'attack', steps: [{ op: 'damage', x: n(3) }] })],
    ],
    opts: { mulligan: false, combat: 'all', opponents: 0 },
    seeds: [165, 74, 80],
  });
}

// ---------------------------------------------------------------------------
// 17. The rest of behavior-sim, in a sixty-card deck with no table: amounts
//     that read the state, order of steps, X and [X], library positions,
//     self, prev arithmetic, cast vs entry, a reanimation loop, flicker,
//     bounce, an attack draw, the derived profiles.
// ---------------------------------------------------------------------------
{
  const BLANK = card({ name: 'Blank Spell', manaCost: '{1}{U}', cmc: 2 });
  const DIVINATION = card({ name: 'Divination', manaCost: '{2}{U}', cmc: 3, effect: [0, 2] });
  const LOOTING = card({ name: 'Faithless Looting', manaCost: '{U}', cmc: 1, effect: [0, 2, 2] });
  const ARENA = card({ name: 'Phyrexian Arena', typeLine: 'Enchantment', manaCost: '{1}{U}{U}', cmc: 3, effect: [1, 1] });
  const BIG_SCORE = card({ name: 'Big Score', typeLine: 'Instant', manaCost: '{2}{U}', cmc: 3, effect: [0, 0, 1, 0, 0, 0, 2] });
  const TEMPLE = card({ name: 'Temple of Epiphany', typeLine: 'Land', cmc: 0, manaCost: '', produces: 'U', mana: [0, 1, MANA_TAPPED], effect: [0, 0, 0, 0, 0, 1] });
  const WINDFALL = card({ name: 'Windfall', manaCost: '{2}{U}', cmc: 3 });
  const FIREBALL = card({ name: 'Fireball', manaCost: '{X}{U}', cmc: 1 });
  const CHEAP = creature('Copper Myr', '{2}', 2, 1, 1, { typeLine: 'Artifact Creature — Myr' });
  const DEAR = creature('Colossus of Akros', '{8}', 8, 10, 10, { typeLine: 'Artifact Creature — Golem' });
  const BOMB = card({ name: 'Crucible of Worlds', typeLine: 'Artifact', manaCost: '{3}', cmc: 3 });
  const SEEK_TOP = card({ name: 'Mystical Tutor', typeLine: 'Instant', manaCost: '{U}', cmc: 1 });
  const ZENITH = card({ name: 'Zenith', manaCost: '{1}{U}', cmc: 2 });
  const ENGINE = card({ name: 'Durdle Engine', typeLine: 'Enchantment', manaCost: '{1}{U}', cmc: 2 });
  const BODY = creature('Big Body', '{4}{U}', 5, 4, 4, { typeLine: 'Creature — Avatar' });
  const RAISE = card({ name: 'Reanimator', manaCost: '{1}{U}', cmc: 2 });
  const PING = card({ name: 'Ping', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
  const PONG = card({ name: 'Pong', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 });
  const BLINK = card({ name: 'Blink', typeLine: 'Instant', manaCost: '{1}{U}', cmc: 2 });
  const BOUNCE = card({ name: 'Bounce', manaCost: '{U}', cmc: 1 });
  const EDRIC = creature('Edric', '{1}{U}', 2, 2, 2, { typeLine: 'Creature — Human Rogue' });
  const GIANT = creature('Hill Giant', '{2}{U}', 3, 3, 3, { typeLine: 'Creature — Giant' });
  const HALF = card({ name: 'Peer Into the Abyss', manaCost: '{4}{U}{U}', cmc: 6 });
  deck({
    id: 'behaviors',
    note: 'behavior-sim: the derived profiles, Windfall, X and [X], tutors to top and bottom, self, a reanimation loop with the depth guard, flicker, bounce, an attack draw; sixty cards, no commander, on the draw',
    rows: [main(20, ISLAND), main(4, TEMPLE), main(2, DIVINATION), main(2, LOOTING), main(1, ARENA), main(1, BIG_SCORE), main(2, WINDFALL), main(2, FIREBALL), main(2, CHEAP), main(1, DEAR), main(1, BOMB), main(2, SEEK_TOP), main(2, ZENITH), main(2, ENGINE), main(2, BODY), main(2, RAISE), main(2, PING), main(2, PONG), main(2, BLINK), main(1, BOUNCE), main(2, EDRIC), main(2, GIANT), main(1, HALF), main(1, BLANK)],
    behaviors: [
      [WINDFALL, b({ on: 'play', steps: [{ op: 'discard', x: { kind: 'hand' } }, { op: 'draw', x: { kind: 'prev', op: '-', by: 1 } }] })],
      [FIREBALL, b({ on: 'play', steps: [{ op: 'mill', x: n(3) }, { op: 'move', x: { kind: 'all' }, from: 'graveyard', to: 'hand', q: 't:creature mv<=[X]', qx: { kind: 'xpaid' } }] })],
      [SEEK_TOP, b({ on: 'play', steps: [{ op: 'move', x: n(1), from: 'library', to: 'librarytop', q: 'crucible' }] })],
      [ZENITH, b({ on: 'play', steps: [{ op: 'move', x: n(1), from: 'library', to: 'librarybottom', q: 't:island' }, { op: 'self', x: n(1), to: 'library' }] })],
      [ENGINE, b({ on: 'upkeep', steps: [{ op: 'draw', x: n(1) }, { op: 'self', x: n(1), to: 'graveyard' }] })],
      [BODY, b({ on: 'play', steps: [{ op: 'draw', x: n(1) }] }, { on: 'etb', steps: [{ op: 'draw', x: n(1) }] })],
      [RAISE, b({ on: 'play', steps: [{ op: 'mill', x: n(4) }, { op: 'move', x: n(1), from: 'graveyard', to: 'battlefield', q: 't:creature' }] })],
      [PING, b({ on: 'etb', steps: [{ op: 'draw', x: n(1) }, { op: 'move', x: n(1), from: 'library', to: 'battlefield', q: 'name:"Pong"' }] })],
      [PONG, b({ on: 'etb', steps: [{ op: 'draw', x: n(1) }, { op: 'move', x: n(1), from: 'library', to: 'battlefield', q: 'name:"Ping"' }] })],
      [BLINK, b({ on: 'play', steps: [{ op: 'flicker', x: n(1), q: 't:creature' }] })],
      [BOUNCE, b({ on: 'play', steps: [{ op: 'move', x: n(1), from: 'battlefield', to: 'hand', q: 't:island' }, { op: 'draw', x: { kind: 'creatures' } }] })],
      [EDRIC, b({ on: 'attack', steps: [{ op: 'draw', x: n(1) }] })],
      [GIANT, b({ on: 'death', steps: [{ op: 'draw', x: { kind: 'power' } }] })],
      [HALF, b({ on: 'play', steps: [{ op: 'draw', x: { kind: 'library', op: '/', by: 2 } }] })],
    ],
    opts: { format: undefined, onPlay: false, opponents: 0, combat: 'all' },
    seeds: [327, 62, 313],
  });
}
