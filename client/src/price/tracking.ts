import type { PriceHistory } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrintingsByIds } from '../db/queries.js';
import { recordDay, toCents } from './history.js';

// Price tracking (client-only). Every distinct printing in the collection is
// tracked automatically: whenever the app opens, the current card-DB price of
// each one is recorded, at most once per calendar day. The card DB itself
// refreshes daily (prices ≤24h stale), so this builds a daily price history
// without any per-card API traffic. Each card's history is one compact
// PriceHistory row (cents indexed by day), so a whole collection stays small.

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Record today's price for every printing in the collection that doesn't have
 * one yet, and drop histories of cards no longer owned. Returns how many
 * readings were added.
 */
export async function recordCollectionPrices(): Promise<number> {
  const entries = await db.collection.toArray();
  const owned = new Set(entries.map((e) => e.scryfallId));

  const stale = (await db.priceHistories.toCollection().primaryKeys()).filter((k) => !owned.has(k));
  if (stale.length) await db.priceHistories.bulkDelete(stale);
  if (!owned.size) return 0;

  const day = today();
  const ids = [...owned];
  const [printings, histories] = await Promise.all([getPrintingsByIds(ids), db.priceHistories.bulkGet(ids)]);

  const toPut: PriceHistory[] = [];
  ids.forEach((scryfallId, i) => {
    const p = printings.get(scryfallId);
    if (!p) return;
    const eur = toCents(p.priceEur);
    const usd = toCents(p.priceUsd);
    const h = histories[i];
    if (!h) {
      toPut.push({ scryfallId, startDay: day, eur: [eur], usd: [usd] });
    } else if (recordDay(h, day, eur, usd)) {
      toPut.push(h);
    }
  });
  if (toPut.length) await db.priceHistories.bulkPut(toPut);
  return toPut.length;
}

/** The recorded history for one printing, if any. */
export async function getPriceHistory(scryfallId: string): Promise<PriceHistory | undefined> {
  return db.priceHistories.get(scryfallId);
}
