import type { Color, DeckFormat, Finish, Format, OracleCard, Priced, PrintingVariant, Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { withPrices } from './prices.js';
import {
  matchesQuery,
  normalize,
  parseSearchQuery,
  toSearchableEntry,
  type PrintingSummary,
  type SearchableEntry,
} from './querySyntax.js';

// Card search (beta plan §2, §6). The oracle set (~37k) is small enough to hold
// in memory, which gives fast substring matching (a name-prefix index alone
// would miss "bolt" → "Lightning Bolt") and cheap in-memory filtering. If this
// ever gets slow, the plan's escape hatch is MiniSearch — not needed at 37k.
//
// Queries support Scryfall-style syntax (o:/t:/c:/id:/r:/mv:/f:/mana:/set:/is:,
// negation with `-`, `or` and parentheses) — see querySyntax.ts. Bare words
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

/** Drop the cache after a card-DB re-import so search reflects new data. */
export function invalidateSearchIndex(): void {
  cache = null;
  nameLookup = null;
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
  }
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
    const n = normalize(c.name);
    fullNameKeys.add(n);
    add(n, c);
  }
  // Pass 2: DFC/split front faces only for names not claimed by a full card.
  for (const c of cards) {
    const slash = c.name.indexOf(' // ');
    if (slash !== -1) {
      const front = normalize(c.name.slice(0, slash));
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
    const hit = nameLookup.get(normalize(candidate));
    if (hit) return hit;
  }
  return undefined;
}

export interface SearchResult {
  cards: Priced<OracleCard>[];
  total: number;
}

export async function searchCards(
  query: string,
  filters: SearchFilters = {},
  limit = 60,
): Promise<SearchResult> {
  const index = await getIndex();
  const parsed = parseSearchQuery(query.trim());
  const legalIn = filters.legalIn && filters.legalIn !== 'casual' ? (filters.legalIn as Format) : undefined;

  const matches: Array<{ card: OracleCard; score: number }> = [];
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
    matches.push({ card: entry.card, score });
  }

  matches.sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name));

  // Prices are joined only for the returned page, not the whole match set.
  return {
    cards: await withPrices(matches.slice(0, limit).map((m) => m.card), (c) => c.defaultScryfallId),
    total: matches.length,
  };
}
