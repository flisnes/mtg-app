import type { Color, DeckFormat, Format, OracleCard, Priced, Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { withPrices } from './prices.js';
import { matchesQuery, normalize, parseSearchQuery, type SearchableEntry } from './querySyntax.js';

// Card search (beta plan §2, §6). The oracle set (~37k) is small enough to hold
// in memory, which gives fast substring matching (a name-prefix index alone
// would miss "bolt" → "Lightning Bolt") and cheap in-memory filtering. If this
// ever gets slow, the plan's escape hatch is MiniSearch — not needed at 37k.
//
// Queries support Scryfall-style syntax (o:/t:/c:/id:/r:/mv:/f:, negation with
// `-`) — see querySyntax.ts. Bare words still match names, so plain queries
// from the import and trade pickers behave as before.

export interface SearchFilters {
  color?: Color | '';
  type?: string;
  rarity?: Rarity | '';
  /** Only cards legal (or restricted) in this format; 'casual' is a no-op. */
  legalIn?: DeckFormat;
  /** Only cards whose color identity fits within this set (Commander). */
  identity?: readonly Color[];
}

type Indexed = SearchableEntry;

let cache: Indexed[] | null = null;
let nameLookup: Map<string, OracleCard> | null = null;

/** Drop the cache after a card-DB re-import so search reflects new data. */
export function invalidateSearchIndex(): void {
  cache = null;
  nameLookup = null;
}

/** Load (and cache) the oracle set for in-memory search, with match fields pre-normalised. */
async function getIndex(): Promise<Indexed[]> {
  if (cache) return cache;
  const cards = await db.oracleCards.toArray();
  cache = cards.map((card) => {
    const normOracle = card.oracleText ? normalize(card.oracleText) : '';
    // Self-references in oracle text become ~ so o:"whenever ~ enters" works.
    let normOracleTilde = normOracle;
    if (normOracle) {
      for (const face of card.name.split(' // ')) {
        const normFace = normalize(face);
        if (normFace) normOracleTilde = normOracleTilde.split(normFace).join('~');
      }
    }
    return {
      card,
      normName: normalize(card.name),
      lowerType: card.typeLine.toLowerCase(),
      normOracle,
      normOracleTilde,
    };
  });
  return cache;
}

/** Resolve a card name to its oracle card (exact, diacritic-insensitive; also matches DFC front faces). For deck import. */
export async function resolveOracleByName(name: string): Promise<OracleCard | undefined> {
  if (!nameLookup) {
    const idx = await getIndex();
    nameLookup = new Map();
    // Pass 1: exact full names win.
    for (const e of idx) {
      if (!nameLookup.has(e.normName)) nameLookup.set(e.normName, e.card);
    }
    // Pass 2: DFC/split front faces only as a fallback.
    for (const e of idx) {
      const slash = e.card.name.indexOf(' // ');
      if (slash !== -1) {
        const front = normalize(e.card.name.slice(0, slash));
        if (!nameLookup.has(front)) nameLookup.set(front, e.card);
      }
    }
  }
  return nameLookup.get(normalize(name));
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
    if (filters.identity && !entry.card.colorIdentity.every((c) => filters.identity!.includes(c))) continue;
    if (!matchesQuery(entry, parsed)) continue;

    // Rank: exact > prefix > word-start > substring > scattered words. Terms
    // other than name text don't affect ranking, only membership.
    let score = 0;
    if (parsed.hasNameTerms) {
      const name = entry.normName;
      const idx = name.indexOf(parsed.namePhrase);
      if (idx === -1) score = 1;
      else if (name === parsed.namePhrase) score = 5;
      else if (idx === 0) score = 4;
      else if (name[idx - 1] === ' ') score = 3;
      else score = 2;
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
