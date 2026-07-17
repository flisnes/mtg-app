import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  MAX_TRANSFER_CHUNKS,
  PROTOCOL_VERSION,
  TRANSFER_CHUNK_CHARS,
  type ClientMessage,
  type Seat,
  type ServerMessage,
  type TradeErrorCode,
  type TransferClientMessage,
  type TransferServerMessage,
} from '@mtg/shared';
import { config } from './config.js';
import type { AccountStore } from './accountStore.js';
import { SessionStore, TransitionError, type Session } from './session.js';
import type { SyncHub } from './syncHub.js';
import { TransferStore } from './transfer.js';

// WebSocket trade relay (beta plan §7). Server-authoritative state machine over
// an in-memory session store; clients own their card data. No persistence, no
// names — only aggregate counters are logged. The same socket endpoint also
// carries device transfers (transfer_* messages): pure peer relay of opaque
// payload chunks, handled by handleTransfer below.

const store = new SessionStore();
const transfers = new TransferStore();

// seat -> socket, per session code, for broadcasts.
const sockets = new Map<string, Partial<Record<Seat, WebSocket>>>();

// The stores own session lifetime (TTL, grace expiry, explicit removal); hook
// their removals so socket-map entries can't outlive their session, peers hear
// about a transfer ending however it ends, and a lapsed reconnect window
// pushes the cancelled state to whoever is still connected.
store.onRemove = (session) => sockets.delete(session.code);
store.onGraceExpired = (session) => broadcast(session);
transfers.onRemove = (t) => {
  for (const s of [t.sender, t.receiver]) {
    if (s) send(s, { v: PROTOCOL_VERSION, type: 'transfer_cancelled', transferCode: t.code });
  }
};

interface SocketCtx {
  code?: string;
  seat?: Seat;
  transferCode?: string;
  transferRole?: 'sender' | 'receiver';
  ip: string;
  tokens: number; // rate-limit bucket
  last: number;
}

function send(socket: WebSocket, msg: ServerMessage | TransferServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function sendError(socket: WebSocket, code: TradeErrorCode, message: string): void {
  send(socket, { v: PROTOCOL_VERSION, type: 'error', code, message });
}

function broadcast(session: Session): void {
  const snap = store.snapshot(session);
  const bySeat = sockets.get(session.code);
  (['a', 'b'] as Seat[]).forEach((seat) => {
    const s = bySeat?.[seat];
    if (s) send(s, { v: PROTOCOL_VERSION, type: 'state_sync', sessionCode: session.code, snapshot: snap });
  });
}

function notifyPeer(session: Session, seat: Seat, type: 'peer_disconnected' | 'peer_reconnected'): void {
  const peer: Seat = seat === 'a' ? 'b' : 'a';
  const s = sockets.get(session.code)?.[peer];
  if (s) send(s, { v: PROTOCOL_VERSION, type, sessionCode: session.code });
}

/** Send a state_sync to a single seat (used when the other seat already has the snapshot). */
function sendStateTo(session: Session, seat: Seat): void {
  const s = sockets.get(session.code)?.[seat];
  if (s) send(s, { v: PROTOCOL_VERSION, type: 'state_sync', sessionCode: session.code, snapshot: store.snapshot(session) });
}

function attach(code: string, seat: Seat, socket: WebSocket): void {
  const entry = sockets.get(code) ?? {};
  entry[seat] = socket;
  sockets.set(code, entry);
}

/** Token-bucket rate limit per socket. Returns false if over budget. */
function allow(ctx: SocketCtx, now: number): boolean {
  const elapsed = (now - ctx.last) / 1000;
  ctx.last = now;
  ctx.tokens = Math.min(config.maxMessagesPerSec, ctx.tokens + elapsed * config.maxMessagesPerSec);
  if (ctx.tokens < 1) return false;
  ctx.tokens -= 1;
  return true;
}

export function registerTradeRelay(app: FastifyInstance, accounts: AccountStore, hub: SyncHub): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    // Cross-site WebSocket hijacking guard: browsers always send Origin on WS
    // handshakes, so an allowlist (when configured) shuts out foreign pages.
    if (config.allowedOrigins.length > 0) {
      const origin = req.headers.origin;
      if (!origin || !config.allowedOrigins.includes(origin)) {
        socket.close(1008, 'origin not allowed');
        return;
      }
    }

    const ctx: SocketCtx = { ip: req.ip, tokens: config.maxMessagesPerSec, last: Date.now() };

    // Heartbeat: ping every 30s; terminate a socket that misses a pong. Keeps
    // NAT/proxy paths alive during the physical-inspection window and reaps
    // half-dead sockets (browsers answer pings automatically).
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, 30_000);

    socket.on('message', (raw: Buffer) => {
      const now = Date.now();
      if (!allow(ctx, now)) return sendError(socket, 'rate_limited', 'slow down');

      let msg: ClientMessage | TransferClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError(socket, 'malformed', 'invalid JSON');
      }
      if (msg.v !== PROTOCOL_VERSION) {
        return sendError(socket, 'protocol_version', `expected protocol v${PROTOCOL_VERSION}`);
      }

      try {
        if (isTransferMessage(msg)) handleTransfer(socket, ctx, msg);
        else handle(socket, ctx, msg, accounts, hub);
      } catch (err) {
        if (err instanceof TransitionError) sendError(socket, err.code, err.message);
        else {
          app.log.error(err);
          sendError(socket, 'malformed', 'server error');
        }
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      hub.unsubscribe(socket);
      // A dropped socket cancels its transfer (no resume for transfers); the
      // store's onRemove hook notifies whichever peer is still connected.
      if (ctx.transferCode) transfers.remove(ctx.transferCode);
      if (!ctx.code || !ctx.seat) return;
      const session = store.get(ctx.code);
      const bySeat = sockets.get(ctx.code);
      if (bySeat && bySeat[ctx.seat] === socket) delete bySeat[ctx.seat];
      if (session) {
        session.present[ctx.seat] = false;
        notifyPeer(session, ctx.seat, 'peer_disconnected');
        // Beta plan §7 reconnect window: the dropped seat has a grace period
        // to resume before the trade is cancelled (absolute TTL still applies).
        store.armGrace(session, ctx.seat);
      }
    });
  });

  app.get('/metrics', async () => ({ ...store.counters, ...transfers.counters }));
}

function isTransferMessage(msg: ClientMessage | TransferClientMessage): msg is TransferClientMessage {
  return msg.type.startsWith('transfer_');
}

// Device transfers are pure peer relay: no state machine, nothing stored. The
// server validates only frame shape/size; payload integrity (SHA-256) and
// content sanitization are the receiving client's job.
function handleTransfer(socket: WebSocket, ctx: SocketCtx, msg: TransferClientMessage): void {
  switch (msg.type) {
    case 'transfer_create': {
      const t = transfers.create(ctx.ip, socket);
      ctx.transferCode = t.code;
      ctx.transferRole = 'sender';
      send(socket, { v: PROTOCOL_VERSION, type: 'transfer_created', transferCode: t.code });
      return;
    }

    case 'transfer_join': {
      const t = transfers.join(String(msg.transferCode).trim().toUpperCase(), socket);
      ctx.transferCode = t.code;
      ctx.transferRole = 'receiver';
      send(socket, { v: PROTOCOL_VERSION, type: 'transfer_joined', transferCode: t.code });
      send(t.sender, { v: PROTOCOL_VERSION, type: 'transfer_peer_joined', transferCode: t.code });
      return;
    }

    default: {
      const t = transfers.get(msg.transferCode);
      if (!t || ctx.transferCode !== msg.transferCode || !ctx.transferRole) {
        return sendError(socket, 'unknown_session', 'not joined to this transfer');
      }
      const peer = ctx.transferRole === 'sender' ? t.receiver : t.sender;

      switch (msg.type) {
        case 'transfer_begin': {
          if (
            ctx.transferRole !== 'sender' ||
            !Number.isInteger(msg.totalChunks) ||
            msg.totalChunks < 1 ||
            msg.totalChunks > MAX_TRANSFER_CHUNKS ||
            !Number.isInteger(msg.totalChars) ||
            msg.totalChars < 0 ||
            typeof msg.sha256 !== 'string' ||
            !/^[0-9a-f]{64}$/.test(msg.sha256)
          ) {
            return sendError(socket, 'malformed', 'bad transfer_begin');
          }
          if (peer) {
            send(peer, {
              v: PROTOCOL_VERSION,
              type: 'transfer_begin',
              transferCode: t.code,
              totalChunks: msg.totalChunks,
              totalChars: msg.totalChars,
              sha256: msg.sha256,
            });
          }
          return;
        }

        case 'transfer_chunk': {
          if (ctx.transferRole !== 'sender' || !Number.isInteger(msg.seq) || msg.seq < 0) {
            return sendError(socket, 'malformed', 'bad transfer_chunk');
          }
          if (typeof msg.data !== 'string' || msg.data.length > TRANSFER_CHUNK_CHARS) {
            return sendError(socket, 'offer_too_large', `chunk exceeds ${TRANSFER_CHUNK_CHARS} chars`);
          }
          if (peer) {
            send(peer, { v: PROTOCOL_VERSION, type: 'transfer_chunk', transferCode: t.code, seq: msg.seq, data: msg.data });
          }
          return;
        }

        case 'transfer_ack': {
          if (ctx.transferRole !== 'receiver' || !Number.isInteger(msg.seq) || msg.seq < 0) {
            return sendError(socket, 'malformed', 'bad transfer_ack');
          }
          if (peer) send(peer, { v: PROTOCOL_VERSION, type: 'transfer_ack', transferCode: t.code, seq: msg.seq });
          return;
        }

        case 'transfer_cancel': {
          // The store's onRemove hook sends transfer_cancelled to both sides.
          transfers.remove(t.code);
          ctx.transferCode = undefined;
          ctx.transferRole = undefined;
          return;
        }
      }
    }
  }
}

function handle(
  socket: WebSocket,
  ctx: SocketCtx,
  msg: ClientMessage,
  accounts: AccountStore,
  hub: SyncHub,
): void {
  switch (msg.type) {
    // Account sync live-push subscription. Session-independent: the same
    // socket may also run a trade. Token-authenticated against the account
    // store; the ack doubles as a catch-up check (current seq).
    case 'sync_sub': {
      const user = typeof msg.token === 'string' ? accounts.userForToken(msg.token) : null;
      if (!user) return sendError(socket, 'unauthorized', 'sign in again');
      const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : '';
      hub.subscribe(user.id, clientId, socket);
      send(socket, { v: PROTOCOL_VERSION, type: 'sync_notify', seq: accounts.syncSeq(user.id) });
      return;
    }

    case 'create_session': {
      const session = store.create(ctx.ip);
      ctx.code = session.code;
      ctx.seat = 'a';
      attach(session.code, 'a', socket);
      send(socket, {
        v: PROTOCOL_VERSION,
        type: 'session_created',
        sessionCode: session.code,
        seat: 'a',
        resumeToken: session.tokens.a,
        snapshot: store.snapshot(session),
      });
      return;
    }

    case 'join_session': {
      const { session, token } = store.join(msg.sessionCode);
      ctx.code = session.code;
      ctx.seat = 'b';
      attach(session.code, 'b', socket);
      send(socket, {
        v: PROTOCOL_VERSION,
        type: 'session_ready',
        sessionCode: session.code,
        seat: 'b',
        resumeToken: token,
        snapshot: store.snapshot(session),
      });
      sendStateTo(session, 'a'); // initiator learns it's paired (joiner already has the snapshot)
      return;
    }

    case 'resume': {
      const { session, seat } = store.resume(msg.sessionCode, msg.resumeToken);
      ctx.code = session.code;
      ctx.seat = seat;
      attach(session.code, seat, socket);
      send(socket, { v: PROTOCOL_VERSION, type: 'state_sync', sessionCode: session.code, snapshot: store.snapshot(session) });
      notifyPeer(session, seat, 'peer_reconnected');
      return;
    }

    default: {
      // All remaining messages act on the socket's bound session/seat.
      const session = requireSession(socket, ctx, msg.sessionCode);
      if (!session || !ctx.seat) return;
      const seat = ctx.seat;

      // Tradelist browsing and wishlist exchange are pure peer relay — no
      // state-machine involvement, nothing stored. Same line cap as offers.
      if (msg.type === 'tradelist_request' || msg.type === 'wishlist_request') {
        const peerSocket = sockets.get(session.code)?.[seat === 'a' ? 'b' : 'a'];
        if (!peerSocket) return;
        const requested = msg.type === 'tradelist_request' ? 'tradelist_requested' : 'wishlist_requested';
        send(peerSocket, { v: PROTOCOL_VERSION, type: requested, sessionCode: session.code });
        return;
      }
      if (msg.type === 'tradelist_share' || msg.type === 'wishlist_share') {
        const peerSocket = sockets.get(session.code)?.[seat === 'a' ? 'b' : 'a'];
        if (!peerSocket) return;
        if (!Array.isArray(msg.lines) || msg.lines.length > config.maxOfferLines) {
          return sendError(socket, 'offer_too_large', `list exceeds ${config.maxOfferLines} lines`);
        }
        if (msg.type === 'tradelist_share') {
          send(peerSocket, { v: PROTOCOL_VERSION, type: 'tradelist_shared', sessionCode: session.code, lines: msg.lines });
        } else {
          send(peerSocket, { v: PROTOCOL_VERSION, type: 'wishlist_shared', sessionCode: session.code, lines: msg.lines });
        }
        return;
      }
      // Identity exchange: pure relay, like list sharing. Bounded, not verified
      // — the receiving client re-validates against the username format.
      if (msg.type === 'identity_share') {
        const peerSocket = sockets.get(session.code)?.[seat === 'a' ? 'b' : 'a'];
        if (!peerSocket) return;
        if (typeof msg.username !== 'string' || msg.username.length > 20) {
          return sendError(socket, 'malformed', 'bad identity_share');
        }
        send(peerSocket, { v: PROTOCOL_VERSION, type: 'identity_shared', sessionCode: session.code, username: msg.username });
        return;
      }

      switch (msg.type) {
        case 'offer_update':
          // Either participant may edit either side; default to the sender's
          // own seat for clients that predate cross-side editing.
          store.offerUpdate(session, msg.side === 'a' || msg.side === 'b' ? msg.side : seat, msg.lines);
          break;
        case 'accept':
          store.accept(session, seat);
          break;
        case 'unaccept':
          store.unaccept(session, seat);
          break;
        case 'confirm_complete':
          store.confirmComplete(session, seat);
          break;
        case 'cancel':
          store.cancel(session);
          break;
      }
      broadcast(session);
    }
  }
}

function requireSession(socket: WebSocket, ctx: SocketCtx, code: string): Session | undefined {
  if (!ctx.code || ctx.code !== code) {
    sendError(socket, 'unknown_session', 'not joined to this session');
    return undefined;
  }
  const session = store.get(code);
  if (!session) {
    sendError(socket, 'unknown_session', 'session expired');
    return undefined;
  }
  return session;
}
