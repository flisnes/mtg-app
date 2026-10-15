import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CollectionEntry, Deck, DeckCard, WishlistEntry } from '@mtg/shared';
import { db } from './schema.js';
import { getSyncStatusSnapshot, subscribeSyncStatus } from '../sync/engine.js';
import { useCoalescedLiveQuery } from './useCoalescedLiveQuery.js';
import { joinCollectionEntries, joinWishlistEntries, type JoinedEntry, type JoinedWish } from './queries.js';
import { buildOwnershipIndex, type OwnershipIndex } from './useOwnership.js';
import { buildPlacementIndex, type PlacementIndex } from './usePlacements.js';

// The one shared snapshot of the user's own cardboard. Before this existed,
// every consumer ran its own live query over the whole collection, so a single
// quantity edit re-read the table five times and ran the expensive card join
// (thousands of entries against 100k printings) twice — once for the list rows,
// once for the header total. Now the tables are read once, the join runs once,
// and the ownership / placement indexes are built once; everything else derives
// from context.
//
// One live query per table, deliberately not one combined query: each re-emits
// only when its own table changes, so filing a card into a deck doesn't re-join
// the collection, and a wishlist edit doesn't rebuild the placement index.

interface CollectionSnapshot {
  /** Every collection row, straight off the table. */
  entries: CollectionEntry[] | undefined;
  /** Every wishlist row, straight off the table. */
  wishes: WishlistEntry[] | undefined;
  /** Every deck, binder and box row (unsorted; sort where you need an order). */
  containers: Deck[] | undefined;
  /** Every deckCards row across all containers. */
  slots: DeckCard[] | undefined;
  /** The same rows joined with card + printing display data (the expensive one). */
  joined: JoinedEntry[] | undefined;
  ownership: OwnershipIndex | undefined;
  placements: PlacementIndex | undefined;
  /** Copies filed in more places than you own — the header bell's dot. */
  conflictCount: number;
}

const EMPTY: CollectionSnapshot = {
  entries: undefined,
  wishes: undefined,
  containers: undefined,
  slots: undefined,
  joined: undefined,
  ownership: undefined,
  placements: undefined,
  conflictCount: 0,
};

const Ctx = createContext<CollectionSnapshot>(EMPTY);

// The wishlist join is built only while something on screen asks for it: most
// screens never show wish rows, and the join is a card-DB read per wish.
interface WishJoin {
  rows: JoinedWish[] | undefined;
  subscribe: () => () => void;
}
const WishCtx = createContext<WishJoin>({ rows: undefined, subscribe: () => () => {} });

export function CollectionSnapshotProvider({ children }: { children: ReactNode }) {
  // Coalesced: a burst of writes (a sync's pages, a bulk import, a batch undo)
  // re-runs the join and the indexes once, not once per write. A sync holds
  // changes back until it's done, so the screen doesn't redraw per page.
  const syncing = useSyncExternalStore(subscribeSyncStatus, getSyncStatusSnapshot).phase === 'syncing';
  const entries = useCoalescedLiveQuery(() => db.collection.toArray(), syncing);
  const wishes = useCoalescedLiveQuery(() => db.wishlist.toArray(), syncing);
  const containers = useCoalescedLiveQuery(() => db.decks.toArray(), syncing);
  const slots = useCoalescedLiveQuery(() => db.deckCards.toArray(), syncing);

  // A live query rather than a useMemo so a card-DB update (oracleCards and
  // printings replaced wholesale) re-joins even though the entries didn't move.
  const joined = useLiveQuery(
    async () => (entries ? joinCollectionEntries(entries) : undefined),
    [entries],
  );

  const [wishSubs, setWishSubs] = useState(0);
  const wanted = wishSubs > 0;
  const joinedWishes = useLiveQuery(
    async () => (wanted && wishes ? joinWishlistEntries(wishes) : undefined),
    [wanted, wishes],
  );
  const subscribe = useCallback(() => {
    setWishSubs((n) => n + 1);
    return () => setWishSubs((n) => n - 1);
  }, []);
  const wishJoin = useMemo<WishJoin>(
    () => ({ rows: wanted ? joinedWishes : undefined, subscribe }),
    [wanted, joinedWishes, subscribe],
  );

  const ownership = useMemo(
    () => (entries && wishes ? buildOwnershipIndex(entries, wishes) : undefined),
    [entries, wishes],
  );
  const placements = useMemo(
    () => (containers && slots && entries ? buildPlacementIndex(containers, slots, entries) : undefined),
    [containers, slots, entries],
  );

  const value = useMemo<CollectionSnapshot>(
    () => ({
      entries,
      wishes,
      containers,
      slots,
      joined,
      ownership,
      placements,
      conflictCount: placements?.conflicts.length ?? 0,
    }),
    [entries, wishes, containers, slots, joined, ownership, placements],
  );
  return (
    <Ctx.Provider value={value}>
      <WishCtx.Provider value={wishJoin}>{children}</WishCtx.Provider>
    </Ctx.Provider>
  );
}

export function useCollectionSnapshot(): CollectionSnapshot {
  return useContext(Ctx);
}

/** The collection rows on their own, no card-DB join. Lands in milliseconds. */
export function useCollectionEntries(): CollectionEntry[] | undefined {
  return useContext(Ctx).entries;
}

/** Collection rows joined with their card + printing display data. */
export function useJoinedCollection(): JoinedEntry[] | undefined {
  return useContext(Ctx).joined;
}

/** Wishlist rows on their own, no card-DB join. */
export function useWishes(): WishlistEntry[] | undefined {
  return useContext(Ctx).wishes;
}

/** Every deck, binder and box, plus every slot in them. */
export function useContainers(): { containers: Deck[] | undefined; slots: DeckCard[] | undefined } {
  const { containers, slots } = useContext(Ctx);
  return { containers, slots };
}

/**
 * Wishlist rows joined with card + printing display data. The join runs once,
 * shared by every caller, and only while at least one enabled caller is mounted.
 */
export function useJoinedWishes(enabled = true): JoinedWish[] | undefined {
  const { rows, subscribe } = useContext(WishCtx);
  useEffect(() => (enabled ? subscribe() : undefined), [enabled, subscribe]);
  return enabled ? rows : undefined;
}

/** Every container, most recently edited first (the Decks page order). */
export function useContainersByRecent(): Deck[] | undefined {
  const containers = useContext(Ctx).containers;
  return useMemo(() => containers && [...containers].sort((a, b) => b.updatedAt - a.updatedAt), [containers]);
}

/** One container's slots, off the snapshot. */
export function useDeckSlots(deckId: string): DeckCard[] | undefined {
  const slots = useContext(Ctx).slots;
  return useMemo(() => slots?.filter((c) => c.deckId === deckId), [slots, deckId]);
}
