import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { EventSource, UserEvent } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { FILTER_CATEGORIES } from './eventRegistry.js';

// The edit-history data layer: reads the whole event log newest-first, groups
// the lines of an import/sealed add (shared batchId) or a trade (shared
// tradeId) into a single entry, applies the view's filters, and slices to the
// requested number of entries. Kept separate from the page so the grouping +
// filtering is testable in isolation and reusable.
//
// Scale note: the events table is loaded in full (like the collection join and
// the per-card history already do) and grouped in memory; only the sliced
// entries are ever rendered, so cost scales with the page size, not the log.

/** One row in the edit-history list. */
export type HistoryEntry =
  | { kind: 'single'; id: string; ts: number; event: UserEvent }
  | { kind: 'batch'; id: string; ts: number; source: EventSource; label?: string; events: UserEvent[] };

export interface HistoryFilters {
  /** Card/product name substring (case-insensitive); '' = no name filter. */
  name: string;
  /** A FILTER_CATEGORIES value, or '' for all types. */
  category: string;
  /** Inclusive lower bound (ms epoch), or undefined. */
  from?: number;
  /** Exclusive upper bound (ms epoch), or undefined. */
  to?: number;
}

/** All events of an entry, for enrichment / name matching. */
export function entryEvents(e: HistoryEntry): UserEvent[] {
  return e.kind === 'batch' ? e.events : [e.event];
}

function groupEntries(events: UserEvent[]): HistoryEntry[] {
  // `events` arrives newest-first, so an entry's first-seen event is its newest.
  const map = new Map<string, HistoryEntry>();
  for (const e of events) {
    const batchKey = e.batchId ? `b:${e.batchId}` : e.tradeId ? `t:${e.tradeId}` : null;
    if (batchKey) {
      const existing = map.get(batchKey);
      if (existing && existing.kind === 'batch') {
        existing.events.push(e);
        continue;
      }
      map.set(batchKey, {
        kind: 'batch',
        id: batchKey,
        ts: e.ts,
        source: e.source ?? (e.tradeId ? 'trade' : 'import'),
        label: e.batchLabel,
        events: [e],
      });
    } else {
      map.set(e.id, { kind: 'single', id: e.id, ts: e.ts, event: e });
    }
  }
  return [...map.values()].sort((a, b) => b.ts - a.ts);
}

function matchesType(e: HistoryEntry, category: string): boolean {
  if (!category) return true;
  const cat = FILTER_CATEGORIES.find((c) => c.value === category);
  if (!cat) return true;
  return entryEvents(e).some(cat.match);
}

function matchesDate(e: HistoryEntry, from?: number, to?: number): boolean {
  if (from != null && e.ts < from) return false;
  if (to != null && e.ts >= to) return false;
  return true;
}

/**
 * Grouped, filtered, newest-first history entries, sliced to `limit`.
 * `hasMore` is true when more matching entries exist beyond the slice.
 */
export function useHistoryEntries(
  filters: HistoryFilters,
  limit: number,
): { entries: HistoryEntry[]; hasMore: boolean; loading: boolean } {
  const allEvents = useLiveQuery(() => db.events.orderBy('ts').reverse().toArray(), []);

  const grouped = useMemo(() => (allEvents ? groupEntries(allEvents) : []), [allEvents]);

  // Cheap (event-only) filters first; the name filter needs card names, loaded
  // only when a name query is active.
  const preName = useMemo(
    () => grouped.filter((e) => matchesType(e, filters.category) && matchesDate(e, filters.from, filters.to)),
    [grouped, filters.category, filters.from, filters.to],
  );

  const nameQuery = filters.name.trim().toLowerCase();
  const oracleIds = useMemo(() => {
    if (!nameQuery) return [];
    const ids = new Set<string>();
    for (const e of preName) for (const ev of entryEvents(e)) ids.add(ev.oracleId);
    return [...ids];
  }, [preName, nameQuery]);

  const nameMap = useLiveQuery(
    () => (nameQuery ? getOracleCardsByIds(oracleIds) : Promise.resolve(undefined)),
    [nameQuery, oracleIds.join(',')],
  );

  const matched = useMemo(() => {
    if (!nameQuery) return preName;
    if (!nameMap) return null; // names still loading — avoid a wrong (empty) result
    return preName.filter((e) =>
      entryEvents(e).some((ev) => nameMap.get(ev.oracleId)?.name.toLowerCase().includes(nameQuery)),
    );
  }, [preName, nameQuery, nameMap]);

  const loading = allEvents === undefined || matched === null;
  const list = matched ?? [];
  return { entries: list.slice(0, limit), hasMore: list.length > limit, loading };
}
