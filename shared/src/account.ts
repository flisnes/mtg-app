// Account & sync API (opt-in). Creating an account means agreeing — via one
// combined disclaimer — to (a) the server storing an encrypted-in-transit copy
// of the user's data as an opaque snapshot blob, and (b) the user's tradelist
// and wishlist being visible to other signed-in users (the Community screen).
//
// The snapshot payload is the same serialized TransferPayload used by device
// transfer: the server never parses it, it only stores and returns it. The
// public trade/wishlists are uploaded alongside as self-contained lines (the
// same TradeLine/WishLine shapes exchanged during a trade), so browsing them
// needs no snapshot parsing on the server and no card-DB lookups to render.

import type { TradeLine, WishLine } from './user.js';

/** Usernames are case-insensitively unique; shown as typed. */
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const MIN_PASSWORD_CHARS = 8;
export const MAX_PASSWORD_CHARS = 200;

/** Snapshot blob cap — matches the device-transfer cap (~30 MB of JSON). */
export const MAX_SNAPSHOT_CHARS = 30_000_000;
/** Per-list cap on published trade/wishlist lines. */
export const MAX_PUBLIC_LINES = 5_000;

/** What a stored snapshot contains, shown before restoring ("review" step). */
export interface SnapshotCounts {
  cards: number;
  collectionEntries: number;
  wishlist: number;
  decks: number;
  trades: number;
}

export interface SnapshotMeta {
  /** Server-side write counter; the optimistic-concurrency token. */
  version: number;
  updatedAt: number;
  counts: SnapshotCounts | null;
}

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  username: string;
  password: string;
  inviteCode: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  username: string;
}

export interface MeResponse {
  username: string;
  snapshot: SnapshotMeta | null;
}

export interface SnapshotPutRequest {
  /**
   * The server version this device last saw (null = never synced). A mismatch
   * means another device pushed in between → 409 with the current meta, so the
   * user can choose to overwrite or restore first.
   */
  baseVersion: number | null;
  /** Serialized TransferPayload JSON — opaque to the server. */
  payload: string;
  counts: SnapshotCounts;
  tradelist: TradeLine[];
  wishlist: WishLine[];
}

export interface SnapshotPutResponse {
  version: number;
  updatedAt: number;
}

export interface SnapshotGetResponse {
  version: number;
  updatedAt: number;
  counts: SnapshotCounts | null;
  payload: string;
}

/** One row on the Community screen. */
export interface PublicUser {
  username: string;
  /** When their lists last changed (i.e. their last backup). */
  updatedAt: number;
  tradelistCount: number;
  wishlistCount: number;
}

export interface UsersResponse {
  users: PublicUser[];
}

export interface UserListsResponse {
  username: string;
  updatedAt: number;
  tradelist: TradeLine[];
  wishlist: WishLine[];
}

/**
 * Error envelope for every non-2xx /api response. `error` is a stable code;
 * `message` is human-readable. A 409 on snapshot PUT carries the server's
 * current version/updatedAt so the client can offer "overwrite".
 */
export interface ApiErrorBody {
  error:
    | 'bad_request'
    | 'invalid_credentials'
    | 'invalid_invite'
    | 'username_taken'
    | 'unauthorized'
    | 'not_found'
    | 'version_conflict'
    | 'rate_limited'
    | 'registration_closed'
    | 'too_large'
    | 'server_error';
  message: string;
  version?: number;
  updatedAt?: number;
}
