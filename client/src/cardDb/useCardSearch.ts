import { useEffect, useState } from 'react';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { searchCards, type SearchFilters, type SearchSort } from './search.js';

// Debounced card-database search, shared by every picker (global search
// overlay, import fixes, trade offers). Results clear when the criteria empty.

const NO_FILTERS: SearchFilters = {};
const BEST_MATCH: SearchSort = { key: 'relevance', dir: 'desc' };
/** Shared empty array, so an unpinned search doesn't churn a new identity per render. */
const NO_PRINTINGS: (Priced<Printing> | undefined)[] = [];

export function useCardSearch(
  query: string,
  opts: {
    /** Memoize in the caller — a fresh object every render re-runs the search. */
    filters?: SearchFilters;
    limit?: number;
    /** Result order; defaults to best-match. Memoize in the caller, like `filters`. */
    sort?: SearchSort;
    /** Overrides the default "query is non-empty" gate (e.g. filter-only searches). */
    enabled?: boolean;
    /**
     * Let a `set:` term expand the results into that set's individual printings
     * (see searchCards). Off by default: a picker keyed by oracle card can't
     * hold two rows for the same card.
     */
    expandPrintings?: boolean;
  } = {},
): {
  results: Priced<OracleCard>[];
  /** Index-aligned with `results` when a `set:` term pinned them; empty otherwise. */
  printings: (Priced<Printing> | undefined)[];
  total: number;
  searching: boolean;
} {
  const { filters = NO_FILTERS, limit = 20, sort = BEST_MATCH, expandPrintings = false } = opts;
  const enabled = opts.enabled ?? query.trim().length > 0;
  const [results, setResults] = useState<Priced<OracleCard>[]>([]);
  const [printings, setPrintings] = useState<(Priced<Printing> | undefined)[]>(NO_PRINTINGS);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setResults([]);
      setPrintings(NO_PRINTINGS);
      setTotal(0);
      setSearching(false);
      return;
    }
    setSearching(true);
    // Guard against out-of-order completion: a slow earlier query (e.g. the one
    // that paid the one-time index build) could otherwise resolve after a newer
    // one and overwrite the results with stale data.
    let cancelled = false;
    const handle = setTimeout(async () => {
      const res = await searchCards(query, filters, limit, sort, expandPrintings);
      if (cancelled) return;
      setResults(res.cards);
      setPrintings(res.printings ?? NO_PRINTINGS);
      setTotal(res.total);
      setSearching(false);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, filters, limit, sort, enabled, expandPrintings]);

  return { results, printings, total, searching };
}
