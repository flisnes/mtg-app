import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@mtg/shared';

// Aggregate counters only — never any card data or identifiers (beta plan §7).
const counters = {
  sessionsCreated: 0,
  sessionsCompleted: 0,
  sessionsCancelled: 0,
};

function send(socket: WebSocket, msg: ServerMessage): void {
  socket.send(JSON.stringify(msg));
}

/**
 * WebSocket trade relay. Phase 0 stub: accepts connections at /ws, parses the
 * versioned envelope, and rejects with a clear error. The full in-memory
 * session state machine (create/join/offer/accept/confirm/cancel + reconnect)
 * lands in Phase 4 — this file is where a SessionStore will live.
 */
export function registerTradeRelay(app: FastifyInstance): void {
  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(socket, { v: PROTOCOL_VERSION, type: 'error', code: 'malformed', message: 'invalid JSON' });
        return;
      }

      if (msg.v !== PROTOCOL_VERSION) {
        send(socket, {
          v: PROTOCOL_VERSION,
          type: 'error',
          code: 'protocol_version',
          message: `expected protocol v${PROTOCOL_VERSION}`,
        });
        return;
      }

      // Phase 4 replaces this with the real state machine.
      send(socket, {
        v: PROTOCOL_VERSION,
        type: 'error',
        code: 'invalid_transition',
        message: 'trade relay not yet implemented (Phase 4)',
      });
    });
  });

  app.get('/metrics', async () => counters);
}

export { counters };
