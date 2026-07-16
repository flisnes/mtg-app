import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@mtg/shared';

// Live-push half of account sync: sockets subscribe (relay.ts `sync_sub`,
// token-authenticated) and the /api/sync route notifies here after applying a
// push, so the user's OTHER devices pull within seconds. Notifications carry
// only the new seq — data always travels over the authenticated HTTP sync
// endpoint, never the socket.

export class SyncHub {
  /** userId → socket → clientId (to skip echoing at the pushing device). */
  private subs = new Map<number, Map<WebSocket, string>>();

  subscribe(userId: number, clientId: string, socket: WebSocket): void {
    let sockets = this.subs.get(userId);
    if (!sockets) {
      sockets = new Map();
      this.subs.set(userId, sockets);
    }
    sockets.set(socket, clientId);
  }

  /** Idempotent; call on every socket close. */
  unsubscribe(socket: WebSocket): void {
    for (const [userId, sockets] of this.subs) {
      if (sockets.delete(socket) && sockets.size === 0) this.subs.delete(userId);
    }
  }

  notify(userId: number, seq: number, originClientId?: string): void {
    const sockets = this.subs.get(userId);
    if (!sockets) return;
    const msg = JSON.stringify({ v: PROTOCOL_VERSION, type: 'sync_notify', seq });
    for (const [socket, clientId] of sockets) {
      if (originClientId && clientId === originClientId) continue;
      if (socket.readyState === socket.OPEN) socket.send(msg);
    }
  }
}
