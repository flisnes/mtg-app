import { useEffect, useState } from 'react';

// "Show N more" paging shared by the card search and the edit-history views.
//
// The visible count resets to one page ONLY when `signature` — a value-stable
// string describing the current query/filters — actually changes. The earlier
// inline version keyed its reset effect on the filters *object*, whose identity
// changed every time a card sheet opened/closed over the results, snapping the
// count back to the first page and losing everything the user had paged in.
// Passing a serialized signature (value equality, not reference) fixes that.
//
// `columns` (from useGridColumns) rounds the count up to a whole number of grid
// rows. Left as a half-filled bottom row, a page looks like the end of the
// list, so people stop scrolling before the sentinel ever fires. Rounding only
// ever grows the count, so a resize re-flows the rows without paging anything
// back out. Zero — list view, or the grid hasn't measured yet — means no
// rounding.
export function usePagedLimit(
  signature: string,
  pageSize: number,
  columns = 0,
): { limit: number; showMore: () => void } {
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => {
    setLimit(pageSize);
  }, [signature, pageSize]);
  return {
    limit: columns > 1 ? Math.ceil(limit / columns) * columns : limit,
    showMore: () => setLimit((l) => l + pageSize),
  };
}
