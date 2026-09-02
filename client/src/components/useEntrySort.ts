import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import type { JoinedEntry, JoinedWish } from '../db/queries.js';
import { historyChange } from '../price/history.js';
import { priceValue, pricedForFinish, type CardSortPrefs, type SortFields } from './cardSort.js';

// Sorting your own cards needs one thing the joined rows don't carry: the
// recorded price change. It comes from priceHistories, the biggest user-data
// table, which you don't want to touch unless the sort actually asks for it —
// so it loads lazily, keyed on the active sort.
//
// The collection page, the wishlist page and the search scoped into either of
// them all sort by the same keys, so they all go through here. That's what
// lets the scoped search offer the very same options the list page does.

export interface EntrySortData {
  changes?: Map<string, { delta: number; pct: number | null }>;
}

export function useEntrySortData(sort: Pick<CardSortPrefs, 'key'>): EntrySortData {
  const needChanges = sort.key === 'change' || sort.key === 'changePct';
  const changes = useLiveQuery(async () => {
    if (!needChanges) return undefined;
    const m = new Map<string, { delta: number; pct: number | null }>();
    for (const h of await db.priceHistories.toArray()) {
      const c = historyChange(h);
      if (c) m.set(h.scryfallId, { delta: c.delta, pct: c.pct });
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
    change: data.changes?.get(r.entry.scryfallId)?.delta ?? null,
    changePct: data.changes?.get(r.entry.scryfallId)?.pct ?? null,
    added: r.entry.createdAt,
    updated: r.entry.updatedAt,
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
  };
}
