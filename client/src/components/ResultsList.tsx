import type { ReactNode } from 'react';
import { CardItems, ViewToggle, useGridColumns, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';

// The shell every scoped search wears: a meta row saying how many results there
// are with the sort and view controls on the right, then the cards, then the
// sentinel that pages more in as you reach the bottom.
//
// ScopedResults, ContainerScopedResults and ProfileScopedResults had written
// this out three times each with its own copy of the view mode, the paging and
// the "Nothing here matches." line — same markup, drifting only in what the meta
// line says. They keep the part that is actually theirs: which rows to show,
// how to sort them, and which sheet a tap opens.
//
// CardSearchView deliberately does NOT use this. Searching the card database is
// paged by the search itself (a Show more button that asks for the next slice),
// not by slicing a list already in hand, and it carries the multi-select toggle.

export function ResultsList({
  items,
  pageKey,
  pageSize = 60,
  status,
  controls,
  showEmpty,
  emptyText = 'Nothing here matches.',
}: {
  items: CardItem[];
  /** Paging signature: changing it starts again from the first page. */
  pageKey: string;
  pageSize?: number;
  /** The meta line — the caller words it (results, a count, "Loading…", an error). */
  status: ReactNode;
  /** Rendered in the meta row before the view toggle; the list's Sort control. */
  controls?: ReactNode;
  /** True when `status` has said all there is to say and the cards should give
   *  way to `emptyText`. The caller decides, since "no matches" and "not loaded
   *  yet" read the same from here. */
  showEmpty: boolean;
  emptyText?: string;
}) {
  const [view, setView] = useViewMode();
  const { gridRef, columns } = useGridColumns();
  const { limit, showMore } = usePagedLimit(pageKey, pageSize, columns);
  const visible = items.slice(0, limit);

  return (
    <>
      <div className="meta-row">
        <p className="search-meta">{status}</p>
        <div className="meta-actions">
          {controls}
          <ViewToggle mode={view} onChange={setView} />
        </div>
      </div>

      {showEmpty ? (
        <p className="search-meta">{emptyText}</p>
      ) : (
        <>
          <CardItems view={view} items={visible} gridRef={gridRef} />
          <LoadMoreSentinel hasMore={items.length > visible.length} onLoadMore={showMore} rearmKey={visible.length} />
        </>
      )}
    </>
  );
}

/** "3 results" / "1 result" — the wording all three scoped lists start from. */
export function resultCount(n: number): string {
  return `${n} result${n === 1 ? '' : 's'}`;
}
