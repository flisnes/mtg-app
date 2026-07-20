import { randomUUID } from 'node:crypto';
import { sanitizeTradeLines, type Seat, type SessionSnapshot, type TradeLine, type TradeState } from '@mtg/shared';
import { CodeStore, TransitionError, type CodeEntry } from './codeStore.js';
import { config } from './config.js';

export { TransitionError };

// In-memory trade sessions (beta plan §7). The server is authoritative for
// STATE; it holds only the opaque offers, the state machine, and ephemeral
// resume tokens — no names, no persistence. Clients own their card data.

export interface Session extends CodeEntry {
  sessionId: string;
  state: TradeState;
  offers: Record<Seat, TradeLine[]>;
  accepted: Record<Seat, boolean>;
  confirmed: Record<Seat, boolean>;
  tokens: { a: string; b: string | null };
  present: Record<Seat, boolean>;
  /** Per-seat disconnect timers (beta plan §7 reconnect window). */
  graceTimers: Partial<Record<Seat, ReturnType<typeof setTimeout>>>;
}

const PRE_COMPLETE: TradeState[] = ['open', 'paired', 'building', 'one_accepted', 'agreed'];

export class SessionStore extends CodeStore<Session> {
  counters = { sessionsCreated: 0, sessionsCompleted: 0, sessionsCancelled: 0 };

  /** Invoked when a disconnect grace window lapses and the store cancels the trade itself. */
  onGraceExpired?: (session: Session) => void;

  constructor() {
    super({ maxPerIp: config.maxSessionsPerIp, ttlMs: config.sessionTtlMs });
  }

  create(ip: string): Session {
    const session = this.register(ip, (code) => ({
      code,
      ip,
      createdAt: Date.now(),
      sessionId: randomUUID(),
      state: 'open' as TradeState,
      offers: { a: [], b: [] },
      accepted: { a: false, b: false },
      confirmed: { a: false, b: false },
      tokens: { a: randomUUID(), b: null },
      present: { a: true, b: false },
      graceTimers: {},
    }));
    this.counters.sessionsCreated++;
    return session;
  }

  join(code: string): { session: Session; token: string } {
    const session = this.get(code);
    if (!session) throw new TransitionError('unknown_session');
    if (session.tokens.b) throw new TransitionError('session_full');
    session.tokens.b = randomUUID();
    session.present.b = true;
    session.state = 'paired';
    return { session, token: session.tokens.b };
  }

  /** Reattach a dropped participant. */
  resume(code: string, token: string): { session: Session; seat: Seat } {
    const session = this.get(code);
    if (!session) throw new TransitionError('unknown_session');
    const seat: Seat | null = session.tokens.a === token ? 'a' : session.tokens.b === token ? 'b' : null;
    if (!seat) throw new TransitionError('bad_resume');
    session.present[seat] = true;
    this.clearGrace(session, seat);
    return { session, seat };
  }

  /**
   * A participant dropped: give them the reconnect grace window to resume,
   * then cancel the trade (beta plan §7). The absolute TTL still applies.
   */
  armGrace(session: Session, seat: Seat): void {
    this.clearGrace(session, seat);
    if (!PRE_COMPLETE.includes(session.state)) return;
    session.graceTimers[seat] = setTimeout(() => {
      delete session.graceTimers[seat];
      if (session.present[seat] || !PRE_COMPLETE.includes(session.state)) return;
      this.cancel(session);
      this.onGraceExpired?.(session);
    }, config.reconnectGraceMs);
  }

  private clearGrace(session: Session, seat: Seat): void {
    const timer = session.graceTimers[seat];
    if (timer) {
      clearTimeout(timer);
      delete session.graceTimers[seat];
    }
  }

  /** `side` is the offer being edited — either participant may edit either side. */
  offerUpdate(session: Session, side: Seat, lines: unknown): void {
    this.assertState(session, ['paired', 'building', 'one_accepted', 'agreed']);
    if (!Array.isArray(lines)) throw new TransitionError('malformed', 'offer must be a list of lines');
    if (lines.length > config.maxOfferLines) throw new TransitionError('offer_too_large');
    // The peer is unauthenticated: store sanitized lines so a malformed offer
    // can't be persisted or rebroadcast (the receiving client re-sanitizes too).
    session.offers[side] = sanitizeTradeLines(lines, { maxQty: 999, maxLines: config.maxOfferLines });
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

  confirmComplete(session: Session, seat: Seat): void {
    this.assertState(session, ['agreed']);
    session.confirmed[seat] = true;
    if (session.confirmed.a && session.confirmed.b) {
      session.state = 'completed';
      this.counters.sessionsCompleted++;
      this.scheduleRemoval(session);
    }
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

  /** Drop a terminal session shortly after, giving clients time to apply mutations. */
  private scheduleRemoval(session: Session): void {
    setTimeout(() => this.remove(session.code), 30_000);
  }

  override remove(code: string): void {
    const session = this.get(code);
    if (session) {
      for (const seat of ['a', 'b'] as Seat[]) this.clearGrace(session, seat);
      // A still-live trade being removed means the absolute TTL lapsed (normal
      // completion/cancellation already set a terminal state before scheduling
      // removal). Transition to cancelled and tell whoever is still connected,
      // so clients don't sit on a session that only errors on the next action.
      if (PRE_COMPLETE.includes(session.state)) {
        session.state = 'cancelled';
        this.counters.sessionsCancelled++;
        this.onGraceExpired?.(session);
      }
    }
    super.remove(code);
  }
}
