import { BASIC_LAND_TYPES, decodeFetchProfile, decodeManaProfile, type DeckBoard, type OracleCard } from '@mtg/shared';
import { parseManaCost, type ParsedCost, type PipColor } from './manaCost.js';
import type { ManaUnit } from './canPay.js';

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
 *   land      a land you put down for your land drop
 *   fetch     a land that trades itself for another land out of the library
 *   rock      an artifact that taps for mana
 *   dork      a creature that taps for mana, and is summoning sick
 *   landramp  a spell that puts a land onto the battlefield
 *   spell     everything else, which is to say the cards you are trying to cast
 *
 * Rituals and extra-land effects are deliberately plain spells. A Dark Ritual
 * is not a source and an Exploration only matters if you are flooded; both are
 * still cards you draw and try to cast, they just do not feed the mana model.
 */
export type SimRole = 'land' | 'fetch' | 'rock' | 'dork' | 'landramp' | 'spell';

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
  /** Copies in the library. Zero for a card that only sits in the command zone. */
  copies: number;
  /** In the command zone: always available, never drawn. */
  commander: boolean;
}

export interface SimDeck {
  cards: SimCard[];
  /** One entry per copy in the library: an index into `cards`. */
  library: Int32Array;
  /** Cards in the command zone, which you have every game and never draw. */
  commanders: number[];
  /** False when the card DB predates the mana profile, which reads identically to "no mana". */
  hasManaData: boolean;
}

export interface DeckRow {
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
}

const faces = (typeLine: string) => typeLine.split('//').map((f) => f.trim());
const isLandFace = (face: string) => /\bLand\b/.test(face);
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
  return landFront ? 'land' : 'spell';
}

/** A land the simulator can put onto the battlefield, and what it is worth there. */
interface LandInfo {
  index: number;
  typeLine: string;
  basic: boolean;
}

export function buildSimDeck(rows: readonly DeckRow[]): SimDeck {
  const cards: SimCard[] = [];
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
      mask: colorMask(o.produces),
      // A utility land that taps for nothing still costs you your land drop and
      // adds no mana, which is exactly what a zero says.
      adds: profile?.adds ?? (role === 'land' && !o.produces ? 0 : 1),
      tapped: fetch?.tapped ?? profile?.tapped ?? 'never',
      fetchTargets: [],
      modal: landAnywhere && !landFront,
      copies: r.board === 'main' ? r.quantity : 0,
      commander: r.board === 'commander',
    });

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

  return { cards, library, commanders, hasManaData: profiled > 0 };
}
