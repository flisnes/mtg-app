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
  const printings = await getPrintingsByIds(watched.map((w) => w.scryfallId));

  let added = 0;
  await db.transaction('rw', db.priceSnapshots, async () => {
    for (const w of watched) {
      const p = printings.get(w.scryfallId);
      if (!p) continue;
      const already = await db.priceSnapshots.where('[scryfallId+day]').equals([w.scryfallId, day]).count();
      if (already) continue;
      await db.priceSnapshots.add({
        id: crypto.randomUUID(),
        scryfallId: w.scryfallId,
        at: Date.now(),
        day,
        eur: p.priceEur,
        usd: p.priceUsd,
      });
      added++;
    }
  });
  return added;
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
  const [oracleMap, printMap, allSnaps] = await Promise.all([
    getOracleCardsByIds(watched.map((w) => w.oracleId)),
    getPrintingsByIds(watched.map((w) => w.scryfallId)),
    db.priceSnapshots.toArray(),
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
