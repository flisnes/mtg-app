import { randomInt, randomUUID } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  type Seat,
  type SessionSnapshot,
  type TradeErrorCode,
  type TradeLine,
  type TradeState,
} from '@mtg/shared';
import { config } from './config.js';

// In-memory trade sessions (beta plan §7). The server is authoritative for
// STATE; it holds only the opaque offers, the state machine, and ephemeral
// resume tokens — no names, no persistence. Clients own their card data.

export interface Session {
  code: string;
  sessionId: string;
  state: TradeState;
  offers: Record<Seat, TradeLine[]>;
  accepted: Record<Seat, boolean>;
  confirmed: Record<Seat, boolean>;
  tokens: { a: string; b: string | null };
  present: Record<Seat, boolean>;
  ip: string;
  createdAt: number;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

export class TransitionError extends Error {
  constructor(public code: TradeErrorCode, message?: string) {
    super(message ?? code);
  }
}

const PRE_COMPLETE: TradeState[] = ['open', 'paired', 'building', 'one_accepted', 'agreed'];

export class SessionStore {
  private sessions = new Map<string, Session>();
  private ipCounts = new Map<string, number>();

  counters = { sessionsCreated: 0, sessionsCompleted: 0, sessionsCancelled: 0 };

  get(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  private genCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.sessions.has(code)) return code;
    }
    throw new TransitionError('rate_limited', 'could not allocate a code');
  }

  create(ip: string): Session {
    const count = this.ipCounts.get(ip) ?? 0;
    if (count >= config.maxSessionsPerIp) throw new TransitionError('rate_limited', 'too many sessions');

    const session: Session = {
      code: this.genCode(),
      sessionId: randomUUID(),
      state: 'open',
      offers: { a: [], b: [] },
      accepted: { a: false, b: false },
      confirmed: { a: false, b: false },
      tokens: { a: randomUUID(), b: null },
      present: { a: true, b: false },
      ip,
      createdAt: Date.now(),
    };
    this.sessions.set(session.code, session);
    this.ipCounts.set(ip, count + 1);
    this.counters.sessionsCreated++;
    this.armTtl(session);
    return session;
  }

  join(code: string): { session: Session; token: string } {
    const session = this.sessions.get(code);
    if (!session) throw new TransitionError('unknown_session');
    if (session.tokens.b) throw new TransitionError('session_full');
    session.tokens.b = randomUUID();
    session.present.b = true;
    session.state = 'paired';
    return { session, token: session.tokens.b };
  }

  /** Reattach a dropped participant. */
  resume(code: string, token: string): { session: Session; seat: Seat } {
    const session = this.sessions.get(code);
    if (!session) throw new TransitionError('unknown_session');
    const seat: Seat | null = session.tokens.a === token ? 'a' : session.tokens.b === token ? 'b' : null;
    if (!seat) throw new TransitionError('bad_resume');
    session.present[seat] = true;
    return { session, seat };
  }

  offerUpdate(session: Session, seat: Seat, lines: TradeLine[]): void {
    this.assertState(session, ['paired', 'building', 'one_accepted', 'agreed']);
    if (lines.length > config.maxOfferLines) throw new TransitionError('offer_too_large');
    session.offers[seat] = lines;
    // Any edit clears both sides' agreements (beta plan §7).
    session.accepted = { a: false, b: false };
    session.confirmed = { a: false, b: false };
    session.state = 'building';
  }

  accept(session: Session, seat: Seat): void {
    this.assertState(session, ['paired', 'building', 'one_accepted']);
    session.accepted[seat] = true;
    session.state = session.accepted.a && session.accepted.b ? 'agreed' : 'one_accepted';
  }

  unaccept(session: Session, seat: Seat): void {
    this.assertState(session, ['one_accepted', 'agreed']);
    session.accepted[seat] = false;
    session.confirmed = { a: false, b: false };
    session.state = session.accepted.a || session.accepted.b ? 'one_accepted' : 'building';
  }

  confirmComplete(session: Session, seat: Seat): 'completed' | 'agreed' {
    this.assertState(session, ['agreed']);
    session.confirmed[seat] = true;
    if (session.confirmed.a && session.confirmed.b) {
      session.state = 'completed';
      this.counters.sessionsCompleted++;
      this.scheduleRemoval(session);
      return 'completed';
    }
    return 'agreed';
  }

  cancel(session: Session): void {
    if (!PRE_COMPLETE.includes(session.state)) throw new TransitionError('invalid_transition');
    session.state = 'cancelled';
    this.counters.sessionsCancelled++;
    this.scheduleRemoval(session);
  }

  snapshot(session: Session): SessionSnapshot {
    return {
      code: session.code,
      sessionId: session.sessionId,
      state: session.state,
      offers: { a: session.offers.a, b: session.offers.b },
      accepted: { a: session.accepted.a, b: session.accepted.b },
      confirmed: { a: session.confirmed.a, b: session.confirmed.b },
      present: { a: session.present.a, b: session.present.b },
    };
  }

  private assertState(session: Session, allowed: TradeState[]): void {
    if (!allowed.includes(session.state)) throw new TransitionError('invalid_transition', `not allowed in ${session.state}`);
  }

  private armTtl(session: Session): void {
    session.ttlTimer = setTimeout(() => this.remove(session.code), config.sessionTtlMs);
  }

  /** Drop a terminal session shortly after, giving clients time to apply mutations. */
  private scheduleRemoval(session: Session): void {
    setTimeout(() => this.remove(session.code), 30_000);
  }

  remove(code: string): void {
    const session = this.sessions.get(code);
    if (!session) return;
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
    this.sessions.delete(code);
    const count = (this.ipCounts.get(session.ip) ?? 1) - 1;
    if (count <= 0) this.ipCounts.delete(session.ip);
    else this.ipCounts.set(session.ip, count);
  }
}
