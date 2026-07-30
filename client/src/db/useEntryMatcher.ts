import { useMemo } from 'react';
import type { OracleCard } from '@mtg/shared';
import { compileCardQuery, toSearchableEntry, type SearchableEntry } from '../cardDb/querySyntax.js';

/** Any joined list row: an entry with an id, plus the card it resolved to. */
interface JoinedRow {
  entry: { id: string };
  oracle?: OracleCard;
}

/**
 * Scryfall-syntax filter for a list of joined entries (collection, tradelist,
 * wishlist). Each row's match fields are pre-normalised once per data change,
 * so the returned predicate is cheap to run on every keystroke.
 *
 * An empty query keeps everything — including rows whose card is missing from
 * the DB, which can't produce a `SearchableEntry` to match against.
 */
export function useEntryMatcher<T extends JoinedRow>(rows: T[] | undefined, query: string): (row: T) => boolean {
  const index = useMemo(() => {
    const m = new Map<string, SearchableEntry>();
    rows?.forEach((r) => r.oracle && m.set(r.entry.id, toSearchableEntry(r.oracle)));
    return m;
  }, [rows]);

  return useMemo(() => {
    const q = compileCardQuery(query);
    if (q.isEmpty) return () => true;
    return (row: T) => {
      const se = index.get(row.entry.id);
      return !!se && q.matches(se);
    };
  }, [index, query]);
}
