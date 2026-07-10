import type { Color, OracleCard, Priced, Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { withPrices } from './prices.js';

// Card search (beta plan §2, §6). The oracle set (~37k) is small enough to hold
// in memory, which gives fast substring matching (a name-prefix index alone
// would miss "bolt" → "Lightning Bolt") and cheap in-memory filtering. If this
// ever gets slow, the plan's escape hatch is MiniSearch — not needed at 37k.

export interface SearchFilters {
  color?: Color | '';
  type?: string;
  rarity?: Rarity | '';
}

interface Indexed {
  card: OracleCard;
  normName: string;
  lowerType: string;
}

let cache: Indexed[] | null = null;
let nameLookup: Map<string, OracleCard> | null = null;

/** Drop the cache after a card-DB re-import so search reflects new data. */
export function invalidateSearchIndex(): void {
  cache = null;
  nameLookup = null;
}

/** Diacritic-insensitive, lowercased (strips combining marks after NFD). */
const COMBINING_MARKS = /\p{M}/gu;
function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/** Load (and cache) the oracle set for in-memory search, with names pre-normalised. */
async function getIndex(): Promise<Indexed[]> {
  if (cache) return cache;
  const cards = await db.oracleCards.toArray();
  cache = cards.map((card) => ({
    card,
    normName: normalize(card.name),
    lowerType: card.typeLine.toLowerCase(),
  }));
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
  const q = normalize(query.trim());

  const matches: Array<{ card: OracleCard; score: number }> = [];
  for (const entry of index) {
    if (filters.color && !entry.card.colors.includes(filters.color)) continue;
    if (filters.rarity && entry.card.rarity !== filters.rarity) continue;
    if (filters.type && !entry.lowerType.includes(filters.type.toLowerCase())) continue;

    let score = 0;
    if (q) {
      const name = entry.normName;
      const idx = name.indexOf(q);
      if (idx === -1) continue;
      // Rank: exact > prefix > word-start > substring.
      if (name === q) score = 4;
      else if (idx === 0) score = 3;
      else if (name[idx - 1] === ' ') score = 2;
      else score = 1;
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
