import type { FetchProfileTuple, ManaProfileTuple, OracleTagDictionary } from '@mtg/shared';
import {
  BASIC_LAND_TYPES,
  FETCH_BASIC_ONLY,
  MANA_KINDS,
  MANA_MAYBE_TAPPED,
  MANA_ONE_SHOT,
  MANA_SICK,
  MANA_TAPPED,
  MANA_UNKNOWN,
} from '@mtg/shared';

// Derives OracleCard.mana: how a card feeds the mana system, so the deck
// analysis can sequence a turn instead of just counting cards. Runs here rather
// than on the client because it wants oracle text, Tagger tags and Scryfall's
// produced_mana in the same place, and the client should not carry a parser.
//
// Two rules hold the whole thing together:
//
//  1. **The tags decide, not the text.** A naive /enters .* tapped/ over the
//     card DB's 1258 lands hits 648 of them — and it is wrong, not merely
//     noisy: Glacial Fortress, Stomping Ground, Steam Vents and Secluded Glen
//     all print "enters tapped" inside a sentence that starts with "unless".
//     Tagger has already split that: `tapland` is the 499 that always do,
//     `conditional-tapland` the 165 that sometimes do. Those two play nothing
//     alike, and no amount of regex gets you the difference without a rules
//     engine.
//
//  2. **Mark what we can't parse; never guess quietly.** Of the ~3,100 cards
//     that come out of here with a profile, ~370 carry MANA_UNKNOWN, and 159 of
//     those are `extraland`, which is unknowable by construction. The rest are
//     the cards whose output depends on the board — Bloom Tender, Charmed
//     Pendant, Astral Cornucopia. They get a floor of 1 and the flag, so a
//     consumer can say "6 cards in this deck produce mana in a way we can't
//     model" instead of quietly reporting a probability with a fudge factor in
//     it.

/** Tag subtrees the derivation keys off, resolved to dictionary indices once. */
export interface ManaTagIndex {
  tapland: ReadonlySet<number>;
  conditionalTapland: ReadonlySet<number>;
  rock: ReadonlySet<number>;
  dork: ReadonlySet<number>;
  landRamp: ReadonlySet<number>;
  multiLandRamp: ReadonlySet<number>;
  ritual: ReadonlySet<number>;
  extraLand: ReadonlySet<number>;
}

/**
 * Every index in a slug's subtree, the root included. Cards are tagged on the
 * leaves (Jungle Hollow carries `cycle-ktk-gainland`, not `tapland`), so
 * membership has to be tested against the closure, exactly as `otag:` does on
 * the client. Iterative and `seen`-guarded: the hierarchy is a DAG.
 */
function subtree(dictionary: OracleTagDictionary, children: Map<number, number[]>, slug: string): Set<number> {
  const root = dictionary.findIndex((e) => e[0] === slug);
  const out = new Set<number>();
  if (root < 0) return out;
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const kid of children.get(id) ?? []) stack.push(kid);
  }
  return out;
}

export function buildManaTagIndex(dictionary: OracleTagDictionary): ManaTagIndex {
  const children = new Map<number, number[]>();
  dictionary.forEach((entry, i) => {
    for (const parent of entry[1] ?? []) {
      const kids = children.get(parent);
      if (kids) kids.push(i);
      else children.set(parent, [i]);
    }
  });
  const of = (slug: string) => subtree(dictionary, children, slug);
  return {
    tapland: of('tapland'),
    conditionalTapland: of('conditional-tapland'),
    rock: of('mana-rock'),
    dork: of('mana-dork'),
    landRamp: of('land-ramp'),
    multiLandRamp: of('multi-land-ramp'),
    ritual: of('ritual'),
    extraLand: of('extra-land'),
  };
}

/** Anything inside `{…}`. */
const SYMBOL = /\{([^}]+)\}/g;

/** What one symbol is worth as mana: `{2}` two, `{G}`/`{W/U}` one, `{T}`/`{E}` nothing. */
function symbolValue(symbol: string): number {
  const generic = Number(symbol);
  if (Number.isFinite(generic)) return generic;
  return /^[WUBRGCS]$/i.test(symbol) || symbol.includes('/') ? 1 : 0;
}

const WRITTEN_NUMBERS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "three mana", "2 mana" — cards that count in words rather than printing symbols. */
const WRITTEN_AMOUNT = new RegExp(`\\b(\\d+|${WRITTEN_NUMBERS.join('|')}) mana\\b`, 'i');

/**
 * A phrase that makes the amount a fact about the board rather than about the
 * card: "X mana", "that much mana", "for each …". Tested against the whole
 * line, not just the part after "add", because Bloom Tender's "For each color
 * among permanents you control, add one mana of that color" puts the caveat in
 * front and the innocent-looking "one mana" behind.
 */
const BOARD_DEPENDENT = /\bx\b|that much|for each|equal to|any number/i;

/**
 * Mana one alternative of an "Add …" clause produces, or null when we shouldn't
 * put a number on it — which is what MANA_UNKNOWN exists for.
 *
 * The written amount wins over the symbols: in "Add three mana of any one
 * color" the words are the amount and the symbols, where there are any, are
 * only naming the palette to choose from.
 */
function amountOf(part: string): number | null {
  if (BOARD_DEPENDENT.test(part)) return null;
  const written = WRITTEN_AMOUNT.exec(part);
  if (written) {
    const word = written[1]!.toLowerCase();
    const n = Number(word);
    return Number.isFinite(n) ? n : WRITTEN_NUMBERS.indexOf(word) + 1;
  }
  let total = 0;
  for (const m of part.matchAll(SYMBOL)) total += symbolValue(m[1]!);
  return total > 0 ? total : null;
}

/**
 * An "Add …" clause is a *choice* between its comma- and "or"-separated
 * alternatives, so a dual land's "Add {W} or {U}" is one mana and not two,
 * while a Signet's "Add {U}{G}" — one alternative, two symbols — really is two.
 * Getting this backwards is how every land in a two-color deck comes out
 * looking like a Sol Ring.
 */
function addsInClause(clause: string): number | null {
  let best: number | null = null;
  for (const part of clause.split(/,| or /i)) {
    const n = amountOf(part);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

/**
 * Every "add …" on the card, with whatever precedes it on the line — which for
 * an activated ability is its cost. Case-insensitive and unanchored because
 * triggered abilities put it mid-sentence ("Whenever this creature attacks, add
 * {R}"), and `\badd ` can't collide with "additional" or "add a counter".
 */
const ADD_CLAUSE = /^(.*?)\badd ([^.\n]*)/gim;

/**
 * Mana the card *nets*, being the best of its abilities. Net, because a Signet
 * reads "{1}, {T}: Add {U}{G}" — it fixes two mana but ramps you one, and a
 * model that credits it with two will happily promise a turn-three six-drop.
 * Best rather than first, because the reminder text on a land prints its mana
 * ability twice and a card with two abilities is worth its better one.
 */
function addsOnCard(oracleText: string | null): number | null {
  let best: number | null = null;
  for (const m of (oracleText ?? '').matchAll(ADD_CLAUSE)) {
    if (BOARD_DEPENDENT.test(m[0])) continue;
    const gross = addsInClause(m[2] ?? '');
    if (gross === null) continue;
    let cost = 0;
    for (const s of (m[1] ?? '').matchAll(SYMBOL)) cost += symbolValue(s[1]!);
    const net = Math.max(0, gross - cost);
    if (best === null || net > best) best = net;
  }
  return best;
}

/**
 * Ramp that actually puts a land into play. The `land-ramp` tag is broader than
 * that — it also carries cards that only fetch to hand, and a scattering that
 * look like mis-tags (Volition Reins) — and this is the sentence the real ones
 * all print.
 */
const PUTS_LAND_IN_PLAY = /onto the battlefield/i;

/** Fetched lands overwhelmingly arrive tapped, and here the text says so plainly. */
const FETCHES_TAPPED = /onto the battlefield tapped/i;

export interface ManaProfileInput {
  typeLine: string;
  oracleText: string | null;
  /** MANA_LETTERS-ordered production string; '' when the card adds no mana. */
  produces: string;
  /** The card's own tag indices (OracleCard.tags), unexpanded. */
  tags: readonly number[] | undefined;
}

/**
 * The card's mana profile, or undefined when it neither produces mana nor ramps.
 *
 * Precedence is deliberate and the order below is the order to read it in: a
 * land that also ramps is a land, a creature that taps for mana is a dork
 * whatever else it does. Only the first match wins, so every card gets exactly
 * one kind and the sequencer never has to reconcile two.
 */
export function manaProfileOf(card: ManaProfileInput, index: ManaTagIndex): ManaProfileTuple | undefined {
  const tags = card.tags ?? [];
  const tagged = (set: ReadonlySet<number>) => tags.some((t) => set.has(t));
  const kindOf = (k: (typeof MANA_KINDS)[number]) => MANA_KINDS.indexOf(k);

  const isLand = /\bLand\b/.test(card.typeLine);
  const isCreature = /\bCreature\b/.test(card.typeLine);
  const parsed = addsOnCard(card.oracleText);

  if (isLand && card.produces) {
    // Lands tap for one unless they say otherwise (Ancient Tomb, Crystal Vein),
    // and unlike a rock a land with no printed mana ability is a basic — whose
    // one mana is a rule, not text. So an unparsed land is 1, not unknown.
    const flags = tagged(index.tapland)
      ? MANA_TAPPED
      : tagged(index.conditionalTapland)
        ? MANA_MAYBE_TAPPED
        : 0;
    return [kindOf('land'), parsed ?? 1, flags];
  }

  // A mana creature's mana arrives a turn late. Checked before `rock` because
  // Tagger tags a few artifact creatures as both.
  if (card.produces && (tagged(index.dork) || (isCreature && parsed !== null))) {
    return [kindOf('dork'), parsed ?? 1, MANA_SICK | (parsed === null ? MANA_UNKNOWN : 0)];
  }
  if (card.produces && tagged(index.rock)) {
    return [kindOf('rock'), parsed ?? 1, parsed === null ? MANA_UNKNOWN : 0];
  }
  if (card.produces && tagged(index.ritual)) {
    return [kindOf('ritual'), parsed ?? 1, MANA_ONE_SHOT | (parsed === null ? MANA_UNKNOWN : 0)];
  }

  // Exploration, Azusa: worth a land drop only while you have spare lands in
  // hand, which is a property of the game state and not of the card. Recorded
  // so the UI can list it, flagged so nobody sums it. Checked before landramp
  // because Tagger files these under both.
  if (tagged(index.extraLand)) {
    return [kindOf('extraland'), 1, MANA_UNKNOWN];
  }
  // Ramp that fetches cardboard rather than tapping for mana, so it has no
  // `produces` of its own: what it makes is whatever land it finds.
  if (tagged(index.landRamp) && PUTS_LAND_IN_PLAY.test(card.oracleText ?? '')) {
    const flags = FETCHES_TAPPED.test(card.oracleText ?? '') ? MANA_TAPPED : 0;
    return [kindOf('landramp'), tagged(index.multiLandRamp) ? 2 : 1, flags];
  }

  // Produces mana but fits no family Tagger names — an Ornithopter of Paradise
  // nobody has tagged yet, a one-off enchantment. Still a source; call it a
  // rock, which is the kind with no timing quirks.
  if (card.produces) return [kindOf('rock'), parsed ?? 1, parsed === null ? MANA_UNKNOWN : 0];

  return undefined;
}

// ---------------------------------------------------------------------------
// Fetchlands
//
// Scryfall gives a fetchland no `produced_mana`, and it is right not to: a
// Scalding Tarn adds no mana, it trades itself for a card. So the profile above
// skips it entirely, and until this existed a fetch was invisible to every
// colored-source count in the app — which on an eight-fetch manabase is not a
// rounding error. A UR deck's turn-two Counterspell read 29% when the honest
// figure was 69%.
//
// What a fetch is worth is a fact about the deck, not the card: it makes every
// color of every land it could find *in that decklist*. So all that is derived
// here is the search terms, and the resolving happens on the client, where a
// decklist is in scope.
//
// This is text parsing, which rule 1 above says to distrust — but there is no
// tag for "and it finds an Island or a Mountain", and the sentence these cards
// print is one sentence with no "unless" in it. The parse is anchored on
// "Search your library for … onto the battlefield" and only ever emits the five
// basic land types, so a card that searches for something we don't model (a
// Desert, a Sphere) comes out as no fetch at all rather than as a wrong one.

/** "Search your library for <what>, put it/them onto the battlefield". */
const FETCH_SENTENCE = /Search your library for ([^.]*?),? (?:and )?put (?:it|them|that card)[^.]*?onto the battlefield/i;

/** The fetched land arrives tapped, which costs the same turn a tapland does. */
const ARRIVES_TAPPED = /onto the battlefield tapped/i;

/** Fabled Passage: tapped, then untapped once you control four lands. */
const THEN_UNTAPS = /onto the battlefield tapped[^.]*\.[^.]*untap/i;

/**
 * The fetch *itself* enters tapped (Grasslands, Krosan Verge). It costs you the
 * same turn a tapland does even when the land it finds arrives untapped:
 * cracking it needs {T}, and a land that entered tapped has no {T} to give
 * until your next untap step.
 *
 * The self-reference wording only. A shockland's "If you don't, it enters
 * tapped" hangs off an "unless" and means something else entirely, which is the
 * whole reason the profile above leans on tags rather than text.
 */
const SELF_ENTERS_TAPPED = /(?:^|\n)This land enters tapped\./i;

/**
 * What a fetchland searches out, or undefined when the card isn't one.
 *
 * Only lands are considered. Farseek and Cultivate put lands into play too, but
 * they are spells that cost mana on a turn you wanted to spend it, and the
 * profile above already files them as `landramp`.
 */
export function fetchProfileOf(card: ManaProfileInput): FetchProfileTuple | undefined {
  if (!/\bLand\b/.test(card.typeLine)) return undefined;
  const text = card.oracleText ?? '';
  const m = FETCH_SENTENCE.exec(text);
  if (!m) return undefined;
  const phrase = m[1] ?? '';

  // "a basic land card" names no type and means all of them; anything else has
  // to say which, and we only model the five that make colors.
  const named = Object.entries(BASIC_LAND_TYPES).filter(([, type]) => new RegExp(`\\b${type}\\b`, 'i').test(phrase));
  const anyBasic = named.length === 0 && /\bbasic land\b/i.test(phrase);
  const types = anyBasic ? Object.keys(BASIC_LAND_TYPES).join('') : named.map(([letter]) => letter).join('');
  if (!types) return undefined;

  const basicOnly = anyBasic || /\bbasic\b/i.test(phrase);
  let flags = basicOnly ? FETCH_BASIC_ONLY : 0;
  if (SELF_ENTERS_TAPPED.test(text) || ARRIVES_TAPPED.test(text)) {
    flags |= THEN_UNTAPS.test(text) ? MANA_MAYBE_TAPPED : MANA_TAPPED;
  }
  return [types, flags];
}
