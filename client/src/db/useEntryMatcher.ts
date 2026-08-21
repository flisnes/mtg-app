import { useMemo } from 'react';
import type { Finish, OracleCard } from '@mtg/shared';
import {
  compileCardQuery,
  rowPrintingSummary,
  toSearchableEntry,
  type RowPrinting,
  type SearchableEntry,
} from '../cardDb/querySyntax.js';

/** Any joined list row: an entry with an id, plus the card and printing it resolved to. */
interface JoinedRow {
  entry: { id: string; finish?: Finish };
  oracle?: OracleCard;
  printing?: RowPrinting;
}

/**
 * Scryfall-syntax filter for a list of joined entries (collection, tradelist,
 * wishlist). Each row's match fields are pre-normalised once per data change,
 * so the returned predicate is cheap to run on every keystroke.
 *
 * Printing-level terms (`set:`, `is:foil`, `is:borderless`, …) match the row's
 * own printing rather than every printing of the card — see rowPrintingSummary.
 *
 * An empty query keeps everything — including rows whose card is missing from
 * the DB, which can't produce a `SearchableEntry` to match against.
 */
export function useEntryMatcher<T extends JoinedRow>(rows: T[] | undefined, query: string): (row: T) => boolean {
  const index = useMemo(() => {
    const m = new Map<string, SearchableEntry>();
    rows?.forEach(
      (r) =>
        r.oracle && m.set(r.entry.id, toSearchableEntry(r.oracle, rowPrintingSummary(r.printing, r.entry.finish))),
    );
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
