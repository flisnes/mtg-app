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
  'wishlist',
  'decks',
  'deckCards',
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
}

/** Max changes per push; clients batch the outbox. */
export const SYNC_MAX_PUSH = 1000;
/** Max changes returned per pull before hasMore kicks in. */
export const SYNC_MAX_PULL = 2000;
/** Per-row JSON size cap (a trade with ~100 lines is ~15 KB). */
export const SYNC_MAX_ROW_CHARS = 32_000;
/** Total stored rows per user (tombstones included). */
export const SYNC_MAX_ROWS_PER_USER = 500_000;
