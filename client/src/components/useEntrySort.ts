import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { getPricesByIds, priceForFinish } from '../cardDb/prices.js';
import type { JoinedEntry, JoinedWish } from '../db/queries.js';
import { acquisitionGain, costBasisOf } from '../price/costBasis.js';
import { historyChange } from '../price/history.js';
import { valueKeyOf } from '../price/collectionValue.js';
import { pickPrice, priceValue, pricedForFinish, releaseFields, type CardSortPrefs, type SortFields } from './cardSort.js';

// Sorting your own cards needs one thing the joined rows don't carry: the
// recorded price change. It comes from priceHistories, the biggest user-data
// table, which you don't want to touch unless the sort actually asks for it —
// so it loads lazily, keyed on the active sort.
//
// The collection page, the wishlist page and the search scoped into either of
// them all sort by the same keys, so they all go through here. That's what
// lets the scoped search offer the very same options the list page does.
//
// "Value change" is how much the card is worth now against what it cost you:
// the exact number the card sheet prints, produced by the same acquisitionGain
// the sheet calls, so the list and the sheet can never disagree about a card.
//
// It is deliberately not a fixed window. It used to be "since this card's first
// reading", which *was* broken, but not because the span varied: because the
// baseline was an accident. A history starts the day you add a card, and
// opening its sheet while signed in silently backfills it from the server
// archive and moves the baseline again, so the list ranked cards by how long
// they'd happened to be tracked. An acquisition price is the opposite of that:
// stored on the add event, stable, visible on the History tab, and yours to
// correct. The span still varies from card to card, but now the variation is
// your holding period, which is the thing you're asking about. For market
// movement over a comparable window, that's what Price movers is for.

export interface EntrySortData {
  /** Keyed by printing *and* finish (valueKeyOf): your foil copy and your plain
   *  one cost different money and are worth different money. */
  changes?: Map<string, { delta: number; pct: number | null }>;
}

export function useEntrySortData(sort: Pick<CardSortPrefs, 'key'>): EntrySortData {
  const needChanges = sort.key === 'change' || sort.key === 'changePct';
  const changes = useLiveQuery(async () => {
    if (!needChanges) return undefined;
    // Three full reads, all of them big tables, which is why this is lazy: the
    // rows being sorted, their recorded readings, and the adds that say what
    // each printing cost.
    const [entries, histories, events] = await Promise.all([
      db.collection.toArray(),
      db.priceHistories.toArray(),
      db.events.where('kind').equals('collection.add').toArray(),
    ]);
    // Today's price per finish, because that's what the change measures *to*.
    // The tracked readings are nonfoil, so a foil row weighed against its own
    // last reading would show a loss it never took (see costBasis.ts).
    const prices = await getPricesByIds(entries.map((e) => e.scryfallId));
    const historyById = new Map(histories.map((h) => [h.scryfallId, h]));
    // Grouped by oracle because a printing-agnostic add (an "any printing" wish
    // fulfilled, a lands-box basic) counts towards every printing of that card.
    // costBasisOf applies that rule, so it wants the oracle's whole pile.
    const eventsByOracle = new Map<string, typeof events>();
    for (const e of events) {
      const bucket = eventsByOracle.get(e.oracleId);
      if (bucket) bucket.push(e);
      else eventsByOracle.set(e.oracleId, [e]);
    }
    // Driven off the collection, not the event log: the printings being sorted
    // are the ones worth the work, and a row whose only add was printing-
    // agnostic still needs an answer.
    const m = new Map<string, { delta: number; pct: number | null }>();
    for (const entry of entries) {
      const key = valueKeyOf(entry.scryfallId, entry.finish);
      if (m.has(key)) continue;
      const h = historyById.get(entry.scryfallId);
      if (!h) continue;
      const trend = historyChange(h);
      if (!trend) continue;
      const basis = costBasisOf(eventsByOracle.get(entry.oracleId) ?? [], entry.scryfallId, h, entry.finish);
      const { eur, usd } = priceForFinish(prices.get(entry.scryfallId), entry.finish);
      const now = pickPrice([{ priceEur: eur, priceUsd: usd }]);
      // Same call, same fallback, same number as the sheet's PriceTrend, so a
      // card can never rank by one figure and display another.
      const gain = acquisitionGain(trend, basis, now);
      m.set(key, gain ? { delta: gain.delta, pct: gain.pct } : { delta: trend.delta, pct: trend.pct });
    }
    return m;
  }, [needChanges]);

  // Stable identity: callers memoize their sort on this, and the collection is
  // thousands of rows to re-sort if it changes every render.
  return useMemo(() => ({ changes }), [changes]);
}

// "Last edited" is the row's own updatedAt, and deliberately nothing cleverer.
//
// It used to be the newest event in that printing's History, which was both
// imprecise and slow. Imprecise because the event log is keyed by scryfallId:
// your English copy and your Italian one are the same printing, so they shared
// a single value and could never be ordered against each other (same for a
// plain copy and a signed one). And it leaked the other way too — a
// printing-agnostic event (an "any printing" wish, a lands-box basic) was
// folded into every edition, so one "any printing" Forest wish bubbled every
// Forest you owned to the top.
//
// Slow because answering it meant scanning the whole append-only event log, an
// async read the list couldn't wait for. So the first paint substituted
// updatedAt for every row and the second paint replaced it, which visibly threw
// a freshly-edited card to the top and then dropped it back down.
//
// A row's updatedAt is per copy, already correct, and already in hand. Every
// mutation in dataAccess.ts stamps it — quantities, tradelist marks, condition,
// finish, language, special conditions — and since filing now touches the copy
// it claims (touchClaimedCopies), so does moving a card in or out of a deck,
// binder or box. Nothing to load, one paint, and the sort names the exact piece
// of cardboard you touched.

/** Sort fields for a collection (or tradelist) row. */
export function collectionSortFields(r: JoinedEntry, data: EntrySortData): SortFields {
  return {
    name: r.oracle?.name,
    cmc: r.oracle?.cmc,
    price: priceValue(pricedForFinish(r.printing, r.entry.finish), r.oracle),
    change: data.changes?.get(valueKeyOf(r.entry.scryfallId, r.entry.finish))?.delta ?? null,
    changePct: data.changes?.get(valueKeyOf(r.entry.scryfallId, r.entry.finish))?.pct ?? null,
    added: r.entry.createdAt,
    updated: r.entry.updatedAt,
    ...releaseFields(r.printing),
  };
}

/** Sort fields for a wishlist row. The wishlist offers no price-change sorts,
 *  so unlike a collection row this needs nothing lazily loaded. */
export function wishSortFields(r: JoinedWish): SortFields {
  return {
    name: r.oracle?.name,
    cmc: r.oracle?.cmc,
    price: priceValue(r.printing, r.oracle),
    added: r.entry.createdAt,
    updated: r.entry.updatedAt,
    ...releaseFields(r.printing),
  };
}
