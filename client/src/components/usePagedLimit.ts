import { useEffect, useState } from 'react';

// "Show N more" paging shared by the card search and the edit-history views.
//
// The visible count resets to one page ONLY when `signature` — a value-stable
// string describing the current query/filters — actually changes. The earlier
// inline version keyed its reset effect on the filters *object*, whose identity
// changed every time a card sheet opened/closed over the results, snapping the
// count back to the first page and losing everything the user had paged in.
// Passing a serialized signature (value equality, not reference) fixes that.
export function usePagedLimit(
  signature: string,
  pageSize: number,
): { limit: number; showMore: () => void; ensure: (min: number) => void } {
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => {
    setLimit(pageSize);
  }, [signature, pageSize]);
  return {
    limit,
    showMore: () => setLimit((l) => l + pageSize),
    // Page in enough to cover a specific row (e.g. a deep link landing past
    // the first page), without resetting anything already paged in beyond it.
    ensure: (min: number) => setLimit((l) => Math.max(l, min)),
  };
}
