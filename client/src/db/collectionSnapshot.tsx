import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CollectionEntry } from '@mtg/shared';
import { db } from './schema.js';
import { joinCollectionEntries, type JoinedEntry } from './queries.js';
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
  /** The same rows joined with card + printing display data (the expensive one). */
  joined: JoinedEntry[] | undefined;
  ownership: OwnershipIndex | undefined;
  placements: PlacementIndex | undefined;
  /** Copies filed in more places than you own — the header bell's dot. */
  conflictCount: number;
}

const EMPTY: CollectionSnapshot = {
  entries: undefined,
  joined: undefined,
  ownership: undefined,
  placements: undefined,
  conflictCount: 0,
};

const Ctx = createContext<CollectionSnapshot>(EMPTY);

export function CollectionSnapshotProvider({ children }: { children: ReactNode }) {
  const entries = useLiveQuery(() => db.collection.toArray(), []);
  const wishes = useLiveQuery(() => db.wishlist.toArray(), []);
  const containers = useLiveQuery(() => db.decks.toArray(), []);
  const slots = useLiveQuery(() => db.deckCards.toArray(), []);

  // A live query rather than a useMemo so a card-DB update (oracleCards and
  // printings replaced wholesale) re-joins even though the entries didn't move.
  const joined = useLiveQuery(
    async () => (entries ? joinCollectionEntries(entries) : undefined),
    [entries],
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
      joined,
      ownership,
      placements,
      conflictCount: placements?.conflicts.length ?? 0,
    }),
    [entries, joined, ownership, placements],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
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
