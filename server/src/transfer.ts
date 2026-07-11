import type { WebSocket } from 'ws';
import { CodeStore, TransitionError, type CodeEntry } from './codeStore.js';
import { config } from './config.js';

// In-memory device-transfer sessions (shared/src/transfer.ts). Even more
// minimal than trades: the server holds only the code and the two live
// sockets — the payload chunks are relayed, never stored. No resume: a
// dropped socket cancels the transfer and the user starts over.

export interface TransferSession extends CodeEntry {
  sender: WebSocket;
  receiver: WebSocket | null;
}

export class TransferStore extends CodeStore<TransferSession> {
  counters = { transfersCreated: 0 };

  constructor() {
    super({ maxPerIp: config.maxSessionsPerIp, ttlMs: config.transferTtlMs });
  }

  create(ip: string, sender: WebSocket): TransferSession {
    const session = this.register(ip, (code) => ({
      code,
      ip,
      createdAt: Date.now(),
      sender,
      receiver: null,
    }));
    this.counters.transfersCreated++;
    return session;
  }

  join(code: string, receiver: WebSocket): TransferSession {
    const session = this.get(code);
    if (!session) throw new TransitionError('unknown_session');
    if (session.receiver) throw new TransitionError('session_full');
    session.receiver = receiver;
    return session;
  }
}
