import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Seat,
  type ServerMessage,
  type TradeErrorCode,
} from '@mtg/shared';
import { config } from './config.js';
import { SessionStore, TransitionError, type Session } from './session.js';

// WebSocket trade relay (beta plan §7). Server-authoritative state machine over
// an in-memory session store; clients own their card data. No persistence, no
// names — only aggregate counters are logged.

const store = new SessionStore();

interface SocketCtx {
  code?: string;
  seat?: Seat;
  ip: string;
  tokens: number; // rate-limit bucket
  last: number;
}

// seat -> socket, per session code, for broadcasts.
const sockets = new Map<string, Partial<Record<Seat, WebSocket>>>();

function send(socket: WebSocket, msg: ServerMessage): void {
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

export function registerTradeRelay(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const ctx: SocketCtx = { ip: req.ip, tokens: config.maxMessagesPerSec, last: Date.now() };

    socket.on('message', (raw: Buffer) => {
      const now = Date.now();
      if (!allow(ctx, now)) return sendError(socket, 'rate_limited', 'slow down');

      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError(socket, 'malformed', 'invalid JSON');
      }
      if (msg.v !== PROTOCOL_VERSION) {
        return sendError(socket, 'protocol_version', `expected protocol v${PROTOCOL_VERSION}`);
      }

      try {
        handle(socket, ctx, msg);
      } catch (err) {
        if (err instanceof TransitionError) sendError(socket, err.code, err.message);
        else {
          app.log.error(err);
          sendError(socket, 'malformed', 'server error');
        }
      }
    });

    socket.on('close', () => {
      if (!ctx.code || !ctx.seat) return;
      const session = store.get(ctx.code);
      const bySeat = sockets.get(ctx.code);
      if (bySeat && bySeat[ctx.seat] === socket) delete bySeat[ctx.seat];
      if (session) {
        session.present[ctx.seat] = false;
        notifyPeer(session, ctx.seat, 'peer_disconnected');
        // Session survives for resume within its TTL (beta plan §7 reconnect window).
      }
    });
  });

  app.get('/metrics', async () => store.counters);
}

function handle(socket: WebSocket, ctx: SocketCtx, msg: ClientMessage): void {
  switch (msg.type) {
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
      switch (msg.type) {
        case 'offer_update':
          store.offerUpdate(session, seat, msg.lines);
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
