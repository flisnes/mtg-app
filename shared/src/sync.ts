import type { TradeLine, WishLine } from './user.js';

// Row-level sync between a signed-in user's devices (sync plan, 2026-07-16).
// Every change to a user-data row travels as a SyncChange envelope; the server
// stores the latest envelope per (table, rowId) and hands out everything a
// device hasn't seen yet by per-user sequence number. Conflicts resolve
// last-write-wins on updatedAt (client clock; the server clamps far-future
// values so a wrong clock can't win forever). Deletes are tombstones, kept
// forever so late-syncing devices converge.

export const SYNC_TABLES = [
  'collection',
  'sealedItems',
  'wishlist',
  'decks',
  'deckCards',
  'deckFolders',
  'trades',
  'events',
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

export interface SyncChange {
  tbl: SyncTable;
  rowId: string;
  /** LWW comparator (ms epoch, client clock). */
  updatedAt: number;
  /** Tombstone: the row was deleted; `row` is omitted. */
  deleted?: true;
  /** Full row as stored client-side; absent when deleted. */
  row?: unknown;
  /**
   * Server → client only: this change's own sequence number, so a client that
   * cannot apply a change (a table added after its build) can stop its cursor
   * just short of it instead of advancing past and losing the row for good.
   * Ignored on a push. Absent from servers older than v0.135.5.
   */
  seq?: number;
}

/** Client → server. Push and pull are one atomic call; a pure pull sends no changes. */
export interface SyncRequest {
  /** Random per-device id; lets the server label notifications by origin. */
  clientId: string;
  /** Highest server seq this device has applied. 0 = never synced. */
  cursor: number;
  changes: SyncChange[];
  /**
   * Piggybacked public lists (client-computed — the server has no card names).
   * Sent whenever the push touched the tradelist or wishlist.
   */
  publish?: { tradelist: TradeLine[]; wishlist: WishLine[] };
  /**
   * "I am part-way through pulling this account from scratch — don't order
   * another reseed." Set by a device that has already wiped (or deliberately
   * rewound its cursor to re-pull), for every pass until it is caught up.
   *
   * Without it, a big account can never finish a reseed: the pull is capped at
   * SYNC_MAX_PULL, so the second pass asks from a cursor that is still below
   * the pruned floor, the server orders another reseed, and the device wipes
   * and starts over forever. Skipping the check costs the one thing a reseed
   * protects against (a row deleted elsewhere whose tombstone was pruned), and
   * a device that just wiped is holding nothing to protect.
   */
  reseeding?: true;
}

export interface SyncResponse {
  /** New cursor after this call. */
  cursor: number;
  /**
   * Changes this device hasn't seen (other devices' work), plus the stored
   * winner for any pushed change that lost LWW. Never echoes accepted pushes.
   */
  changes: SyncChange[];
  /** Set when the pull was capped; call again with the new cursor. */
  hasMore?: true;
  /**
   * This device's cursor sits below the point the server has pruned tombstones
   * to, so its copy may still hold rows that were deleted on another device.
   * The push in this same call was applied (nothing local is lost) — the device
   * must now wipe its user-data tables and re-pull the account from cursor 0.
   * Never sent for cursor 0, which would make the reseed loop forever.
   */
  resync?: true;
}

/** Max changes per push; clients batch the outbox. */
export const SYNC_MAX_PUSH = 1000;
/** Max changes returned per pull before hasMore kicks in. */
export const SYNC_MAX_PULL = 2000;

/**
 * Per-row JSON size cap, in UTF-8 bytes, by table. One cap for every table let
 * a single row be 32 KB when the measured reality is under 600 bytes for
 * everything except trades, so the theoretical worst case was rows-cap ×
 * 32 KB. These are per-shape budgets instead: generous headroom over what the
 * app can actually write, tight enough that the row count bounds the bytes.
 *
 * `trades` is the outlier — the relay allows MAX_OFFER_LINES (500) per side, so
 * a big trade is ~1000 self-contained lines at ~200 bytes each. It used to
 * share the 32 KB cap, which silently 413'd any trade over ~160 lines.
 */
export const SYNC_MAX_ROW_BYTES: Record<SyncTable, number> = {
  collection: 4_000,
  sealedItems: 4_000,
  wishlist: 4_000,
  // Carries a user-typed name + description (MAX_DECK_NAME/DESCRIPTION_LENGTH).
  decks: 16_000,
  deckCards: 4_000,
  deckFolders: 4_000,
  trades: 256_000,
  events: 4_000,
};

/** Total stored rows per user (tombstones included). */
export const SYNC_MAX_ROWS_PER_USER = 500_000;
/**
 * Total stored row bytes per user (UTF-8 length of the stored JSON; tombstones
 * are free). The row cap alone bounded count but not size — at the per-table
 * caps above, 500k rows could still have been many GB. Roughly 4x the largest
 * real profile measured (20k cards, 25 decks, 100 trades ≈ 17 MB), and about
 * 100 MB on disk once SQLite row and index overhead is counted.
 */
export const SYNC_MAX_BYTES_PER_USER = 64 * 1024 * 1024;
