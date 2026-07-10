import type { PriceMap, PriceShard, Priced } from '@mtg/shared';
import { db } from '../db/schema.js';

// Price lookup layer. Prices are stored as 16 shard blobs (by first hex char
// of scryfallId) rather than on the card rows, so the daily price refresh
// writes 16 rows instead of rewriting the whole card DB. Reads go through an
// in-memory shard cache; card rows are enriched to Priced<T> at query time.

const shardCache = new Map<string, PriceMap>();

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

async function getShard(key: string): Promise<PriceMap> {
  const cached = shardCache.get(key);
  if (cached) return cached;
  const row = await db.priceShards.get(key);
  const map = row?.prices ?? {};
  shardCache.set(key, map);
  return map;
}

export interface CardPrice {
  eur: number | null;
  usd: number | null;
}

export async function getPricesByIds(ids: Iterable<string>): Promise<Map<string, CardPrice>> {
  const unique = [...new Set(ids)];
  const keys = [...new Set(unique.map(priceShardKey))];
  const shards = new Map(keys.map((k, i) => [k, i]));
  const loaded = await Promise.all(keys.map(getShard));
  const out = new Map<string, CardPrice>();
  for (const id of unique) {
    const tuple = loaded[shards.get(priceShardKey(id))!]?.[id];
    if (tuple) out.set(id, { eur: tuple[0], usd: tuple[1] });
  }
  return out;
}

/** Enrich rows with prices looked up by `idOf` (defaultScryfallId for oracle cards, scryfallId for printings). */
export async function withPrices<T>(rows: T[], idOf: (row: T) => string): Promise<Priced<T>[]> {
  const prices = await getPricesByIds(rows.map(idOf));
  return rows.map((row) => {
    const p = prices.get(idOf(row));
    return { ...row, priceEur: p?.eur ?? null, priceUsd: p?.usd ?? null };
  });
}
