import type { SealedPriceHistory } from '@mtg/shared';
import { db } from '../db/schema.js';
import { refreshSealedPrices } from '../sealed/store.js';
import { sealedPriceOf } from '../sealed/product.js';
import { recordDay, toCents, todayKey } from './history.js';

// Price tracking for unopened sealed products, the shelf's half of what
// price/tracking.ts does for cards. A booster box moves in price like a card
// does — often harder, since nobody reprints a sealed box — so the app records
// what every product on the shelf is quoted at, once per calendar day, into the
// same compact readings format.
//
// The prices themselves ride in the small `sealedPrices` artifact, refreshed
// here rather than only when a sealed screen is opened: a value chart is only
// worth drawing if the readings keep coming in whether or not you visit the page.

/**
 * Record today's price for every unopened product on the shelf, and drop the
 * histories of products no longer owned. Returns how many readings were added.
 *
 * Unlike cards, a sold-off product's history is discarded: sealed items emit no
 * events (a box has no oracleId to hang one on), so nothing can replay the days
 * you held it, and keeping the row would only inflate storage.
 */
export async function recordSealedPrices(): Promise<number> {
  const items = await db.sealedItems.toArray();
  const owned = new Set(items.map((i) => i.productId));
  const stale = (await db.sealedPriceHistories.toCollection().primaryKeys()).filter((k) => !owned.has(k));
  if (stale.length) await db.sealedPriceHistories.bulkDelete(stale);
  if (!owned.size) return 0;

  const prices = await refreshSealedPrices();
  const day = todayKey();
  const ids = [...owned];
  const existing = await db.sealedPriceHistories.bulkGet(ids);

  const toPut: SealedPriceHistory[] = [];
  ids.forEach((productId, i) => {
    const src = sealedPriceOf(prices, productId);
    if (!src) return;
    const eur = toCents(src.priceEur);
    const usd = toCents(src.priceUsd);
    // A product quoted by neither market has nothing to record; a row of nulls
    // would just push the chart's start date back for no information.
    if (eur == null && usd == null) return;
    const h = existing[i];
    if (!h) toPut.push({ productId, startDay: day, eur: [eur], usd: [usd] });
    else if (recordDay(h, day, eur, usd)) toPut.push(h);
  });
  if (toPut.length) await db.sealedPriceHistories.bulkPut(toPut);
  return toPut.length;
}

/** The recorded history for one product, if any. */
export async function getSealedPriceHistory(productId: string): Promise<SealedPriceHistory | undefined> {
  return db.sealedPriceHistories.get(productId);
}
