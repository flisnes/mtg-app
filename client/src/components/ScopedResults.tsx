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

export type Scope = 'collection' | 'wishlist' | 'tradelist';

// The global search, scoped to one of your own lists: instead of the whole card
// database it searches that collection / tradelist / wishlist and shows the
// same per-entry rows the list pages do (printing, quantity, condition),
// tapping through to the same editor. An empty query lists everything in scope.
//
// This is the *away* case only — search scoped to the page you're already on
// filters that page in place instead (see GlobalSearch). So there's no sorting
// or multi-select here: those live on the list pages, which is the whole point.

export function ScopedResults({ scope, query }: { scope: Scope; query: string }) {
  const [view, setView] = useViewMode();
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
    const out: CardItem[] = [];
    if (needCollection) {
      for (const r of collRows ?? []) {
        // 'collection' covers every entry; 'tradelist' narrows to the copies
        // actually marked for trade.
        if (scope === 'tradelist' && r.entry.quantityForTrade <= 0) continue;
        if (!collMatches(r)) continue;
        out.push({
          ...collectionCardItem(r, { moverFlags, placements, onClick: () => setEditColl(r) }),
          key: `c:${r.entry.id}`,
        });
      }
    }
    if (needWishlist) {
      for (const r of wishRows ?? []) {
        if (!wishMatches(r)) continue;
        out.push({
          ...wishCardItem(r, { ownership, moverFlags, onClick: r.oracle ? () => setEditWish(r) : undefined }),
          key: `w:${r.entry.id}`,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [collRows, wishRows, collMatches, wishMatches, scope, needCollection, needWishlist, moverFlags, ownership, placements]);

  const { limit, showMore } = usePagedLimit(`${query}|${scope}`, 60);
  const visible = items.slice(0, limit);

  const loading = (needCollection && collRows === undefined) || (needWishlist && wishRows === undefined);

  return (
    <>
      <div className="meta-row">
        <p className="search-meta">
          {loading ? 'Loading…' : `${items.length} result${items.length === 1 ? '' : 's'}`}
        </p>
        <ViewToggle mode={view} onChange={setView} />
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
