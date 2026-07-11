// Device-transfer protocol. Rides the same WebSocket relay as trades: the
// sending device creates a transfer session and shows a code; the receiving
// device joins with it. The payload (the full serialized user data) then flows
// sender → receiver as opaque string chunks — the server relays them and never
// stores or parses them, exactly like tradelist/wishlist shares.
//
// Flow control is ack-paced: the sender transmits chunk N+1 only after the
// receiver acknowledges chunk N, which keeps both sides inside the relay's
// per-socket rate limit. Integrity is a SHA-256 over the whole payload string,
// announced in transfer_begin and verified by the receiver after reassembly.

import type { PROTOCOL_VERSION } from './trade.js';

/**
 * Max characters per transfer_chunk `data` slice. Keeps every relayed frame
 * comfortably under the server's 1 MB WebSocket payload cap, with headroom for
 * JSON string escaping of the slice.
 */
export const TRANSFER_CHUNK_CHARS = 200_000;

/** Upper bound on chunks per transfer (caps a payload at ~30 MB of JSON). */
export const MAX_TRANSFER_CHUNKS = 150;

// ---------------------------------------------------------------------------
// Relayed frames (sent by a client, forwarded verbatim by the server, so they
// appear in both message unions below)
// ---------------------------------------------------------------------------

/** Sender → receiver: payload metadata, sent before the first chunk. */
export interface TransferBegin {
  v: typeof PROTOCOL_VERSION;
  type: 'transfer_begin';
  transferCode: string;
  totalChunks: number;
  totalChars: number;
  sha256: string;
}

/** Sender → receiver: one opaque payload slice. */
export interface TransferChunk {
  v: typeof PROTOCOL_VERSION;
  type: 'transfer_chunk';
  transferCode: string;
  seq: number;
  data: string;
}

/** Receiver → sender: flow control; the sender sends chunk seq+1 on ack of seq. */
export interface TransferAck {
  v: typeof PROTOCOL_VERSION;
  type: 'transfer_ack';
  transferCode: string;
  seq: number;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type TransferClientMessage =
  | { v: typeof PROTOCOL_VERSION; type: 'transfer_create' }
  | { v: typeof PROTOCOL_VERSION; type: 'transfer_join'; transferCode: string }
  | TransferBegin
  | TransferChunk
  | TransferAck
  | { v: typeof PROTOCOL_VERSION; type: 'transfer_cancel'; transferCode: string };

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export type TransferServerMessage =
  | { v: typeof PROTOCOL_VERSION; type: 'transfer_created'; transferCode: string }
  // To the joining receiver.
  | { v: typeof PROTOCOL_VERSION; type: 'transfer_joined'; transferCode: string }
  // To the waiting sender.
  | { v: typeof PROTOCOL_VERSION; type: 'transfer_peer_joined'; transferCode: string }
  | TransferBegin
  | TransferChunk
  | TransferAck
  // The other side cancelled or disconnected; the session is gone.
  | { v: typeof PROTOCOL_VERSION; type: 'transfer_cancelled'; transferCode: string };
