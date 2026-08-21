// Account & sync API (opt-in). Creating an account means agreeing — via one
// combined disclaimer — to (a) the server storing an encrypted-in-transit copy
// of the user's data, and (b) the user's tradelist and wishlist being visible
// to other signed-in users (the Community screen).
//
// User data moves as opaque per-row JSON (see sync.ts): the server stores and
// returns rows without parsing them. The public trade/wishlists ride along as
// self-contained lines (the same TradeLine/WishLine shapes exchanged during a
// trade), so browsing them needs no card-DB lookups on the server.

import type { ProfileAvatar } from './profile.js';
import type { TradeLine, WishLine } from './user.js';

/** Usernames are case-insensitively unique; shown as typed. */
export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const MIN_PASSWORD_CHARS = 8;
export const MAX_PASSWORD_CHARS = 200;

/** Per-list cap on published trade/wishlist lines. */
export const MAX_PUBLIC_LINES = 5_000;

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
  /** Row-sync feed state; absent on pre-sync servers. seq 0 = nothing synced yet. */
  sync?: {
    seq: number;
    /** Stored rows and row bytes, against SYNC_MAX_ROWS/BYTES_PER_USER. */
    usage?: { rows: number; bytes: number };
  };
}

/** One row on the Community screen. */
export interface PublicUser {
  username: string;
  /** When their lists last changed. */
  updatedAt: number;
  tradelistCount: number;
  wishlistCount: number;
  /** Their profile picture, when they've set one (see profile.ts). */
  avatar?: ProfileAvatar | null;
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

// ---------------------------------------------------------------------------
// Match notifications (GET /api/matches)
// ---------------------------------------------------------------------------
//
// Computed on demand from the published lists: for the signed-in user, every
// other user whose lists overlap theirs (either direction). Reveals nothing
// the Community screen doesn't already — it's a convenience view over data any
// signed-in user can already read. The client tracks seen/dismissed per user
// locally; `signature` lets it detect when a match's content has changed.

/** One matched card — oracleId drives highlighting, name drives display. */
export interface MatchCard {
  oracleId: string;
  name: string;
}

/** One matched user. At least one of the two arrays is non-empty. */
export interface MatchEntry {
  username: string;
  /** When their lists last changed. */
  updatedAt: number;
  /** Cards I have for trade that they want (on my tradelist ∩ their wishlist). */
  theyWant: MatchCard[];
  /** Cards they have for trade that I want (their tradelist ∩ my wishlist). */
  iWant: MatchCard[];
  /** Stable hash of this match's content; changes when the overlap changes. */
  signature: string;
}

export interface MatchesResponse {
  matches: MatchEntry[];
}

// ---------------------------------------------------------------------------
// Server price archive (GET /api/prices/:scryfallId)
// ---------------------------------------------------------------------------
//
// The server appends one reading per printing per day from the published card
// DB, so a fresh device gets full price charts instead of each device
// recording its own history from first sight. Same wire shape as the client's
// local PriceHistory rows (cents indexed by day) so the two merge trivially.
// Requires a signed-in user — this endpoint is where a future premium tier
// (e.g. history depth by plan) would be enforced; today everyone gets all of it.

export interface PricesResponse {
  scryfallId: string;
  /** YYYY-MM-DD (UTC) of index 0. */
  startDay: string;
  /** Integer cents per day; null = no reading that day. Same length as `usd`. */
  eur: (number | null)[];
  usd: (number | null)[];
}

/**
 * Error envelope for every non-2xx /api response. `error` is a stable code;
 * `message` is human-readable.
 */
export interface ApiErrorBody {
  error:
    | 'bad_request'
    | 'invalid_credentials'
    | 'invalid_invite'
    | 'username_taken'
    | 'unauthorized'
    | 'not_found'
    | 'rate_limited'
    | 'registration_closed'
    | 'too_large'
    | 'server_error';
  message: string;
}
