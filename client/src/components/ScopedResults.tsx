import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { joinCollectionEntries, joinWishlistEntries, type JoinedEntry, type JoinedWish } from '../db/queries.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import { collectionCardItem, wishCardItem } from './cardRows.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { SortControls, sortCards, useCardSort } from './CardSorting.js';
import { collectionSortFields, useEntrySortData, wishSortFields } from './useEntrySort.js';

export type Scope = 'collection' | 'wishlist' | 'tradelist';

// The global search, scoped to one of your own lists: instead of the whole card
// database it searches that collection / tradelist / wishlist and shows the
// same per-entry rows the list pages do (printing, quantity, condition),
// tapping through to the same editor. An empty query lists everything in scope.
//
// This is the *away* case only — search scoped to the page you're already on
// filters that page in place instead (see GlobalSearch). Multi-select and the
// bulk actions still live on the list pages, but sorting doesn't: it's the same
// rows in the same order, so it reads the list's own `cardSort:<scope>`
// preference and offers the same options. Reorder your tradelist from a deck
// screen and the tradelist page has already changed when you get there.

export function ScopedResults({ scope, query }: { scope: Scope; query: string }) {
  const [view, setView] = useViewMode();
  // The very preference the list page persists — 'collection' and 'tradelist'
  // are separate lists with separate sorts, same as their two screens.
  const [sort, setSort] = useCardSort(scope);
  const sortData = useEntrySortData(sort);
  const [editColl, setEditColl] = useState<JoinedEntry | null>(null);
  const [editWish, setEditWish] = useState<JoinedWish | null>(null);
  const moverFlags = useMoverFlags();
  const ownership = useOwnershipIndex();
  const placements = usePlacementIndex();

  const needCollection = scope === 'collection' || scope === 'tradelist';
  const needWishlist = scope === 'wishlist';

  const collRows = useLiveQuery<JoinedEntry[]>(
    async () => (needCollection ? joinCollectionEntries(await db.collection.toArray()) : []),
    [needCollection],
  );
  const wishRows = useLiveQuery<JoinedWish[]>(
    async () => (needWishlist ? joinWishlistEntries(await db.wishlist.toArray()) : []),
    [needWishlist],
  );

  const collMatches = useEntryMatcher(collRows, query);
  const wishMatches = useEntryMatcher(wishRows, query);

  const items = useMemo(() => {
    if (needWishlist) {
      const matched = (wishRows ?? []).filter(wishMatches);
      return sortCards(matched, (r) => wishSortFields(r, sortData), sort).map(
        (r): CardItem => ({
          ...wishCardItem(r, { ownership, moverFlags, onClick: r.oracle ? () => setEditWish(r) : undefined }),
          key: `w:${r.entry.id}`,
        }),
      );
    }
    // 'collection' covers every entry; 'tradelist' narrows to the copies
    // actually marked for trade.
    const matched = (collRows ?? []).filter(
      (r) => (scope !== 'tradelist' || r.entry.quantityForTrade > 0) && collMatches(r),
    );
    return sortCards(matched, (r) => collectionSortFields(r, sortData), sort).map(
      (r): CardItem => ({
        ...collectionCardItem(r, { moverFlags, placements, onClick: () => setEditColl(r) }),
        key: `c:${r.entry.id}`,
      }),
    );
  }, [collRows, wishRows, collMatches, wishMatches, scope, needWishlist, sort, sortData, moverFlags, ownership, placements]);

  const { limit, showMore } = usePagedLimit(`${query}|${scope}|${sort.key}:${sort.dir}`, 60);
  const visible = items.slice(0, limit);

  const loading = (needCollection && collRows === undefined) || (needWishlist && wishRows === undefined);

  return (
    <>
      <div className="meta-row">
        <p className="search-meta">
          {loading ? 'Loading…' : `${items.length} result${items.length === 1 ? '' : 's'}`}
        </p>
        <div className="meta-actions">
          <SortControls
            prefs={sort}
            onChange={setSort}
            withChange={needCollection}
            withDates
          />
          <ViewToggle mode={view} onChange={setView} />
        </div>
      </div>

      {!loading && items.length === 0 ? (
        <p className="search-meta">Nothing here matches.</p>
      ) : (
        <>
          <CardItems view={view} items={visible} />
          <LoadMoreSentinel hasMore={items.length > visible.length} onLoadMore={showMore} rearmKey={visible.length} />
        </>
      )}

      {editColl?.oracle && <CardSheet oracleCard={editColl.oracle} entry={editColl.entry} onClose={() => setEditColl(null)} />}
      {editWish?.oracle && (
        <CardSheet oracleCard={editWish.oracle} wishEntry={editWish.entry} onClose={() => setEditWish(null)} />
      )}
    </>
  );
}
