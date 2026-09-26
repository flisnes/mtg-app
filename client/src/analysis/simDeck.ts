import {
  BASIC_BY_COLOR,
  BASIC_LAND_TYPES,
  cleanKeywords,
  collectBehaviorQueries,
  collectBehaviorTokens,
  compileBehavior,
  decodeEffectProfile,
  decodeFetchProfile,
  decodeManaProfile,
  manaStepColors,
  normalizeCost,
  queryHasX,
  sourceColors,
  substituteQueryX,
  BEHAVIOR_TOKENS,
  TOKEN_ABILITIES,
  X_VARIANTS,
  MAX_DREDGE,
  type BehaviorAmount,
  type BehaviorCondition,
  type CardBehavior,
  type CompiledBehavior,
  type DeckBoard,
  type EffectProfile,
  type OracleCard,
  type TokenOption,
} from '@mtg/shared';
import { parseManaCost, type ParsedCost, type PipColor } from './manaCost.js';
import type { ManaUnit } from './canPay.js';
import { compileCardQuery, toSearchableEntry } from '../cardDb/querySyntax.js';

// The deck, flattened into the shape the simulator wants: one entry per
// distinct card, a library that is one number per copy, and every fact the turn
// sequencer needs precomputed so the inner loop does no parsing.
//
// Built on the main thread and posted to the worker, so everything here has to
// survive structured clone: plain objects and typed arrays, no classes and no
// functions.
//
// Colors live as a WUBRGC bitmask rather than an array, because the sequencer
// asks "does this land widen my coverage" once per candidate per turn per game,
// and an OR beats a set union a few million times over.

export const MASK_BITS = 'WUBRGC';

export function colorMask(colors: string | undefined): number {
  let mask = 0;
  if (!colors) return 0;
  for (const c of colors) {
    const i = MASK_BITS.indexOf(c);
    if (i >= 0) mask |= 1 << i;
  }
  return mask;
}

/** One shared ManaUnit per color mask, so building a turn's pool allocates nothing. */
export const UNIT_BY_MASK: readonly ManaUnit[] = Array.from({ length: 1 << MASK_BITS.length }, (_, mask) => ({
  colors: ([...MASK_BITS] as PipColor[]).filter((_c, i) => mask & (1 << i)),
}));

export function popcount(mask: number): number {
  let n = 0;
  for (let m = mask; m; m &= m - 1) n++;
  return n;
}

/**
 * What a card does in a game of Magic, as far as the mana model can see.
 *
 *   land       a land you put down for your land drop
 *   fetch      a land that trades itself for another land out of the library
 *   rock       an artifact that taps for mana
 *   dork       a creature that taps for mana, and is summoning sick
 *   landramp   a spell that puts a land onto the battlefield
 *   extraland  a permanent that lets you play more than one land a turn
 *   ritual     a spell that puts mana straight into your mana pool
 *   spell      everything else, which is to say the cards you are trying to cast
 *
 * A ritual used to be a plain spell, on the grounds that the sequencer had
 * nothing to spend the burst on. It does now: the pool is mana this turn, the
 * spend loop reads it, and a ritual is only cast when something in hand is
 * waiting on exactly the mana it makes. What still separates it from a Treasure
 * is that it does not keep, which is why the two are different things here and
 * not one with a flag.
 */
export type SimRole = 'land' | 'fetch' | 'rock' | 'dork' | 'landramp' | 'extraland' | 'ritual' | 'spell';

/**
 * Card types as bits, the permanent layer's vocabulary (rebuild plan F2). What
 * a card is printed as lives on SimCard.types; what a permanent is *now*, after
 * an Ashaya has made it a land too, lives on the battlefield.
 */
export const T_CREATURE = 1;
export const T_LAND = 2;
export const T_ARTIFACT = 4;
export const T_ENCHANTMENT = 8;
export const T_TOKEN = 16;
/** Type letters (BehaviorStep.ty) to bits. */
export const TYPE_BIT: Readonly<Record<string, number>> = { C: T_CREATURE, L: T_LAND, A: T_ARTIFACT, E: T_ENCHANTMENT };

/**
 * Keywords as bits, the three this model can act on (BEHAVIOR_KEYWORDS). Haste
 * lets a creature attack and tap for mana the turn it arrives. Vigilance lets
 * one that tapped for mana attack anyway: there is no main phase after combat,
 * so the mana it made is read as spent there. Double strike counts its power
 * twice.
 */
export const KW_HASTE = 1;
export const KW_VIGILANCE = 2;
export const KW_DOUBLE = 4;
const KW_BY_LETTER: Readonly<Record<string, number>> = { H: KW_HASTE, V: KW_VIGILANCE, D: KW_DOUBLE };

/** A step's keyword letters as KW_ bits. */
export function keywordBits(kw: string | undefined): number {
  let bits = 0;
  for (const c of cleanKeywords(kw)) bits |= KW_BY_LETTER[c] ?? 0;
  return bits;
}

/** A cast option, parsed once so the spend loop never meets a string. */
export interface SimKicker {
  cost: ParsedCost;
  /** Multikicker: paid as many times as the mana allows. */
  multi: boolean;
}

export interface SimGraveyardCast {
  /** `cast` is a plain cast for its mana cost, which only a grant hands out (Muldrotha). */
  kind: 'flashback' | 'retrace' | 'escape' | 'mayhem' | 'cast';
  cost: ParsedCost;
  /** Escape: other cards exiled from the graveyard. */
  n: number;
}

export interface SimSuspend {
  cost: ParsedCost;
  /** Time counters. */
  n: number;
}

export interface SimCard {
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  role: SimRole;
  /** Playable for your land drop. A modal card with a land on the back is both. */
  land: boolean;
  /** Has a printed cost worth asking "could I cast this on turn N" about. */
  spell: boolean;
  /** Parsed once here so the inner loop never meets a regex. */
  cost: ParsedCost | null;
  /** Mana it makes, as a WUBRGC bitmask. Zero for a fetch, which makes none itself. */
  mask: number;
  /** How much mana it makes once online, or how many lands a land-ramp spell fetches. */
  adds: number;
  /** Whether it, or the land it finds, arrives tapped. */
  tapped: 'never' | 'always' | 'maybe';
  /** A fetch: which cards in this deck it could go and get, as indices into `cards`. */
  fetchTargets: number[];
  /** A land on the back face, so it is a land drop of last resort. */
  modal: boolean;
  /** All of `adds` is one color, chosen once. Lotus Field, Gilded Lotus. */
  oneColor: boolean;
  /** Mana with no nameable color: it pays generic and no pip. Exotic Orchard. */
  generic: boolean;
  /** Turns it stays online once it arrives, or 0 for forever. */
  life: number;
  /** Lands it costs you as it enters. */
  entry: number;
  /** Those lands go back to hand instead of the graveyard, so they can be replayed. */
  bounce: boolean;
  /** Colors this card gives every land you control while it is out. */
  grantMask: number;
  /** Copies in the library. Zero for a card that only sits in the command zone. */
  copies: number;
  /** In the command zone: always available, never drawn. */
  commander: boolean;
  /**
   * Stays on the battlefield once it resolves, so casting it does not put it in
   * the graveyard. Read off the type line and nothing else — the sequencer does
   * not track non-mana permanents, it only needs to know they are not in the
   * yard, because a behavior can go looking there.
   */
  permanent: boolean;
  /**
   * It is a creature on the front face, so it can attack and a rule can go
   * looking for it. Read off the type line for the same reason `permanent` is:
   * nothing here animates a Dryad Arbor or turns a Gideon sideways.
   */
  creature: boolean;
  /**
   * Printed power, or zero. `*` and `X` read as zero rather than as a guess,
   * which is the omission §11.4 asks for: "the greatest power among creatures
   * you control" comes out low on a deck full of them, never high.
   */
  power: number;
  /**
   * An instant on the front face, so the interaction policy can hold it up.
   * Off the type line like `permanent` and `creature`: nothing here knows what
   * a card is *for*, only when you are allowed to cast it.
   */
  instant: boolean;
  /**
   * Counted by the keep rule: the opener keeps a seven holding `keepMin` to
   * `keepMax` of these. Lands unless the Opening hand panel says otherwise,
   * because that panel's rule is the one the user set and the simulator
   * mulliganing on a different one made the two quietly disagree.
   */
  keeps: boolean;
  /**
   * The card's face, for the goldfish trace's battlefield. Small rather than
   * normal: a board row is a dozen tiles a hundred pixels wide, and the normal
   * scan is six times the bytes for pixels nobody sees.
   */
  image: string | null;
  /**
   * What it does to your hand, library and graveyard on resolution, or null for
   * the great majority of cards that do none of it unconditionally. Decoded
   * here so the inner loop never touches a tuple. See EffectProfile.
   */
  effect: EffectProfile | null;
  /**
   * What the *user* says it does, which replaces `effect` rather than adding to
   * it. Null for every card nobody has authored, which is nearly all of them.
   *
   * Replace and not merge, because the editor opens on `effect` rendered in the
   * same grammar: editing what we read and writing your own are one gesture, so
   * a saved behavior already contains whatever of the derived reading the user
   * wanted to keep. Merging would double every step they left alone.
   */
  behavior: CompiledBehavior | null;
  /** Front-face card types as T_ bits, plus T_TOKEN on a token. */
  types: number;
  /** Printed keywords as KW_ bits. */
  keywords: number;
  /** Printed toughness, or zero, read the way `power` is. */
  toughness: number;
  /**
   * A token, appended after the deck's own cards (rebuild plan F3). It has no
   * copies and no library slot; it exists only on the battlefield and ceases to
   * exist the moment it leaves.
   */
  token: boolean;
  /**
   * An authored mana ability whose amount reads the game (charge counters, your
   * creatures). Read every time the pool is built; null for the fixed `adds`.
   */
  manaAmount: BehaviorAmount | null;
  /**
   * Mana this card makes may only be spent on spells matching this query
   * ("t:instant or t:sorcery"), or null for mana that pays for anything.
   * Resolved through SimDeck.filters like every other criteria. An authored
   * mana ability sets it from its `q`; otherwise a database reading flagged
   * restricted sets it from the card's "spend this mana only" text
   * (`restrictionQuery`). A query with no filter behind it (SPEND_NOTHING)
   * pays for no spell at all.
   */
  spendQ: string | null;
  /** An authored mana ability that taps only while this holds (Mox Opal), or null. */
  manaCond: BehaviorCondition | null;
  kicker: SimKicker | null;
  gyCast: SimGraveyardCast | null;
  suspend: SimSuspend | null;
  /**
   * Dredge N of its own: printed, or from a "While it is in your graveyard"
   * rule, which replaces the printed number. 0 for none. A grant from another
   * card (The Necrobloom) is read off the battlefield instead.
   */
  dredge: number;
}

/**
 * How much of the deck the simulator actually plays out, in copies.
 *
 * §11.4's point: every unmodelled card is an effect we fail to *apply*, never
 * one we invent, so the trajectory curves come out systematically pessimistic
 * and the bias is largest for the decks doing the most interesting things. The
 * fix is not to model more cards, it is to say how many we modelled — which
 * makes the pessimism visible instead of load-bearing, and doubles as this
 * feature's own progress metric.
 *
 * "Blank" is not an accusation. A Lightning Bolt resolving as a blank is the
 * model being right: it does nothing to your hand, your library or your mana.
 * The number that matters is on top of this one and needs the oracle tags —
 * see missedDrawCopies().
 */
export interface SimCoverage {
  /** Copies in the library, the denominator everything else is out of. */
  library: number;
  /** Lands, which resolve by being put onto the battlefield and nothing else. */
  lands: number;
  /** Ramp: rocks, dorks, land ramp, fetches, extra land drops. */
  mana: number;
  /** Non-land cards carrying an effect profile the sequencer resolves. */
  effects: number;
  /** Of those, ones where at least one amount is a floor we could not read exactly. */
  floored: number;
  /** Everything else: cast, pays its cost, leaves your hand, does nothing. */
  blanks: number;
  /**
   * Copies playing out the way the user said rather than the way the card
   * database read them. Counted apart from the buckets above, like `floored`,
   * because an authored card is still a land or a spell.
   *
   * This is the one number on the report that points the other way. Everything
   * else here exists because §11.4's unmodelled cards bias the curves *down*,
   * so the panel can call them a floor. An authored behavior can bias them up,
   * and a reader who cannot see how much of the deck is authored cannot price
   * that in.
   */
  authored: number;
  /**
   * Copies playing a default behavior that ships with the app (the reviewed
   * EDH staples, `defaultBehaviors.ts`). Apart from `authored` because nobody
   * in this deck chose them; they are written to err low, but they are still a
   * reading above the database's, and the coverage line says how many.
   */
  defaults: number;
}

/**
 * One move step's criteria, resolved against this deck.
 *
 * The Scryfall parser runs here, once per distinct criteria string per deck
 * build, and what reaches the worker is a byte per card. That is the only
 * arrangement that makes a query affordable: the alternative is parsing and
 * matching inside a loop that runs twenty thousand games deep.
 */
export interface SimFilter {
  q: string;
  /**
   * 1 where `cards[i]` matches. One row of `cards.length` normally; when
   * `varies`, `X_VARIANTS` rows stacked, so the value of `[X]` indexes a row
   * and the lookup is still a single byte.
   *
   * Each of those is itself `SimDeck.variants` rows, one per combination of
   * the types a static rule can add (rebuild plan F6): with an Ashaya out a
   * creature is a Forest land, and `t:land` has to find it. The row for a card
   * is `(x * variants + v) * cards.length`, with `v` the permanent's added-type
   * bits, and zero everywhere off the battlefield.
   */
  match: Uint8Array;
  /** The query holds an `[X]`, so `match` is a stack rather than a row. */
  varies: boolean;
}

export interface SimDeck {
  cards: SimCard[];
  /** One entry per copy in the library: an index into `cards`. */
  library: Int32Array;
  /** Cards in the command zone, which you have every game and never draw. */
  commanders: number[];
  /** False when the card DB predates the mana profile, which reads identically to "no mana". */
  hasManaData: boolean;
  /** How much of the library the sequencer resolves rather than blanks. */
  coverage: SimCoverage;
  /** Every criteria string the deck's behaviors use, precompiled. Usually empty. */
  filters: SimFilter[];
  /** Token kinds, by `tokenKey`, to their index in `cards`. */
  tokens: Record<string, number>;
  /**
   * The distinct types static rules add, as `ty` plus `sub` ("LG" is a Forest
   * land). Bit g of a permanent's added-type set is `typeGrants[g]`.
   */
  typeGrants: string[];
  /** `2 ** typeGrants.length`: the filter rows per `[X]` value. */
  variants: number;
}

/** More added types than this and the grants past it are dropped: the filter stack doubles with each. */
export const MAX_TYPE_GRANTS = 3;

export interface DeckRow {
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
}

const faces = (typeLine: string) => typeLine.split('//').map((f) => f.trim());
const isLandFace = (face: string) => /\bLand\b/.test(face);
/** The front face decides where a cast card ends up: on the battlefield, or in the yard. */
const isPermanentFace = (face: string) => /\b(Creature|Artifact|Enchantment|Planeswalker|Battle|Land)\b/i.test(face);
const isCreatureFace = (face: string) => /\bCreature\b/i.test(face);
/** An instant, which is the one card type you are allowed to hold up. */
const isInstantFace = (face: string) => /\bInstant\b/i.test(face);
/** Printed power as a number. A `*` or an `X` is worth nothing rather than a guess. */
const powerOf = (raw: string | null | undefined): number => {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const isNotACard = (o: OracleCard) => {
  const t = o.typeLine.toLowerCase();
  return t.startsWith('token') || t.includes('emblem') || t === 'card';
};

function roleOf(oracle: OracleCard, landFront: boolean, landAnywhere: boolean): SimRole {
  // Krosan Verge and the Landscape cycle both tap for {C} and search. They are
  // filed as the colorless land they are and the search half is dropped,
  // because it costs {2} and a turn. Same call phase 3 made, same reason.
  if (oracle.fetch && !oracle.produces) return 'fetch';
  if (landAnywhere) return 'land';
  const kind = decodeManaProfile(oracle.mana)?.kind;
  if (kind === 'rock' || kind === 'dork' || kind === 'landramp') return kind;
  // Burst mana. A plain spell until the sequencer had a mana pool to put it in;
  // see SimRole. The colors and the amount are already on the mana profile, so
  // nothing here reads text.
  if (kind === 'ritual') return 'ritual';
  // An Exploration is not a source and never was, which is why it sat in
  // 'spell' until phase 9. What it is, is a second land drop every turn, and
  // the sequencer has had a land-drop loop to hang that on since this phase.
  if (kind === 'extraland') return 'extraland';
  return landFront ? 'land' : 'spell';
}

/** A land the simulator can put onto the battlefield, and what it is worth there. */
interface LandInfo {
  index: number;
  typeLine: string;
  basic: boolean;
}

/**
 * @param behaviors Authored behavior for this deck, by oracleId. Omitted by
 * every caller that only wants the card database's reading — the goldfish trace
 * and the stats sheet both pass one, the acceptance rig does not.
 */
export function buildSimDeck(
  rows: readonly DeckRow[],
  behaviors?: ReadonlyMap<string, CardBehavior>,
  /** The Opening hand panel's keep query. Blank or absent keeps on lands. */
  keepQuery?: string,
  /** Which of `behaviors` are shipped defaults rather than the user's, by oracleId. */
  defaulted?: ReadonlySet<string>,
  /**
   * The token cards a rule names out of the card database (`tk: 'card'`), by
   * oracle id. A rule whose token is missing here makes nothing, which is the
   * floor side: the caller loads them and the deck is rebuilt when they land.
   */
  tokenOracles?: ReadonlyMap<string, OracleCard>,
): SimDeck {
  const cards: SimCard[] = [];
  /** The card behind each entry of `cards`, kept only long enough to run the filters. */
  const oracles: OracleCard[] = [];
  const byOracle = new Map<string, number>();
  const commanders: number[] = [];
  const landInfo: LandInfo[] = [];
  const fetchInfo: { index: number; types: string; basicOnly: boolean }[] = [];
  let libraryCopies = 0;
  let profiled = 0;

  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0) continue;
    if (r.board !== 'main' && r.board !== 'commander') continue;
    if (isNotACard(o)) continue;

    const existing = byOracle.get(o.oracleId);
    if (existing !== undefined) {
      if (r.board === 'main') {
        const card = cards[existing]!;
        card.copies += r.quantity;
        card.commander = false;
        libraryCopies += r.quantity;
      }
      continue;
    }

    const parts = faces(o.typeLine);
    const landFront = isLandFace(parts[0] ?? '');
    const landAnywhere = parts.some(isLandFace);
    const role = roleOf(o, landFront, landAnywhere);
    const profile = decodeManaProfile(o.mana);
    const fetch = role === 'fetch' ? decodeFetchProfile(o.fetch) : null;
    if (profile || fetch) profiled++;

    const index = cards.length;
    byOracle.set(o.oracleId, index);
    const behavior = compileBehavior(behaviors?.get(o.oracleId));
    const card = simCardOf(o, behavior, r.board === 'main' ? r.quantity : 0, r.board === 'commander');
    if (behavior) applyAuthoredObject(card, behavior);
    cards.push(card);
    oracles.push(o);

    if (r.board === 'main') {
      libraryCopies += r.quantity;
      // Only the library can answer a search, and only a land that makes mana
      // is worth finding: a Bojuka Bog is findable and pays for nothing.
      if (role === 'land' && colorMask(o.produces) !== 0) {
        landInfo.push({ index, typeLine: o.typeLine, basic: /^Basic\b/i.test(o.typeLine) });
      }
    } else {
      commanders.push(index);
    }
    if (fetch) fetchInfo.push({ index, types: fetch.types, basicOnly: fetch.basicOnly });
  }

  for (const f of fetchInfo) {
    const wanted = [...f.types].map((letter) => BASIC_LAND_TYPES[letter]).filter((t): t is string => !!t);
    const targets: number[] = [];
    for (const land of landInfo) {
      if (f.basicOnly && !land.basic) continue;
      if (!wanted.some((type) => new RegExp(`\\b${type}\\b`).test(land.typeLine))) continue;
      targets.push(land.index);
    }
    const card = cards[f.index]!;
    card.fetchTargets = targets;
    // A fetch makes no mana of its own, so its mask is what it could go and
    // get. The sequencer needs that to decide which land drop widens its colors
    // without rescanning the library once per candidate per turn; what it
    // actually finds is resolved against the library at the time.
    card.mask = targets.reduce((mask, i) => mask | cards[i]!.mask, 0);
  }

  // Tokens, after every real card, so no library slot and no fetch target ever
  // points at one. What makes them cards at all is that everything reading a
  // permanent — filters, entry watchers, the creature count, combat — then
  // works on a Beast token without knowing it is one.
  const tokenSpecs = new Map<string, TokenOption>();
  for (const card of cards) collectBehaviorTokens(card.behavior, tokenSpecs);
  // A Treasure is a source, not a card, everywhere but one: a rule watching
  // for sacrifices (rebuild plan E3) has to be able to ask whether the thing
  // sacrificed was an artifact. So it gets a card, only in a deck that asks.
  if (cards.some((c) => (c.behavior?.sacrifice.length ?? 0) > 0)) tokenSpecs.set('treasure', BEHAVIOR_TOKENS[0]!);
  const tokens: Record<string, number> = {};
  for (const [key, spec] of tokenSpecs) {
    const made = spec.oracleId ? tokenFromCard(spec.oracleId, tokenOracles, behaviors) : tokenCard(key, spec);
    if (!made) continue;
    tokens[key] = cards.length;
    cards.push(made.card);
    oracles.push(made.oracle);
  }

  const library = new Int32Array(libraryCopies);
  let at = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let c = 0; c < cards[i]!.copies; c++) library[at++] = i;
  }

  const coverage: SimCoverage = { library: libraryCopies, lands: 0, mana: 0, effects: 0, floored: 0, blanks: 0, authored: 0, defaults: 0 };
  for (const card of cards) {
    if (card.copies <= 0) continue;
    if (card.role === 'land' || card.role === 'fetch') coverage.lands += card.copies;
    else if (card.role !== 'spell') coverage.mana += card.copies;
    else if (card.effect || card.behavior) coverage.effects += card.copies;
    else coverage.blanks += card.copies;
    if (card.behavior && defaulted?.has(card.oracleId)) coverage.defaults += card.copies;
    else if (card.behavior) coverage.authored += card.copies;
    // Counted apart from the buckets above, not instead of them: a Read the
    // Bones is modelled *and* flagged, and both facts belong on the line.
    if (card.effect?.unknown && !card.behavior) coverage.floored += card.copies;
  }

  applyKeepQuery(cards, oracles, keepQuery);

  const typeGrants = collectTypeGrants(cards);
  const variants = 1 << typeGrants.length;
  return {
    cards,
    library,
    commanders,
    hasManaData: profiled > 0,
    coverage,
    filters: buildFilters(cards, oracles, typeGrants),
    tokens,
    typeGrants,
    variants,
  };
}

/** A card of the deck as the sequencer sees it, before any authored rule changes what it is. */
function simCardOf(o: OracleCard, behavior: CompiledBehavior | null, copies: number, commander: boolean): SimCard {
  const parts = faces(o.typeLine);
  const landFront = isLandFace(parts[0] ?? '');
  const landAnywhere = parts.some(isLandFace);
  const role = roleOf(o, landFront, landAnywhere);
  const profile = decodeManaProfile(o.mana);
  const fetch = role === 'fetch' ? decodeFetchProfile(o.fetch) : null;
  const card: SimCard = {
    oracleId: o.oracleId,
    name: o.name,
    manaCost: o.manaCost ?? '',
    cmc: o.cmc,
    role,
    land: landAnywhere || role === 'fetch',
    // A land has nothing to pay, so it has nothing to check.
    spell: !landFront && !!o.manaCost,
    cost: landFront ? null : parseManaCost(o.manaCost),
    // The profile's colors, not `produces` — see sourceColors(). A card whose
    // mana has no nameable color keeps an empty mask and pays generic only.
    mask: colorMask(profile ? sourceColors(profile, o.produces) : o.produces),
    // A utility land that taps for nothing still costs you your land drop and
    // adds no mana, which is exactly what a zero says.
    adds: profile?.adds ?? (role === 'land' && !o.produces ? 0 : 1),
    tapped: fetch?.tapped ?? profile?.tapped ?? 'never',
    fetchTargets: [],
    modal: landAnywhere && !landFront,
    oneColor: !!profile?.oneColor && (profile?.adds ?? 0) > 1,
    generic: !!profile?.opponent,
    life: profile?.life ?? 0,
    entry: profile?.entry ?? 0,
    bounce: !!profile?.bounce,
    grantMask: colorMask(o.grants),
    copies,
    commander,
    permanent: isPermanentFace(parts[0] ?? ''),
    creature: isCreatureFace(parts[0] ?? ''),
    power: powerOf(o.power),
    instant: isInstantFace(parts[0] ?? ''),
    keeps: landAnywhere || role === 'fetch',
    image: o.imageSmall ?? o.imageNormal ?? null,
    effect: decodeEffectProfile(o.effect),
    behavior,
    types: typeBits(parts[0] ?? ''),
    keywords: printedKeywords(o.oracleText),
    toughness: powerOf(o.toughness),
    token: false,
    manaAmount: null,
    spendQ: profile?.restricted ? restrictionQuery(o.oracleText) : null,
    manaCond: null,
    kicker: null,
    gyCast: null,
    suspend: null,
    dredge: printedDredge(o.oracleText),
  };
  return card;
}

/**
 * Spend-only criteria that match no spell: abilities-only mana (Pit Automaton),
 * or a restriction this reader cannot say (spells from your graveyard, the
 * chosen type). Never compiled into a filter, and a spendQ with no filter
 * pays for nothing, which is the floor side of §11.4.
 */
export const SPEND_NOTHING = 'spend:nothing';
/** "Spend this mana only to cast your commander" (Jeweled Lotus). Filled by buildFilters. */
export const SPEND_COMMANDER = 'spend:commander';

/** Words before "spell" that name a card type, a supertype or a color; anything else single is a subtype. */
const SPEND_WORDS: Readonly<Record<string, string>> = {
  instant: 't:instant',
  sorcery: 't:sorcery',
  creature: 't:creature',
  artifact: 't:artifact',
  enchantment: 't:enchantment',
  planeswalker: 't:planeswalker',
  battle: 't:battle',
  legendary: 't:legendary',
  noncreature: '-t:creature',
  nonartifact: '-t:artifact',
  colorless: 'c:c',
  multicolored: 'c:m',
};
/** Words that make a restriction something this reader cannot say. */
const SPEND_UNKNOWN = /\b(chosen|kicked|monocolored|face-down|foretell|flashback|commander|graveyard|exile|own|watermark|colors?|that|with|without|from|of)\b|\{/;

/**
 * A database mana reading flagged restricted, as the spells it may pay for.
 * The DB keeps only the flag, so this reads the card's own words: "Spend this
 * mana only to cast instant or sorcery spells" is `(t:instant or t:sorcery)`,
 * "... Dragon spells" is `(t:dragon)`, "... creature spells with mana value 4
 * or greater" adds `mv>=4`. Ability clauses ("or activate abilities of
 * artifacts") are dropped, since restricted mana never pays for abilities
 * here, and an alternative it cannot read is dropped with them: each one
 * dropped is spells the mana would pay for and does not, never the reverse.
 * Several "spend only" clauses on one card are joined with `or`.
 */
export function restrictionQuery(text: string | null | undefined): string {
  const parts: string[] = [];
  for (const m of (text ?? '').matchAll(/spend this mana only ([^.]*)/gi)) {
    const q = spendClause(m[1]!.toLowerCase());
    if (q === SPEND_COMMANDER) return SPEND_COMMANDER;
    if (q && !parts.includes(q)) parts.push(q);
  }
  if (parts.length === 0) return SPEND_NOTHING;
  return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(' or ');
}

function spendClause(clause: string): string | null {
  if (/\bcast your commander\b/.test(clause)) return SPEND_COMMANDER;
  const m = /\bcast (?:an? )?(.*?)\bspells?\b(.*)$/.exec(clause);
  if (!m) return null;
  const list = m[1]!.trim();
  const rest = m[2]!.trim();
  // What follows the first "spell": nothing, another alternative (dropped), or
  // a mana value floor. Anything else qualifies the spell in a way that is
  // not a search term ("from your graveyard", "of the chosen type").
  let mv = '';
  const mvm = /^with mana value (\d+) or greater\b/.exec(rest);
  if (mvm) mv = `mv>=${mvm[1]}`;
  else if (rest && !/^(or|and|and\/or)\b/.test(rest)) return null;
  const items = list ? list.split(/\s*,\s*(?:and\/or |and |or )?|\s+(?:and\/or|or|and)\s+/).filter(Boolean) : [];
  const terms: string[] = [];
  for (const item of items) {
    if (SPEND_UNKNOWN.test(item)) continue;
    const words = item.replace(/^(an?|the) /, '').split(/\s+/);
    if (!words.every((w) => /^[a-z]+$/.test(w))) continue;
    terms.push(words.map((w) => SPEND_WORDS[w] ?? `t:${w}`).join(' '));
  }
  if (items.length > 0 && terms.length === 0) return null;
  const any = terms.length === 0 ? '' : terms.length === 1 ? terms[0]! : `(${terms.join(' or ')})`;
  const q = [any, mv].filter(Boolean).join(' ');
  return q || null;
}

/** The front face's card types, as T_ bits. */
function typeBits(face: string): number {
  let bits = 0;
  if (/\bCreature\b/i.test(face)) bits |= T_CREATURE;
  if (/\bLand\b/i.test(face)) bits |= T_LAND;
  if (/\bArtifact\b/i.test(face)) bits |= T_ARTIFACT;
  if (/\bEnchantment\b/i.test(face)) bits |= T_ENCHANTMENT;
  return bits;
}

/**
 * Keywords printed on the card as keywords, not ones it hands out. A keyword
 * line is a comma list of short words ("Flying, haste"); "creatures you control
 * gain haste" is a sentence and does not count.
 */
export function printedKeywords(text: string | null | undefined): number {
  if (!text) return 0;
  let bits = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\([^)]*\)/g, '').trim().toLowerCase();
    if (!line) continue;
    const parts = line.split(/,\s*/);
    if (!parts.every((p) => p.split(/\s+/).length <= 3)) continue;
    if (parts.includes('haste')) bits |= KW_HASTE;
    if (parts.includes('vigilance')) bits |= KW_VIGILANCE;
    if (parts.includes('double strike')) bits |= KW_DOUBLE;
  }
  return bits;
}

/**
 * A printed "Dredge N" keyword line, or 0. Read like the keywords above: the
 * card database has no field for it, and it is a keyword, not a reading.
 */
export function printedDredge(text: string | null | undefined): number {
  if (!text) return 0;
  const m = /^dredge (\d+)\b/im.exec(text.replace(/\([^)]*\)/g, ''));
  return m ? Math.min(MAX_DREDGE, Number(m[1])) : 0;
}

/**
 * The parts of an authored behavior that change what the card *is* rather than
 * what it does (rebuild plan F4, F5): a mana ability written by hand, and the
 * other ways it can be cast. Read once here so the sequencer only meets fields.
 */
function applyAuthoredObject(card: SimCard, b: CompiledBehavior): void {
  // "This card has haste" is what the card is, the same as a printed keyword,
  // so summoning sickness reads it on arrival like one.
  for (const rule of b.statics) for (const step of rule.steps) if (step.op === 'keyword' && step.own) card.keywords |= keywordBits(step.kw);
  const tap = b.tap;
  if (tap && card.permanent) {
    // An authored mana ability replaces the one the database read, the same
    // way every other rule replaces its reading. A land stays a land drop.
    card.role = card.land ? 'land' : card.creature ? 'dork' : 'rock';
    card.mask = colorMask(manaStepColors(tap));
    card.generic = false;
    card.life = 0;
    card.entry = 0;
    card.bounce = false;
    // A condition makes even a fixed amount one that is read every turn.
    const fixed = tap.x.kind === 'fixed' && !tap.x.op && !b.tapCond;
    card.adds = fixed ? (tap.x.n ?? 0) : 0;
    card.manaAmount = fixed ? null : tap.x;
    card.manaCond = b.tapCond;
    card.oneColor = !!tap.oneColor;
    card.spendQ = tap.q || null;
    if (card.role !== 'land') card.tapped = 'never';
  }
  if (b.dredge > 0) card.dredge = b.dredge;
  for (const o of b.options) {
    const cost = o.cost ? parseManaCost(normalizeCost(o.cost)) : null;
    switch (o.kind) {
      case 'kicker':
      case 'multikicker':
        if (cost) card.kicker = { cost, multi: o.kind === 'multikicker' };
        break;
      case 'retrace':
        if (card.cost) card.gyCast = { kind: 'retrace', cost: card.cost, n: 0 };
        break;
      case 'flashback':
      case 'escape':
      case 'mayhem':
        if (cost) card.gyCast = { kind: o.kind, cost, n: o.n ?? 0 };
        break;
      case 'suspend':
        if (cost) card.suspend = { cost, n: Math.max(1, o.n ?? 1) };
        break;
    }
  }
}

/**
 * A token straight out of the card database: an Everywhere is a land that taps
 * for every color, a Moloid a 1/1 Minion, read the way a real card is. Its own
 * rules, if anyone wrote some, come along like any card's.
 */
function tokenFromCard(
  oracleId: string,
  tokenOracles: ReadonlyMap<string, OracleCard> | undefined,
  behaviors: ReadonlyMap<string, CardBehavior> | undefined,
): { card: SimCard; oracle: OracleCard } | null {
  const oracle = tokenOracles?.get(oracleId);
  if (!oracle) return null;
  const behavior = compileBehavior(behaviors?.get(oracleId));
  const card = simCardOf(oracle, behavior, 0, false);
  if (behavior) applyAuthoredObject(card, behavior);
  // Never cast and never in a hand: a token only exists on the battlefield.
  card.spell = false;
  card.cost = null;
  card.permanent = true;
  card.keeps = false;
  card.token = true;
  card.types |= T_TOKEN;
  return { card, oracle };
}

/** A token kind as a card, and the oracle row its filters are matched against. */
function tokenCard(key: string, spec: TokenOption): { card: SimCard; oracle: OracleCard } {
  const words = [...spec.types].map((t) => ({ C: 'Creature', A: 'Artifact', E: 'Enchantment', L: 'Land' })[t] ?? '');
  const typeLine = `Token ${words.filter(Boolean).join(' ')}${spec.sub ? ` — ${spec.sub}` : ''}`;
  let types = T_TOKEN;
  for (const t of spec.types) types |= TYPE_BIT[t] ?? 0;
  const creature = (types & T_CREATURE) !== 0;
  const oracle = {
    oracleId: `token:${key}`,
    name: spec.name,
    manaCost: null,
    cmc: 0,
    typeLine,
    oracleText: null,
    colors: [...(spec.colors ?? '')],
    colorIdentity: [...(spec.colors ?? '')],
    rarity: 'common',
    imageSmall: null,
    imageNormal: null,
    defaultScryfallId: '',
    power: creature ? String(spec.power ?? 0) : null,
    toughness: creature ? String(spec.toughness ?? 0) : null,
  } as unknown as OracleCard;
  const card: SimCard = {
    oracleId: oracle.oracleId,
    name: spec.name,
    manaCost: '',
    cmc: 0,
    role: 'spell',
    land: false,
    spell: false,
    cost: null,
    mask: 0,
    adds: 0,
    tapped: 'never',
    fetchTargets: [],
    modal: false,
    oneColor: false,
    generic: false,
    life: 0,
    entry: 0,
    bounce: false,
    grantMask: 0,
    copies: 0,
    commander: false,
    permanent: true,
    creature,
    power: creature ? (spec.power ?? 0) : 0,
    instant: false,
    keeps: false,
    image: null,
    effect: null,
    // A Clue cracks for a card and a Food is eaten (rebuild plan E3).
    behavior: compileBehavior(TOKEN_ABILITIES[key]),
    types,
    // Only a custom token carries keywords, as the key's last field.
    keywords: key.startsWith('custom:') ? keywordBits(key.slice(key.lastIndexOf(':') + 1)) : 0,
    toughness: creature ? (spec.toughness ?? 0) : 0,
    token: true,
    manaAmount: null,
    spendQ: null,
    manaCond: null,
    kicker: null,
    gyCast: null,
    suspend: null,
    dredge: 0,
  };
  return { card, oracle };
}

/** Every distinct type a static `addtype` step grants, capped at MAX_TYPE_GRANTS. */
function collectTypeGrants(cards: readonly SimCard[]): string[] {
  const out: string[] = [];
  for (const card of cards) {
    for (const rule of card.behavior?.statics ?? []) {
      for (const step of rule.steps) {
        if (step.op !== 'addtype' || !step.ty) continue;
        const g = `${step.ty}${step.sub ?? ''}`;
        if (!out.includes(g) && out.length < MAX_TYPE_GRANTS) out.push(g);
      }
    }
  }
  return out;
}

/** The type line a grant adds: "Land Forest". */
export function grantTypeWords(grant: string): string {
  const word = ({ C: 'Creature', A: 'Artifact', E: 'Enchantment', L: 'Land' } as Record<string, string>)[grant[0] ?? ''] ?? '';
  const sub = grant[1] ? (BASIC_BY_COLOR[grant[1]] ?? '') : '';
  return `${word}${sub ? ` ${sub}` : ''}`;
}

/** Re-point `keeps` at the user's keep query, when there is one that parses to something. */
function applyKeepQuery(cards: SimCard[], oracles: readonly OracleCard[], q: string | undefined): void {
  if (!q?.trim()) return;
  const compiled = compileCardQuery(q);
  if (compiled.isEmpty) return;
  for (let i = 0; i < cards.length; i++) cards[i]!.keeps = compiled.matches(toSearchableEntry(oracles[i]!));
}

/**
 * Turn every criteria string the deck's behaviors mention into a per-card
 * bitmask, using the same query engine as the search bar. `t:basic` means in
 * here exactly what it means up there, which is the only reason offering a
 * query string at all is reasonable rather than cruel.
 *
 * Two terms cannot match and the editor says so: `set:` and `is:foil` are about
 * a printing, and a simulated deck is a list of cards rather than a list of
 * copies. A card that matches nothing is not an error — it is a deck where that
 * step finds nothing, which is what the trace will show.
 */
function buildFilters(cards: readonly SimCard[], oracles: readonly OracleCard[], typeGrants: readonly string[]): SimFilter[] {
  const queries = new Set<string>();
  for (const card of cards) collectBehaviorQueries(card.behavior, queries);
  let commanderOnly = false;
  for (const card of cards) {
    if (card.spendQ === SPEND_COMMANDER) commanderOnly = true;
    else if (card.spendQ && card.spendQ !== SPEND_NOTHING) queries.add(card.spendQ);
  }
  const n = cards.length;
  const variants = 1 << typeGrants.length;
  const filters: SimFilter[] = [];
  // Not a search term: "your commander" is a fact about this deck, not a card.
  if (commanderOnly) {
    const match = new Uint8Array(variants * n);
    for (let v = 0; v < variants; v++) for (let i = 0; i < n; i++) if (cards[i]!.commander) match[v * n + i] = 1;
    filters.push({ q: SPEND_COMMANDER, match, varies: false });
  }
  if (queries.size === 0) return filters;
  // One searchable entry per card per combination of added types. Variant 0
  // is the card as printed, which is every card off the battlefield and every
  // card in a deck with no `addtype` rule, so that deck pays for one row.
  const entries = Array.from({ length: variants }, (_v, v) =>
    oracles.map((o) => {
      if (v === 0) return toSearchableEntry(o);
      const added = typeGrants.filter((_g, g) => v & (1 << g)).map(grantTypeWords);
      return toSearchableEntry({ ...o, typeLine: `${o.typeLine} ${added.join(' ')}` });
    }),
  );

  /** One row of the bitmask per variant, for one fully-resolved query string. */
  const fill = (match: Uint8Array, x: number, resolved: string) => {
    const compiled = compileCardQuery(resolved);
    for (let v = 0; v < variants; v++) {
      const base = (x * variants + v) * n;
      const rows = entries[v]!;
      // An empty query is every card, which is also what an absent one means, so
      // the two agree rather than one of them quietly matching nothing.
      for (let i = 0; i < rows.length; i++) {
        if (compiled.isEmpty || compiled.matches(rows[i]!)) match[base + i] = 1;
      }
    }
  };

  for (const q of queries) {
    if (!queryHasX(q)) {
      const match = new Uint8Array(variants * n);
      fill(match, 0, q);
      filters.push({ q, match, varies: false });
      continue;
    }
    // `mv<=[X]` has no single answer, so it gets twenty-one of them. The
    // placeholder is filled by an amount and amounts are clamped to
    // MAX_BEHAVIOR_AMOUNT, so the range is closed and small enough to just
    // enumerate — which is what keeps the parser out of the game loop.
    const match = new Uint8Array(X_VARIANTS * variants * n);
    for (let x = 0; x < X_VARIANTS; x++) fill(match, x, substituteQueryX(q, x));
    filters.push({ q, match, varies: true });
  }
  return filters;
}
