import type { Color, DeckFormat, Finish, Format, OracleCard, Priced, Printing, PrintingVariant, Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPricesByIds, withPrices } from './prices.js';
import { loadOracleTags } from './oracleTags.js';
import { priceValue, sortCards, type CardSortPrefs } from '../components/cardSort.js';
import {
  matchesQuery,
  normalizeName,
  parseSearchQuery,
  pinnedSets,
  toSearchableEntry,
  type PrintingSummary,
  type SearchableEntry,
} from './querySyntax.js';

// Card search (beta plan §2, §6). The oracle set (~37k) is small enough to hold
// in memory, which gives fast substring matching (a name-prefix index alone
// would miss "bolt" → "Lightning Bolt") and cheap in-memory filtering. If this
// ever gets slow, the plan's escape hatch is MiniSearch — not needed at 37k.
//
// Queries support Scryfall-style syntax (o:/t:/c:/id:/r:/mv:/f:/mana:/set:/is:/
// otag:, negation with `-`, `or` and parentheses) — see querySyntax.ts. Bare words
// still match names, so plain queries from the import and trade pickers behave
// as before.

export interface SearchFilters {
  color?: Color | '';
  type?: string;
  rarity?: Rarity | '';
  /** Only cards legal (or restricted) in this format; 'casual' is a no-op. */
  legalIn?: DeckFormat;
  /** Only cards whose color identity fits within this set (Commander). */
  identity?: readonly Color[];
  /** Let these through the identity filter anyway (a second commander widens it). */
  identityExempt?: (card: OracleCard) => boolean;
}

type Indexed = SearchableEntry;

let cache: Indexed[] | null = null;
let nameLookup: Map<string, OracleCard> | null = null;
let sets: SetInfo[] | null = null;

/** Drop the cache after a card-DB re-import so search reflects new data. */
export function invalidateSearchIndex(): void {
  cache = null;
  nameLookup = null;
  sets = null;
}

/** One set the card DB knows about, for the `set:` completions. */
export interface SetInfo {
  /** Lowercased set code, as `set:` wants it. */
  code: string;
  name: string;
  /** ISO date of the earliest printing we hold from it. */
  releasedAt: string;
  /** How many printings the DB holds from it. */
  count: number;
}

interface PrintingAgg {
  sets: string[];
  finishes: Set<Finish>;
  hasPromo: boolean;
  variants: Set<PrintingVariant>;
  count: number;
}

/** Load (and cache) the oracle set for in-memory search, with match fields pre-normalised. */
async function getIndex(): Promise<Indexed[]> {
  if (cache) return cache;
  const [cards, printings] = await Promise.all([db.oracleCards.toArray(), db.printings.toArray()]);
  const byOracle = new Map<string, PrintingAgg>();
  // The set list falls out of the same pass: the printings table is the only
  // place a set's full name lives, and re-reading 100k rows just to build the
  // `set:` completion list would be absurd when they're already in hand.
  const bySet = new Map<string, SetInfo>();
  for (const p of printings) {
    let agg = byOracle.get(p.oracleId);
    if (!agg) {
      agg = { sets: [], finishes: new Set(), hasPromo: false, variants: new Set(), count: 0 };
      byOracle.set(p.oracleId, agg);
    }
    agg.sets.push(p.set);
    for (const f of p.finishes) agg.finishes.add(f);
    if (p.promo) agg.hasPromo = true;
    for (const v of p.variants ?? []) agg.variants.add(v);
    agg.count++;

    const code = p.set.toLowerCase();
    const known = bySet.get(code);
    if (!known) bySet.set(code, { code, name: p.setName, releasedAt: p.releasedAt, count: 1 });
    else {
      known.count++;
      if (p.releasedAt < known.releasedAt) known.releasedAt = p.releasedAt;
    }
  }
  sets = [...bySet.values()];
  cache = cards.map((c) => {
    const agg = byOracle.get(c.oracleId);
    const summary: PrintingSummary | undefined = agg && {
      sets: agg.sets,
      finishes: agg.finishes,
      hasPromo: agg.hasPromo,
      variants: agg.variants,
      reprint: agg.count > 1,
    };
    return toSearchableEntry(c, summary);
  });
  return cache;
}

/**
 * Every set the card DB holds a printing from, unordered. Costs the one-time
 * index build and nothing after that.
 */
export async function getSetIndex(): Promise<SetInfo[]> {
  await getIndex();
  return sets ?? [];
}

/**
 * Rank for name collisions: real cards (0) beat tokens/emblems/art-series
 * "cards" (1). Many tokens share a name with the real card that makes them
 * (Bloomburrow Offspring, eternalize, etc.), and art-series cards share the
 * card's name too — without a set code to disambiguate, the real card wins.
 */
export function cardPriority(c: OracleCard): number {
  const t = c.typeLine.toLowerCase();
  if (t.startsWith('token') || t.includes('emblem') || t === 'card') return 1;
  return 0;
}

/**
 * Build a normalized-name → all-oracle-cards lookup. Full names come first
 * (ranked so real cards precede tokens/art); DFC/split front faces are appended
 * only for names no full card claimed. The import worker uses the full
 * candidate list to disambiguate by set code.
 */
export function buildNameMultiIndex(cards: OracleCard[]): Map<string, OracleCard[]> {
  const map = new Map<string, OracleCard[]>();
  const add = (key: string, c: OracleCard) => {
    const arr = map.get(key);
    if (arr) arr.push(c);
    else map.set(key, [c]);
  };
  // Pass 1: exact full names.
  const fullNameKeys = new Set<string>();
  for (const c of cards) {
    const n = normalizeName(c.name);
    fullNameKeys.add(n);
    add(n, c);
  }
  // Pass 2: DFC/split front faces only for names not claimed by a full card.
  for (const c of cards) {
    const slash = c.name.indexOf(' // ');
    if (slash !== -1) {
      const front = normalizeName(c.name.slice(0, slash));
      if (!fullNameKeys.has(front)) add(front, c);
    }
  }
  // Real cards ahead of tokens/art so the first candidate is the sensible default.
  for (const arr of map.values()) arr.sort((a, b) => cardPriority(a) - cardPriority(b));
  return map;
}

/**
 * Build a normalized-name → oracle-card lookup (also used by the import
 * worker): exact full names win over DFC/split front faces, and real cards win
 * over tokens/art when a name is shared.
 */
export function buildNameIndex(cards: OracleCard[]): Map<string, OracleCard> {
  const map = new Map<string, OracleCard>();
  for (const [key, arr] of buildNameMultiIndex(cards)) map.set(key, arr[0]!);
  return map;
}

/** Resolve a card name to its oracle card (exact, diacritic-insensitive; also matches DFC front faces and single-slash "Front / Back" spellings). */
export async function resolveOracleByName(name: string): Promise<OracleCard | undefined> {
  if (!nameLookup) nameLookup = buildNameIndex((await getIndex()).map((e) => e.card));
  // Try the full name, then just the front face for "Front / Back" or "Front // Back".
  for (const candidate of [name, name.split(/\s*\/\/?\s*/)[0]!]) {
    const hit = nameLookup.get(normalizeName(candidate));
    if (hit) return hit;
  }
  return undefined;
}

export interface SearchResult {
  cards: Priced<OracleCard>[];
  /**
   * Index-aligned with `cards`: the printing that row stands for. Only present
   * when the query pinned a set (see `expandPrintings`); otherwise the caller's
   * own printing preference decides what each card displays as.
   */
  printings?: (Priced<Printing> | undefined)[];
  total: number;
}

/**
 * Printings of the pinned sets, grouped by oracle card and in collector-number
 * order — so `forest set:blb` lists the set's Forests the way the set numbers
 * them, not the way a UUID sorts.
 */
async function printingsForSets(codes: string[]): Promise<Map<string, Printing[]>> {
  // Codes come out of the parser lowercased; the table stores Scryfall's own
  // casing, which is lowercase today but isn't ours to promise.
  const rows = await db.printings.where('set').anyOfIgnoreCase(codes).toArray();
  const out = new Map<string, Printing[]>();
  for (const p of rows) {
    // A printing with no art is a row the user can't tell from any other.
    if (!p.imageSmall && !p.imageNormal) continue;
    const list = out.get(p.oracleId);
    if (list) list.push(p);
    else out.set(p.oracleId, [p]);
  }
  for (const list of out.values()) list.sort(byCollectorNumber);
  return out;
}

/** Collector numbers are strings but read as numbers: 2 before 10, ★ after 100. */
function byCollectorNumber(a: Printing, b: Printing): number {
  const na = parseInt(a.collectorNumber, 10);
  const nb = parseInt(b.collectorNumber, 10);
  if (Number.isNaN(na) !== Number.isNaN(nb)) return Number.isNaN(na) ? 1 : -1;
  if (!Number.isNaN(na) && na !== nb) return na - nb;
  return a.collectorNumber.localeCompare(b.collectorNumber) || (a.scryfallId < b.scryfallId ? -1 : 1);
}

/**
 * How the results are ordered. 'relevance' is the default and the only key the
 * card database can rank by on its own; the rest are the ordinary card sorts.
 * The sort runs over the whole match set before the page is sliced off, so
 * "cheapest first" means cheapest of everything that matched, not of page one.
 */
export type SearchSort = Pick<CardSortPrefs, 'key' | 'dir'>;

const DEFAULT_SORT: SearchSort = { key: 'relevance', dir: 'desc' };

export async function searchCards(
  query: string,
  filters: SearchFilters = {},
  limit = 60,
  sort: SearchSort = DEFAULT_SORT,
  /**
   * Let a `set:` term take over the result rows: one row per printing in that
   * set instead of one per card, showing the set's own printing rather than the
   * user's preferred one. Opt-in, because a picker that keys its rows by oracle
   * card can't hold two rows for the same card.
   */
  expandPrintings = false,
): Promise<SearchResult> {
  // Before parsing, not after: `otag:` resolves its slug at parse time, and an
  // unresolved one degrades to a name search. Settles instantly once loaded.
  const [index] = await Promise.all([getIndex(), loadOracleTags()]);
  const parsed = parseSearchQuery(query.trim());
  const pins = expandPrintings ? pinnedSets(parsed) : null;
  const pinned = pins ? await printingsForSets(pins) : null;
  const legalIn = filters.legalIn && filters.legalIn !== 'casual' ? (filters.legalIn as Format) : undefined;

  const matches: Array<{ card: OracleCard; score: number; printing?: Printing }> = [];
  for (const entry of index) {
    if (filters.color && !entry.card.colors.includes(filters.color)) continue;
    if (filters.rarity && entry.card.rarity !== filters.rarity) continue;
    if (filters.type && !entry.lowerType.includes(filters.type.toLowerCase())) continue;
    if (legalIn && entry.card.legalities) {
      // Cards imported before legality data existed pass (no data ≠ illegal).
      const status = entry.card.legalities[legalIn];
      if (status !== 'legal' && status !== 'restricted') continue;
    }
    if (
      filters.identity &&
      !entry.card.colorIdentity.every((c) => filters.identity!.includes(c)) &&
      !filters.identityExempt?.(entry.card)
    )
      continue;
    if (!matchesQuery(entry, parsed)) continue;

    // Rank: exact > prefix > word-start > substring > scattered words. Terms
    // other than name text don't affect ranking, only membership; an OR query
    // ranks by its best-matching branch.
    let score = 0;
    for (const phrase of parsed.namePhrases) {
      const name = entry.normName;
      const idx = name.indexOf(phrase);
      let phraseScore = 1;
      if (idx !== -1) {
        if (name === phrase) phraseScore = 5;
        else if (idx === 0) phraseScore = 4;
        else if (name[idx - 1] === ' ') phraseScore = 3;
        else phraseScore = 2;
      }
      score = Math.max(score, phraseScore);
    }
    // Pinned to a set: the card's printings *in that set* are the rows. A card
    // that matched but has nothing showable there still gets its one plain row.
    const prints = pinned?.get(entry.card.oracleId);
    if (prints?.length) for (const printing of prints) matches.push({ card: entry.card, score, printing });
    else matches.push({ card: entry.card, score });
  }

  const ordered = await orderMatches(matches, sort);
  const page = ordered.slice(0, limit);

  // Prices are joined only for the returned page, not the whole match set. A
  // pinned printing carries its own price — a Secret Lair Forest is not a
  // Foundations one.
  let printings: (Priced<Printing> | undefined)[] | undefined;
  if (pinned) {
    const priced = await withPrices(
      page.map((m) => m.printing).filter((p): p is Printing => !!p),
      (p) => p.scryfallId,
    );
    const byId = new Map(priced.map((p) => [p.scryfallId, p]));
    printings = page.map((m) => (m.printing ? byId.get(m.printing.scryfallId) : undefined));
  }

  return {
    cards: await withPrices(page.map((m) => m.card), (c) => c.defaultScryfallId),
    ...(printings ? { printings } : {}),
    total: matches.length,
  };
}

/**
 * Order the whole match set. Best-match is its own comparator (relevance isn't
 * a field on a card), everything else goes through the shared card sort so
 * search orders results exactly the way the collection orders entries.
 *
 * Sorting by price needs a price for every match, not just the page — but
 * prices live in 16 already-cached shard blobs, so that's a map lookup per
 * card rather than a second trip to IndexedDB.
 */
async function orderMatches<T extends { card: OracleCard; score: number; printing?: Printing }>(
  matches: T[],
  sort: SearchSort,
): Promise<T[]> {
  // A card that expanded into several printings keeps them together and in
  // collector order, whatever the outer sort is.
  const tie = (a: T, b: T) =>
    a.card.name.localeCompare(b.card.name) ||
    (a.printing && b.printing ? byCollectorNumber(a.printing, b.printing) : 0);
  if (sort.key === 'relevance' || sort.key === 'change' || sort.key === 'changePct' || sort.key === 'added' || sort.key === 'updated') {
    // The four owned-list keys have no meaning for a card that isn't yours;
    // a stored preference that leaks in falls back to best-match.
    const mul = sort.key === 'relevance' && sort.dir === 'asc' ? -1 : 1;
    return [...matches].sort((a, b) => (b.score - a.score) * mul || tie(a, b));
  }
  const idOf = (m: T) => m.printing?.scryfallId ?? m.card.defaultScryfallId;
  const prices = sort.key === 'price' ? await getPricesByIds(matches.map(idOf)) : null;
  return sortCards(
    matches,
    (m) => {
      const p = prices?.get(idOf(m));
      return {
        name: m.card.name,
        cmc: m.card.cmc,
        price: p ? priceValue({ priceEur: p.eur, priceUsd: p.usd }) : null,
      };
    },
    sort,
  );
}
