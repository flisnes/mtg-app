import type { CollectionEntry, PriceHistory, WishlistEntry } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrintingsByIds } from '../db/queries.js';
import { getSetting, setSetting } from '../db/settings.js';
import { dayOffset, recordDay, toCents, todayKey } from './history.js';

// Price tracking (client-only). Every distinct printing in the collection or
// on the wishlist is tracked automatically: whenever the app opens, the
// current card-DB price of each one is recorded, at most once per calendar
// day. The card DB itself refreshes daily (prices ≤24h stale), so this builds
// a daily price history without any per-card API traffic. Each card's history
// is one compact PriceHistory row (cents indexed by day), so a whole
// collection stays small.

// Launch bookkeeping, so a second launch the same day reads nothing but two
// settings rows. The day stamp carries how many things were tracked: a card
// added since the morning's run still gets today's reading on the next launch.
const KEY_RECORDED = 'lastPriceRecordDay';
// The stale-history sweep reads every collection event; once a week is plenty.
const KEY_SWEPT = 'lastPriceSweepDay';
const SWEEP_EVERY_DAYS = 7;

interface RecordedStamp {
  day: string;
  tracked: number;
}

/**
 * Record today's price for every tracked printing that doesn't have one yet,
 * and (weekly) drop histories of cards no longer tracked. Tracked = every
 * collection printing plus every wishlist printing ("any printing" wishes
 * follow the oracle's default printing, the one their price display uses).
 * Takes the rows from the collection snapshot, which has already read them.
 * Returns how many readings were added.
 */
export async function recordCollectionPrices(entries: CollectionEntry[], wishes: WishlistEntry[]): Promise<number> {
  const day = todayKey();
  const anyWishOracles = [...new Set(wishes.filter((w) => !w.scryfallId).map((w) => w.oracleId))];
  const exact = new Set(entries.map((e) => e.scryfallId));
  for (const w of wishes) if (w.scryfallId) exact.add(w.scryfallId);
  const size = exact.size + anyWishOracles.length;
  const [stamp, swept] = await Promise.all([
    getSetting<RecordedStamp>(KEY_RECORDED),
    getSetting<string>(KEY_SWEPT),
  ]);
  const sweep = !swept || dayOffset(swept, day) >= SWEEP_EVERY_DAYS || dayOffset(swept, day) < 0;
  if (!sweep && stamp?.day === day && stamp.tracked === size) return 0;

  const tracked = new Set(exact);
  // Foil lanes are recorded only for printings held (or wanted) in foil: most
  // of a collection is plain, and an empty lane costs nothing.
  const foil = new Set(entries.filter((e) => e.finish === 'foil').map((e) => e.scryfallId));
  for (const w of wishes) if (w.scryfallId && w.finish === 'foil') foil.add(w.scryfallId);
  for (const o of await db.oracleCards.bulkGet(anyWishOracles)) {
    if (o) tracked.add(o.defaultScryfallId);
  }

  // A printing you once owned keeps its history even after the last copy goes:
  // no new readings accrue for it (only `tracked` ids are recorded below), but
  // the days you did hold it still count on the collection value chart. Drop a
  // history only when nothing in the log ever put that printing in the
  // collection — a wishlist card you gave up on, say.
  if (sweep) {
    const owned = new Set<string>();
    for (const e of await db.events.where('kind').anyOf('collection.add', 'collection.remove').toArray()) {
      if (e.scryfallId) owned.add(e.scryfallId);
    }
    const stale = (await db.priceHistories.toCollection().primaryKeys()).filter((k) => !tracked.has(k) && !owned.has(k));
    if (stale.length) await db.priceHistories.bulkDelete(stale);
    await setSetting(KEY_SWEPT, day);
  }
  if (!tracked.size) {
    await setSetting(KEY_RECORDED, { day, tracked: size } satisfies RecordedStamp);
    return 0;
  }

  const ids = [...tracked];
  const [printings, histories] = await Promise.all([getPrintingsByIds(ids), db.priceHistories.bulkGet(ids)]);

  const toPut: PriceHistory[] = [];
  ids.forEach((scryfallId, i) => {
    const p = printings.get(scryfallId);
    if (!p) return;
    const eur = toCents(p.priceEur);
    const usd = toCents(p.priceUsd);
    // priceHasFoil false means the price artifact predates foil slots, where a
    // missing foil price is "unknown", not "none": record nothing then.
    const foilCents =
      foil.has(scryfallId) && p.priceHasFoil ? { eur: toCents(p.priceEurFoil), usd: toCents(p.priceUsdFoil) } : undefined;
    const h = histories[i] ?? { scryfallId, startDay: day, eur: [], usd: [] };
    if (recordDay(h, day, eur, usd, foilCents)) toPut.push(h);
  });
  if (toPut.length) await db.priceHistories.bulkPut(toPut);
  // No card DB yet (first launch, still downloading) resolves no printings:
  // leave the day open so the next launch records it.
  if (printings.size > 0) await setSetting(KEY_RECORDED, { day, tracked: size } satisfies RecordedStamp);
  return toPut.length;
}

/** The recorded history for one printing, if any. */
export async function getPriceHistory(scryfallId: string): Promise<PriceHistory | undefined> {
  return db.priceHistories.get(scryfallId);
}
