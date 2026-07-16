// Trade session protocol (beta plan §7). JSON over WSS, versioned envelope.
//
// The server is authoritative for STATE; clients are authoritative for their own
// card data. The server holds only: code, both offers (opaque TradeLine[]),
// state, timestamps, and ephemeral resume tokens. No names, no persistence.
//
// "Both agree" (agreed) and "trade complete" (completed) are deliberately
// separate steps — the gap is the physical inspection window.

import type { TradeLine, WishLine } from './user.js';

export const PROTOCOL_VERSION = 1 as const;

/** Server-enforced state machine. cancel is legal from any pre-completed state. */
export type TradeState =
  | 'open' // created, waiting for a partner to join
  | 'paired' // both present, no offers yet
  | 'building' // offers being edited
  | 'one_accepted' // exactly one side has accepted
  | 'agreed' // both accepted; physical exchange happens now
  | 'completed'
  | 'cancelled';

/** Which participant a message/offer belongs to, from the server's view. */
export type Seat = 'a' | 'b';

/** Snapshot of the whole session the server broadcasts on any change. */
export interface SessionSnapshot {
  code: string;
  /** Stable unique id for this session; clients key idempotent completion on it. */
  sessionId: string;
  state: TradeState;
  /** Offers keyed by seat. Each client learns its own seat from `session_ready`. */
  offers: Record<Seat, TradeLine[]>;
  accepted: Record<Seat, boolean>;
  confirmed: Record<Seat, boolean>;
  /** Whether each seat currently has a live socket. */
  present: Record<Seat, boolean>;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { v: typeof PROTOCOL_VERSION; type: 'create_session' }
  | { v: typeof PROTOCOL_VERSION; type: 'join_session'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'resume'; sessionCode: string; resumeToken: string }
  | { v: typeof PROTOCOL_VERSION; type: 'offer_update'; sessionCode: string; lines: TradeLine[] }
  | { v: typeof PROTOCOL_VERSION; type: 'accept'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'unaccept'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'confirm_complete'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'cancel'; sessionCode: string }
  // Tradelist browsing: ask the partner for their tradelist / answer such a
  // request. Relayed peer-to-peer; the server never stores the lines.
  | { v: typeof PROTOCOL_VERSION; type: 'tradelist_request'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'tradelist_share'; sessionCode: string; lines: TradeLine[] }
  // Wishlist exchange, same relay mechanics — powers "you have what they want"
  // match highlighting. The wishlist is by definition shown to trade partners.
  | { v: typeof PROTOCOL_VERSION; type: 'wishlist_request'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'wishlist_share'; sessionCode: string; lines: WishLine[] }
  // Optional identity exchange: a signed-in participant shares their account
  // username so the completed trade can record who it was with. Pure relay;
  // anonymous trading just never sends this.
  | { v: typeof PROTOCOL_VERSION; type: 'identity_share'; sessionCode: string; username: string }
  // Account sync (sync plan): subscribe this socket to the signed-in user's
  // change feed. Session-independent — the same socket endpoint, no trade
  // session involved. The server answers with a sync_notify carrying the
  // current seq (a catch-up check), then pushes one on every later change.
  | { v: typeof PROTOCOL_VERSION; type: 'sync_sub'; token: string; clientId: string };

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'session_created';
      sessionCode: string;
      seat: Seat;
      resumeToken: string;
      snapshot: SessionSnapshot;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      type: 'session_ready';
      sessionCode: string;
      seat: Seat;
      resumeToken: string;
      snapshot: SessionSnapshot;
    }
  | { v: typeof PROTOCOL_VERSION; type: 'state_sync'; sessionCode: string; snapshot: SessionSnapshot }
  | { v: typeof PROTOCOL_VERSION; type: 'peer_disconnected'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'peer_reconnected'; sessionCode: string }
  // Relayed tradelist browsing / wishlist exchange (see ClientMessage above).
  | { v: typeof PROTOCOL_VERSION; type: 'tradelist_requested'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'tradelist_shared'; sessionCode: string; lines: TradeLine[] }
  | { v: typeof PROTOCOL_VERSION; type: 'wishlist_requested'; sessionCode: string }
  | { v: typeof PROTOCOL_VERSION; type: 'wishlist_shared'; sessionCode: string; lines: WishLine[] }
  | { v: typeof PROTOCOL_VERSION; type: 'identity_shared'; sessionCode: string; username: string }
  // Account sync: the user's data changed (another device pushed, or this is
  // the subscription ack). Pull via POST /api/sync when seq > local cursor.
  | { v: typeof PROTOCOL_VERSION; type: 'sync_notify'; seq: number }
  | { v: typeof PROTOCOL_VERSION; type: 'error'; code: TradeErrorCode; message: string };

export type TradeErrorCode =
  | 'unknown_session'
  | 'session_full'
  | 'bad_resume'
  | 'invalid_transition'
  | 'rate_limited'
  | 'offer_too_large'
  | 'protocol_version'
  | 'unauthorized'
  | 'malformed';

/** Length of a join code. Unambiguous alphabet (no 0/O/1/I). */
export const CODE_LENGTH = 6;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
