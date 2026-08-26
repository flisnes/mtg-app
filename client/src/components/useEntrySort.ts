import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import type { JoinedEntry, JoinedWish } from '../db/queries.js';
import { historyChange } from '../price/history.js';
import { loadLastEdited, lastEditedFor, type LastEditedIndex } from '../history/lastEdited.js';
import { priceValue, pricedForFinish, type CardSortPrefs, type SortFields } from './cardSort.js';

// Sorting your own cards needs two things the joined rows don't carry: the
// recorded price change, and when the copy was last edited. Both come from
// tables you don't want to touch unless the sort actually asks for them —
// priceHistories is the biggest user-data table and events is append-only —
// so they load lazily, keyed on the active sort.
//
// The collection page, the wishlist page and the search scoped into either of
// them all sort by the same keys, so they all go through here. That's what
// lets the scoped search offer the very same options the list page does.

export interface EntrySortData {
  changes?: Map<string, { delta: number; pct: number | null }>;
  lastEdited?: LastEditedIndex;
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

  // Per-printing "last edited", matching the top row of that printing's History
  // tab. This is what the sort keys off, NOT entry.updatedAt: updatedAt can move
  // for reasons that leave no history entry, so the event log is the source of
  // truth the user actually sees.
  const needEdited = sort.key === 'updated';
  const lastEdited = useLiveQuery(async () => (needEdited ? loadLastEdited() : undefined), [needEdited]);

  // Stable identity: callers memoize their sort on this, and the collection is
  // thousands of rows to re-sort if it changes every render.
  return useMemo(() => ({ changes, lastEdited }), [changes, lastEdited]);
}

/** Sort fields for a collection (or tradelist) row. */
export function collectionSortFields(r: JoinedEntry, data: EntrySortData): SortFields {
  return {
    name: r.oracle?.name,
    cmc: r.oracle?.cmc,
    price: priceValue(pricedForFinish(r.printing, r.entry.finish), r.oracle),
    change: data.changes?.get(r.entry.scryfallId)?.delta ?? null,
    changePct: data.changes?.get(r.entry.scryfallId)?.pct ?? null,
    added: r.entry.createdAt,
    updated: (data.lastEdited && lastEditedFor(data.lastEdited, r.entry.oracleId, r.entry.scryfallId)) ?? r.entry.updatedAt,
  };
}

/** Sort fields for a wishlist row. A wish may target "any printing", which is
 *  the null scryfallId lastEditedFor already handles. */
export function wishSortFields(r: JoinedWish, data: EntrySortData): SortFields {
  return {
    name: r.oracle?.name,
    cmc: r.oracle?.cmc,
    price: priceValue(r.printing, r.oracle),
    added: r.entry.createdAt,
    updated: (data.lastEdited && lastEditedFor(data.lastEdited, r.entry.oracleId, r.entry.scryfallId)) ?? r.entry.updatedAt,
  };
}
