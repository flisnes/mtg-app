import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { joinWishlistEntries, type JoinedEntry, type JoinedWish } from '../db/queries.js';
import { useJoinedCollection } from '../db/collectionSnapshot.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
import { CardSheet } from './CardSheet.js';
import type { CardItem } from './CardViews.js';
import { ResultsList, resultCount } from './ResultsList.js';
import { wishCardItem } from './cardRows.js';
import { useMoverFlags } from '../price/useMoverFlags.js';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { SortControls, sortCards, useCardSort } from './CardSorting.js';
import { useEntrySortData, wishSortFields } from './useEntrySort.js';
import { useStackPrintings } from './CardViews.js';
import { stackCardItem } from './cardRows.js';
import { stackEntries, stackSortFields } from './stackPrintings.js';
import { useSetTypes } from '../cardDb/useSetTypes.js';
import { usePrefs } from '../usePrefs.js';
import { useDisplayPrintings } from '../cardDb/useDisplayPrintings.js';

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
  // The very preference the list page persists — 'collection' and 'tradelist'
  // are separate lists with separate sorts, same as their two screens.
  const [sort, setSort] = useCardSort(scope);
  const sortData = useEntrySortData(sort);
  const [editColl, setEditColl] = useState<{ row: JoinedEntry; copies: JoinedEntry[] } | null>(null);
  const [editWish, setEditWish] = useState<JoinedWish | null>(null);
  const moverFlags = useMoverFlags();
  const ownership = useOwnershipIndex();
  const placements = usePlacementIndex();
  // The same stack-printings switch the list pages read, so a search into the
  // collection shows the same tiles the collection does.
  const [stacking] = useStackPrintings();
  const prefs = usePrefs();
  const setTypes = useSetTypes(stacking);

  const needCollection = scope === 'collection' || scope === 'tradelist';
  const needWishlist = scope === 'wishlist';

  // The same joined rows the collection page shows, off the shared snapshot.
  const collRows = useJoinedCollection();
  const wishRows = useLiveQuery<JoinedWish[]>(
    async () => (needWishlist ? joinWishlistEntries(await db.wishlist.toArray()) : []),
    [needWishlist],
  );

  const collMatches = useEntryMatcher(collRows, query);
  const wishMatches = useEntryMatcher(wishRows, query);
  const anyWishes = useMemo(() => wishRows?.filter((r) => !r.entry.scryfallId).map((r) => r.entry), [wishRows]);
  const shownWish = useDisplayPrintings(anyWishes);

  const items = useMemo(() => {
    if (needWishlist) {
      const matched = (wishRows ?? []).filter(wishMatches);
      return sortCards(matched, (r) => wishSortFields(r), sort).map(
        (r): CardItem => ({
          ...wishCardItem(r, {
            ownership,
            moverFlags,
            showYear: sort.key === 'released',
            shown: shownWish.get(r.entry.oracleId),
            onClick: r.oracle ? () => setEditWish(r) : undefined,
          }),
          key: `w:${r.entry.id}`,
        }),
      );
    }
    // 'collection' covers every entry; 'tradelist' narrows to the copies
    // actually marked for trade.
    const matched = (collRows ?? []).filter(
      (r) => (scope !== 'tradelist' || r.entry.quantityForTrade > 0) && collMatches(r),
    );
    const stacks = stackEntries(matched, { stack: stacking, prefs, setTypes });
    return sortCards(stacks, (s) => stackSortFields(s, sortData), sort).map(
      (s): CardItem => ({
        ...stackCardItem(s, {
          moverFlags,
          placements,
          showYear: sort.key === 'released',
          onClick: () => setEditColl({ row: s.members[0]!, copies: s.members }),
        }),
        key: `c:${s.key}`,
      }),
    );
  }, [collRows, wishRows, collMatches, wishMatches, scope, needWishlist, sort, sortData, moverFlags, ownership, placements, stacking, prefs, setTypes, shownWish]);

  const loading = (needCollection && collRows === undefined) || (needWishlist && wishRows === undefined);

  return (
    <>
      <ResultsList
        items={items}
        pageKey={`${query}|${scope}|${sort.key}:${sort.dir}`}
        status={loading ? 'Loading…' : resultCount(items.length)}
        controls={<SortControls prefs={sort} onChange={setSort} withChange={needCollection} withDates withRelease />}
        showEmpty={!loading && items.length === 0}
      />

      {editColl?.row.oracle && (
        <CardSheet
          mode="edit"
          oracleCard={editColl.row.oracle}
          entry={editColl.row.entry}
          copies={editColl.copies.length > 1 ? editColl.copies.map((c) => c.entry) : undefined}
          onClose={() => setEditColl(null)}
        />
      )}
      {editWish?.oracle && (
        <CardSheet mode="wish" oracleCard={editWish.oracle} wishEntry={editWish.entry} onClose={() => setEditWish(null)} />
      )}
    </>
  );
}
