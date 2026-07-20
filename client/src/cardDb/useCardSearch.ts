import { useEffect, useState } from 'react';
import type { OracleCard, Priced } from '@mtg/shared';
import { searchCards, type SearchFilters } from './search.js';

// Debounced card-database search, shared by every picker (global search
// overlay, import fixes, trade offers). Results clear when the criteria empty.

const NO_FILTERS: SearchFilters = {};

export function useCardSearch(
  query: string,
  opts: {
    /** Memoize in the caller — a fresh object every render re-runs the search. */
    filters?: SearchFilters;
    limit?: number;
    /** Overrides the default "query is non-empty" gate (e.g. filter-only searches). */
    enabled?: boolean;
  } = {},
): { results: Priced<OracleCard>[]; total: number; searching: boolean } {
  const { filters = NO_FILTERS, limit = 20 } = opts;
  const enabled = opts.enabled ?? query.trim().length > 0;
  const [results, setResults] = useState<Priced<OracleCard>[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setResults([]);
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
      const res = await searchCards(query, filters, limit);
      if (cancelled) return;
      setResults(res.cards);
      setTotal(res.total);
      setSearching(false);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, filters, limit, enabled]);

  return { results, total, searching };
}
