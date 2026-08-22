// The Magic symbols a deck, binder or box can wear as its emblem (see
// ContainerEmblem). Every one is a glyph in the bundled Mana font
// (src/vendor/mana), drawn as `ms ms-${sym}`.
//
// The font ships ~550 glyphs, most of them ability reminders and
// printing-specific variants nobody would pick to label a deck, so this is a
// curated slice: pips, the iconic symbols, card types, factions, counters and
// the keywords. Labels are derived from the names ("double-strike" → "Double
// strike"), so a group is mostly a prefix and a word list; only names that
// don't read well in English spell their label out.

/** A name, or a [name, label] pair when the derived label won't do. */
type Entry = string | readonly [name: string, label: string];

interface GroupSpec {
  title: string;
  /** Prepended to every name to form the Mana font class suffix. */
  prefix?: string;
  /** Appended to every derived label ("Charge" → "Charge counter"). */
  suffix?: string;
  entries: readonly Entry[];
}

const GROUPS: readonly GroupSpec[] = [
  {
    title: 'Mana',
    entries: [
      ['w', 'White'],
      ['u', 'Blue'],
      ['b', 'Black'],
      ['r', 'Red'],
      ['g', 'Green'],
      ['c', 'Colorless'],
      ['x', 'Generic X'],
      ['s', 'Snow'],
      ['e', 'Energy'],
      ['p', 'Phyrexian'],
      ['wu', 'White/Blue'],
      ['ub', 'Blue/Black'],
      ['br', 'Black/Red'],
      ['rg', 'Red/Green'],
      ['gw', 'Green/White'],
      ['wb', 'White/Black'],
      ['ur', 'Blue/Red'],
      ['bg', 'Black/Green'],
      ['rw', 'Red/White'],
      ['gu', 'Green/Blue'],
      ['wp', 'White Phyrexian'],
      ['up', 'Blue Phyrexian'],
      ['bp', 'Black Phyrexian'],
      ['rp', 'Red Phyrexian'],
      ['gp', 'Green Phyrexian'],
    ],
  },
  {
    title: 'Symbols',
    entries: [
      'tap',
      'untap',
      'chaos',
      'commander',
      'planeswalker',
      ['multicolor', 'Multicolored'],
      'saga',
      'token',
      'dungeon',
      'ticket',
      'acorn',
      'infinity',
      'paw',
      'graveyard',
      'exile',
      'library',
      'hand',
      'flashback',
      ['level', 'Level up'],
      'power',
      'toughness',
      'defense',
      ['artist-brush', "Artist's brush"],
      ['artist-nib', "Artist's nib"],
    ],
  },
  {
    title: 'Card types',
    entries: [
      'artifact',
      'creature',
      'enchantment',
      'instant',
      'land',
      'sorcery',
      'battle',
      'tribal',
      'plane',
      'scheme',
      'phenomenon',
      'vanguard',
      'conspiracy',
    ],
  },
  {
    title: 'Guilds of Ravnica',
    prefix: 'guild-',
    entries: ['azorius', 'boros', 'dimir', 'golgari', 'gruul', 'izzet', 'orzhov', 'rakdos', 'selesnya', 'simic'],
  },
  {
    title: 'Clans of Tarkir',
    prefix: 'clan-',
    entries: ['abzan', 'jeskai', 'mardu', 'sultai', 'temur', 'atarka', 'dromoka', 'kolaghan', 'ojutai', 'silumgar'],
  },
  {
    title: 'Colleges of Strixhaven',
    prefix: 'school-',
    entries: ['lorehold', 'prismari', 'quandrix', 'silverquill', 'witherbloom'],
  },
  {
    title: 'Poleis of Theros',
    prefix: 'polis-',
    entries: ['akros', 'meletis', 'setessa'],
  },
  {
    title: 'Party',
    prefix: 'party-',
    entries: ['cleric', 'rogue', 'warrior', 'wizard'],
  },
  {
    title: 'Counters',
    prefix: 'counter-',
    suffix: ' counter',
    entries: [
      'plus',
      'minus',
      'charge',
      'loyalty',
      'lore',
      'verse',
      'ki',
      'time',
      'shield',
      'stun',
      'skull',
      'gold',
      'flame',
      'flood',
      'slime',
      'rad',
      'paw',
      'mining',
      'deathtouch',
      'brick',
      'arrow',
      'doom',
      'echo',
      'fungus',
      'muster',
      'scream',
      'void',
      'vortex',
      'damage',
      'devotion',
      'finality',
      'goad',
      'pin',
      'skeleton',
    ],
  },
  {
    title: 'Keywords',
    prefix: 'ability-',
    entries: [
      'flying',
      'first-strike',
      'double-strike',
      'deathtouch',
      'trample',
      'lifelink',
      'haste',
      'vigilance',
      'reach',
      'menace',
      'hexproof',
      'indestructible',
      'ward',
      'defender',
      'flash',
      'prowess',
      'infect',
      'toxic',
      'changeling',
      'protection',
      'shroud',
      'annihilator',
      'landfall',
      'morph',
      'disguise',
      'mutate',
      'crew',
      'saddle',
      'kicker',
      'cycling',
      'convoke',
      'delve',
      'embalm',
      'escape',
      'exalted',
      'evolve',
      'undying',
      'unearth',
      'ninjutsu',
      'monstrous',
      'foretell',
      'adventure',
      'plot',
      'discover',
      'craft',
      'casualty',
      'blitz',
      'prototype',
      'incubate',
      'forage',
      'offspring',
      'gift',
      'surveil',
      'investigate',
      'proliferate',
      'explore',
      'adapt',
      'amass',
      'learn',
      'magecraft',
      'coven',
      'training',
      'backup',
      'bargain',
      'spree',
      'valiant',
      'eerie',
      'survival',
      'impending',
      'party',
      'meld',
      'transform',
      'phyrexian',
      'daybound-nightbound',
      ['day-night', 'Day and night'],
      ['the-ring-tempts-you', 'The Ring tempts you'],
      ['ring-bearer', 'Ring-bearer'],
      ['d20', 'D20'],
      ['dfc', 'Double-faced'],
    ],
  },
  {
    title: 'Watermarks',
    prefix: 'watermark-',
    entries: [
      ['mirran', 'Mirran'],
      ['phyrexian', 'Phyrexian'],
      ['planeswalker', 'Planeswalker'],
      ['colorpie', 'Color pie'],
      ['brokers', 'Brokers'],
      ['cabaretti', 'Cabaretti'],
      ['maestros', 'Maestros'],
      ['obscura', 'Obscura'],
      ['riveteers', 'Riveteers'],
      ['agentsofsneak', 'Agents of S.N.E.A.K.'],
      ['crossbreedlabs', 'Crossbreed Labs'],
      ['goblinexplosioneers', 'Goblin Explosioneers'],
      ['leagueofdastardlydoom', 'League of Dastardly Doom'],
      ['orderofthewidget', 'Order of the Widget'],
      ['conspiracy', 'Conspiracy'],
      ['foretell', 'Foretell'],
      ['desparked', 'Desparked'],
      ['scholarship', 'Scholarship'],
      ['dci', 'DCI'],
      ['arena', 'Arena'],
      ['wotc', 'Wizards of the Coast'],
      ['wpn', 'Wizards Play Network'],
      ['fnm', 'Friday Night Magic'],
      ['protour', 'Pro Tour'],
      ['grandprix', 'Grand Prix'],
      ['judgeacademy', 'Judge Academy'],
      ['dnd', 'Dungeons & Dragons'],
      ['transformers', 'Transformers'],
      ['mtg', 'Magic: The Gathering'],
      ['mtg10', 'Magic 10th anniversary'],
      ['mtg15', 'Magic 15th anniversary'],
      ['mps', 'Masterpiece'],
      ['corocoro', 'CoroCoro'],
      ['nerf', 'Nerf'],
    ],
  },
];

export interface EmblemSymbol {
  /** Mana font class suffix: the emblem renders as `ms ms-${sym}`. */
  sym: string;
  label: string;
}

export interface EmblemSymbolGroup {
  title: string;
  symbols: EmblemSymbol[];
}

/** "first-strike" → "First strike". */
function derivedLabel(name: string): string {
  const words = name.replace(/-/g, ' ');
  return words.slice(0, 1).toUpperCase() + words.slice(1);
}

export const EMBLEM_SYMBOL_GROUPS: EmblemSymbolGroup[] = GROUPS.map((g) => ({
  title: g.title,
  symbols: g.entries.map((e) => {
    const [name, label] = typeof e === 'string' ? [e, derivedLabel(e)] : e;
    return { sym: `${g.prefix ?? ''}${name}`, label: `${label}${g.suffix ?? ''}` };
  }),
}));

/**
 * Every offered symbol, by class suffix. Doubles as the whitelist: a stored
 * emblem naming a symbol that isn't here (an older build's catalog, a hand-
 * edited transfer file) falls back to the container's kind icon rather than
 * rendering a blank box.
 */
export const EMBLEM_SYMBOL_LABELS: Map<string, string> = new Map(
  EMBLEM_SYMBOL_GROUPS.flatMap((g) => g.symbols.map((s) => [s.sym, s.label] as const)),
);

/**
 * The mana symbols, which want the font's `ms-cost` treatment: a round pip in
 * the colour of the mana rather than a bare glyph in the text colour. Every
 * other group renders as a plain glyph.
 */
export const EMBLEM_MANA_PIPS: Set<string> = new Set(
  (EMBLEM_SYMBOL_GROUPS.find((g) => g.title === 'Mana')?.symbols ?? []).map((s) => s.sym),
);
