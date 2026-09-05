import type { Finish, PriceMap, PriceShard, Priced } from '@mtg/shared';
import { db } from '../db/schema.js';

// Price lookup layer. Prices are stored as 16 shard blobs (by first hex char
// of scryfallId) rather than on the card rows, so the daily price refresh
// writes 16 rows instead of rewriting the whole card DB. Reads go through an
// in-memory shard cache; card rows are enriched to Priced<T> at query time.

// Keyed by shard, holding the *promise* rather than the map: a single screen
// asks for oracle prices and printing prices at the same moment, and caching
// only the settled value let both misses run the same IndexedDB read twice.
const shardCache = new Map<string, Promise<PriceMap>>();

export const PRICE_SHARD_KEYS = [...'0123456789abcdef'];

export function priceShardKey(scryfallId: string): string {
  const k = scryfallId[0] ?? '0';
  return PRICE_SHARD_KEYS.includes(k) ? k : '0';
}

/** Group a full price map into the 16 shard rows (all 16, so stale shards get overwritten). */
export function buildPriceShards(prices: PriceMap): PriceShard[] {
  const shards = new Map<string, PriceMap>(PRICE_SHARD_KEYS.map((k) => [k, {}]));
  for (const [id, tuple] of Object.entries(prices)) {
    shards.get(priceShardKey(id))![id] = tuple;
  }
  return [...shards.entries()].map(([key, map]) => ({ key, prices: map }));
}

/** Drop the cache after a price import so lookups see the new data. */
export function invalidatePriceCache(): void {
  shardCache.clear();
}

function getShard(key: string): Promise<PriceMap> {
  const cached = shardCache.get(key);
  if (cached) return cached;
  const pending = db.priceShards
    .get(key)
    .then((row) => row?.prices ?? {})
    .catch((err) => {
      shardCache.delete(key); // a failed read must not stick as an empty shard
      throw err;
    });
  shardCache.set(key, pending);
  return pending;
}

export interface CardPrice {
  eur: number | null;
  usd: number | null;
  eurFoil: number | null;
  usdFoil: number | null;
  usdEtched: number | null;
  /** The price tuple carried foil slots (length > 2). When false, foil/etched
   * lookups fall back to nonfoil so a pre-foil price artifact still shows a price. */
  hasFoil: boolean;
}

/**
 * Pick the eur/usd prices for a card's finish. Foil and etched read their own
 * slots; etched EUR reuses the foil EUR (Scryfall has no eur_etched) and etched
 * USD falls back to the foil USD. If the artifact predates foil pricing
 * (`hasFoil` false), every finish resolves to nonfoil so nothing shows blank
 * during the window before the nightly price rebuild ships foil data.
 */
export function priceForFinish(p: CardPrice | undefined, finish: Finish): { eur: number | null; usd: number | null } {
  if (!p) return { eur: null, usd: null };
  if (finish === 'nonfoil' || !p.hasFoil) return { eur: p.eur, usd: p.usd };
  if (finish === 'etched') return { eur: p.eurFoil, usd: p.usdEtched ?? p.usdFoil };
  return { eur: p.eurFoil, usd: p.usdFoil };
}

export async function getPricesByIds(ids: Iterable<string>): Promise<Map<string, CardPrice>> {
  const unique = [...new Set(ids)];
  const keys = [...new Set(unique.map(priceShardKey))];
  const shards = new Map(keys.map((k, i) => [k, i]));
  const loaded = await Promise.all(keys.map(getShard));
  const out = new Map<string, CardPrice>();
  for (const id of unique) {
    const tuple = loaded[shards.get(priceShardKey(id))!]?.[id];
    if (tuple) {
      out.set(id, {
        eur: tuple[0],
        usd: tuple[1],
        eurFoil: tuple[2] ?? null,
        usdFoil: tuple[3] ?? null,
        usdEtched: tuple[4] ?? null,
        hasFoil: tuple.length > 2,
      });
    }
  }
  return out;
}

/** Enrich rows with prices looked up by `idOf` (defaultScryfallId for oracle cards, scryfallId for printings). */
export async function withPrices<T>(rows: T[], idOf: (row: T) => string): Promise<Priced<T>[]> {
  const prices = await getPricesByIds(rows.map(idOf));
  return rows.map((row) => {
    const p = prices.get(idOf(row));
    return {
      ...row,
      priceEur: p?.eur ?? null,
      priceUsd: p?.usd ?? null,
      priceEurFoil: p?.eurFoil ?? null,
      priceUsdFoil: p?.usdFoil ?? null,
      priceUsdEtched: p?.usdEtched ?? null,
      priceHasFoil: p?.hasFoil ?? false,
    };
  });
}
