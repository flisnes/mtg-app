import {
  BASIC_LAND_TYPES,
  collectBehaviorQueries,
  compileBehavior,
  decodeEffectProfile,
  decodeFetchProfile,
  decodeManaProfile,
  sourceColors,
  type CardBehavior,
  type CompiledBehavior,
  type DeckBoard,
  type EffectProfile,
  type OracleCard,
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
 *   spell      everything else, which is to say the cards you are trying to cast
 *
 * A ritual is deliberately a plain spell. A Dark Ritual is not a source, it is
 * a card you spend to cast a bigger card, and the sequencer has nothing to
 * spend the burst on: phase 9 gave Treasure a home because a Treasure keeps,
 * and a ritual does not.
 */
export type SimRole = 'land' | 'fetch' | 'rock' | 'dork' | 'landramp' | 'extraland' | 'spell';

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
  /** 1 where `cards[i]` matches. */
  match: Uint8Array;
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
}

export interface DeckRow {
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
}

const faces = (typeLine: string) => typeLine.split('//').map((f) => f.trim());
const isLandFace = (face: string) => /\bLand\b/.test(face);
/** The front face decides where a cast card ends up: on the battlefield, or in the yard. */
const isPermanentFace = (face: string) => /\b(Creature|Artifact|Enchantment|Planeswalker|Battle|Land)\b/i.test(face);
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
export function buildSimDeck(rows: readonly DeckRow[], behaviors?: ReadonlyMap<string, CardBehavior>): SimDeck {
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
    cards.push({
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
      copies: r.board === 'main' ? r.quantity : 0,
      commander: r.board === 'commander',
      permanent: isPermanentFace(parts[0] ?? ''),
      effect: decodeEffectProfile(o.effect),
      behavior: compileBehavior(behaviors?.get(o.oracleId)),
    });
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

  const library = new Int32Array(libraryCopies);
  let at = 0;
  for (let i = 0; i < cards.length; i++) {
    for (let c = 0; c < cards[i]!.copies; c++) library[at++] = i;
  }

  const coverage: SimCoverage = { library: libraryCopies, lands: 0, mana: 0, effects: 0, floored: 0, blanks: 0, authored: 0 };
  for (const card of cards) {
    if (card.copies <= 0) continue;
    if (card.role === 'land' || card.role === 'fetch') coverage.lands += card.copies;
    else if (card.role !== 'spell') coverage.mana += card.copies;
    else if (card.effect || card.behavior) coverage.effects += card.copies;
    else coverage.blanks += card.copies;
    if (card.behavior) coverage.authored += card.copies;
    // Counted apart from the buckets above, not instead of them: a Read the
    // Bones is modelled *and* flagged, and both facts belong on the line.
    if (card.effect?.unknown && !card.behavior) coverage.floored += card.copies;
  }

  return { cards, library, commanders, hasManaData: profiled > 0, coverage, filters: buildFilters(cards, oracles) };
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
function buildFilters(cards: readonly SimCard[], oracles: readonly OracleCard[]): SimFilter[] {
  const queries = new Set<string>();
  for (const card of cards) collectBehaviorQueries(card.behavior, queries);
  if (queries.size === 0) return [];
  const entries = oracles.map((o) => toSearchableEntry(o));
  const filters: SimFilter[] = [];
  for (const q of queries) {
    const compiled = compileCardQuery(q);
    const match = new Uint8Array(cards.length);
    // An empty query is every card, which is also what an absent one means, so
    // the two agree rather than one of them quietly matching nothing.
    for (let i = 0; i < entries.length; i++) {
      if (compiled.isEmpty || compiled.matches(entries[i]!)) match[i] = 1;
    }
    filters.push({ q, match });
  }
  return filters;
}
