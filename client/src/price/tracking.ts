import type { OracleCard, PriceSnapshot, Printing, WatchedCard } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';

// Price tracking (client-only). Snapshots the current card-DB price of each
// watched printing whenever the app opens, at most once per calendar day. The
// card DB itself refreshes daily (prices ≤24h stale), so this builds a daily
// price history without any per-card API traffic.

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Record today's price for every watched card that doesn't have one yet. Returns how many were added. */
export async function recordPriceSnapshots(): Promise<number> {
  const watched = await db.watchlist.toArray();
  if (!watched.length) return 0;
  const day = today();

  // One query for today's existing snapshots (compound index) + one bulk write,
  // instead of a per-card count in a loop.
  const [printings, existing] = await Promise.all([
    getPrintingsByIds(watched.map((w) => w.scryfallId)),
    db.priceSnapshots.where('[scryfallId+day]').anyOf(watched.map((w) => [w.scryfallId, day])).toArray(),
  ]);
  const have = new Set(existing.map((s) => s.scryfallId));

  const now = Date.now();
  const toAdd: PriceSnapshot[] = [];
  for (const w of watched) {
    if (have.has(w.scryfallId)) continue;
    const p = printings.get(w.scryfallId);
    if (!p) continue;
    toAdd.push({ id: crypto.randomUUID(), scryfallId: w.scryfallId, at: now, day, eur: p.priceEur, usd: p.priceUsd });
  }
  if (toAdd.length) await db.priceSnapshots.bulkAdd(toAdd);
  return toAdd.length;
}

export interface WatchedRow {
  watched: WatchedCard;
  oracle?: OracleCard;
  printing?: Printing;
  snapshots: PriceSnapshot[];
}

/** All watched cards joined with display data + their price history (ascending). */
export async function getWatchedRows(): Promise<WatchedRow[]> {
  const watched = await db.watchlist.toArray();
  if (!watched.length) return [];
  const watchedIds = watched.map((w) => w.scryfallId);
  const [oracleMap, printMap, allSnaps] = await Promise.all([
    getOracleCardsByIds(watched.map((w) => w.oracleId)),
    getPrintingsByIds(watchedIds),
    // Only this watchlist's snapshots (indexed), not the whole table.
    db.priceSnapshots.where('scryfallId').anyOf(watchedIds).toArray(),
  ]);
  const byCard = new Map<string, PriceSnapshot[]>();
  for (const s of allSnaps) {
    const arr = byCard.get(s.scryfallId);
    if (arr) arr.push(s);
    else byCard.set(s.scryfallId, [s]);
  }
  byCard.forEach((arr) => arr.sort((a, b) => a.at - b.at));

  return watched
    .map((w) => ({
      watched: w,
      oracle: oracleMap.get(w.oracleId),
      printing: printMap.get(w.scryfallId),
      snapshots: byCard.get(w.scryfallId) ?? [],
    }))
    .sort((a, b) => (a.oracle?.name ?? '').localeCompare(b.oracle?.name ?? ''));
}
