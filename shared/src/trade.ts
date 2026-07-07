// Trade session protocol (beta plan §7). JSON over WSS, versioned envelope.
//
// The server is authoritative for STATE; clients are authoritative for their own
// card data. The server holds only: code, both offers (opaque TradeLine[]),
// state, timestamps, and ephemeral resume tokens. No names, no persistence.
//
// "Both agree" (agreed) and "trade complete" (completed) are deliberately
// separate steps — the gap is the physical inspection window.

import type { TradeLine } from './user.js';

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
  | { v: typeof PROTOCOL_VERSION; type: 'cancel'; sessionCode: string };

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
  | { v: typeof PROTOCOL_VERSION; type: 'error'; code: TradeErrorCode; message: string };

export type TradeErrorCode =
  | 'unknown_session'
  | 'session_full'
  | 'bad_resume'
  | 'invalid_transition'
  | 'rate_limited'
  | 'offer_too_large'
  | 'protocol_version'
  | 'malformed';

/** Length of a join code. Unambiguous alphabet (no 0/O/1/I). */
export const CODE_LENGTH = 6;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
