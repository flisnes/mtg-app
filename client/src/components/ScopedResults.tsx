import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard } from '@mtg/shared';
import { db } from '../db/schema.js';
import { joinCollectionEntries, joinWishlistEntries, type JoinedEntry, type JoinedWish } from '../db/queries.js';
import { compileCardQuery, toSearchableEntry, type SearchableEntry } from '../cardDb/querySyntax.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import { collectionCardItem, wishCardItem } from './cardRows.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { usePlacementIndex } from '../db/usePlacements.js';

export type Scope = 'collection' | 'wishlist' | 'tradelist';

// The global search, scoped to what you already own: instead of the whole card
// database, it searches across the collection / tradelist / wishlist you've
// picked and shows the same per-entry rows the list pages do (printing,
// quantity, condition), tapping through to the same editor. Multiple scopes
// union together; an empty query lists everything in scope. When no scope is
// active the overlay falls back to the full-database card search instead.

// Pre-normalise each row's match fields once per data change so the
// Scryfall-syntax filter (t:/cmc:/o:/…) runs cheaply on every keystroke.
function buildIndex(rows: { entry: { id: string }; oracle?: OracleCard }[] | undefined): Map<string, SearchableEntry> {
  const m = new Map<string, SearchableEntry>();
  rows?.forEach((r) => r.oracle && m.set(r.entry.id, toSearchableEntry(r.oracle)));
  return m;
}

export function ScopedResults({ scopes, query }: { scopes: Set<Scope>; query: string }) {
  const [view, setView] = useViewMode();
  const [editColl, setEditColl] = useState<JoinedEntry | null>(null);
  const [editWish, setEditWish] = useState<JoinedWish | null>(null);
  const moverFlags = useMoverFlags();
  const ownership = useOwnershipIndex();
  const placements = usePlacementIndex();

  const needCollection = scopes.has('collection') || scopes.has('tradelist');
  const needWishlist = scopes.has('wishlist');

  const collRows = useLiveQuery(
    async () => (needCollection ? joinCollectionEntries(await db.collection.toArray()) : []),
    [needCollection],
  );
  const wishRows = useLiveQuery(
    async () => (needWishlist ? joinWishlistEntries(await db.wishlist.toArray()) : []),
    [needWishlist],
  );

  const collIndex = useMemo(() => buildIndex(collRows), [collRows]);
  const wishIndex = useMemo(() => buildIndex(wishRows), [wishRows]);

  // If "collection" is picked it already covers every entry; "tradelist" alone
  // narrows to the cards actually marked for trade.
  const showAllCollection = scopes.has('collection');

  const items = useMemo(() => {
    const q = compileCardQuery(query);
    const matches = (index: Map<string, SearchableEntry>, id: string) => {
      if (q.isEmpty) return true;
      const se = index.get(id);
      return !!se && q.matches(se);
    };

    const out: CardItem[] = [];
    if (needCollection) {
      for (const r of collRows ?? []) {
        if (!showAllCollection && r.entry.quantityForTrade <= 0) continue;
        if (!matches(collIndex, r.entry.id)) continue;
        out.push({
          ...collectionCardItem(r, { moverFlags, placements, onClick: () => setEditColl(r) }),
          key: `c:${r.entry.id}`,
        });
      }
    }
    if (needWishlist) {
      for (const r of wishRows ?? []) {
        if (!matches(wishIndex, r.entry.id)) continue;
        out.push({
          ...wishCardItem(r, { ownership, moverFlags, onClick: r.oracle ? () => setEditWish(r) : undefined }),
          key: `w:${r.entry.id}`,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [collRows, wishRows, collIndex, wishIndex, query, needCollection, needWishlist, showAllCollection, moverFlags, ownership, placements]);

  const { limit, showMore } = usePagedLimit(`${query}|${[...scopes].sort().join(',')}`, 60);
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
