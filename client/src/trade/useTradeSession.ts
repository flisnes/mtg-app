import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROTOCOL_VERSION,
  USERNAME_RE,
  type ClientMessage,
  type Seat,
  type ServerMessage,
  type SessionSnapshot,
  type TradeLine,
  type TradeState,
  type WishLine,
} from '@mtg/shared';
import { getAccountSession } from '../account/session.js';
import { applyCompletedTrade } from '../db/dataAccess.js';
import { readOwnTradelist, readOwnWishlist } from '../db/ownLists.js';
import { deleteSetting, getSetting, setSetting } from '../db/settings.js';
import { TRADE_WS_URL } from './config.js';
import { sanitizeOffer, sanitizeWishlist } from './validate.js';

// Client trade transport (beta plan §7). Owns the WebSocket, mirrors the
// server-authoritative snapshot, applies the completion mutation idempotently,
// and persists the in-flight session so an app reload can resume.

const ACTIVE_KEY = 'activeTrade';

export interface ActiveTrade {
  code: string;
  resumeToken: string;
  seat: Seat;
  sessionId: string;
}

export type TradeStatus = 'idle' | 'connecting' | 'active' | 'error';

export interface TradeSession {
  status: TradeStatus;
  seat: Seat | null;
  snapshot: SessionSnapshot | null;
  peerPresent: boolean;
  error: string | null;
  /** Partner's tradelist, if they've answered a request. null = never asked/answered. */
  peerTradelist: TradeLine[] | null;
  /** True while a tradelist request is in flight. */
  peerTradelistLoading: boolean;
  /** Partner's wishlist (for match highlighting). null = never asked/answered. */
  peerWishlist: WishLine[] | null;
  create: () => void;
  join: (code: string) => void;
  resume: (t: ActiveTrade) => void;
  /** Replace one side's offer — either participant may edit either side. */
  sendOffer: (side: Seat, lines: TradeLine[]) => void;
  requestTradelist: () => void;
  requestWishlist: () => void;
  accept: () => void;
  unaccept: () => void;
  confirmComplete: () => void;
  cancel: () => void;
  reset: () => void;
}

/** The relay caps shared lists at 500 lines (server maxOfferLines). */
const SHARE_LINE_CAP = 500;

/** Auto-resume backoff after a mid-trade drop: 1.2s, 2.4s, … capped, then give up. */
const RECONNECT_BASE_MS = 1200;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 6;

export function otherSeat(seat: Seat): Seat {
  return seat === 'a' ? 'b' : 'a';
}

/** Read any persisted in-flight trade (for the resume prompt). */
export async function getPersistedTrade(): Promise<ActiveTrade | undefined> {
  return getSetting<ActiveTrade>(ACTIVE_KEY);
}

/** Forget the persisted in-flight trade (the resume prompt's "Discard"). */
export async function clearPersistedTrade(): Promise<void> {
  await deleteSetting(ACTIVE_KEY);
}

export function useTradeSession(): TradeSession {
  const [status, setStatus] = useState<TradeStatus>('idle');
  const [seat, setSeat] = useState<Seat | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [peerPresent, setPeerPresent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerTradelist, setPeerTradelist] = useState<TradeLine[] | null>(null);
  const [peerTradelistLoading, setPeerTradelistLoading] = useState(false);
  const [peerWishlist, setPeerWishlist] = useState<WishLine[] | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const active = useRef<Partial<ActiveTrade>>({});
  const appliedRef = useRef(false);
  const intentionalClose = useRef(false);
  // Pending auto-resume timer (stored so reset/unmount/reconnect can cancel it —
  // a fire-and-forget timer would revive a torn-down session) + attempt counter.
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  // Identity exchange: the partner's username (if they shared one) ends up on
  // the completed Trade record; anonymous sessions leave it null.
  const peerUsername = useRef<string | null>(null);
  const sentIdentity = useRef(false);
  // Mirrors snapshot.state for the socket's onclose handler: the closure there
  // is created before any snapshot arrives, so reading the state prop directly
  // would always see null and auto-resume would never fire.
  const stateRef = useRef<TradeState | null>(null);

  const persist = useCallback(async () => {
    const a = active.current;
    if (a.code && a.resumeToken && a.seat && a.sessionId) {
      await setSetting(ACTIVE_KEY, a as ActiveTrade);
    }
  }, []);

  const clearPersisted = useCallback(async () => {
    await clearPersistedTrade();
  }, []);

  /** Share our account username with the partner (no-op when signed out). */
  const sendIdentity = useCallback(() => {
    if (sentIdentity.current) return;
    void getAccountSession().then((session) => {
      const c = active.current.code;
      const s = ws.current;
      // Latch only after a successful send — if the socket closed (or no code
      // yet) while we awaited the session, a premature latch would mean our
      // identity is never shared for the rest of the trade.
      if (session && c && s && s.readyState === WebSocket.OPEN) {
        sentIdentity.current = true;
        s.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'identity_share', sessionCode: c, username: session.username }));
      }
    });
  }, []);

  const handleSnapshot = useCallback(
    (raw: SessionSnapshot, mySeat: Seat) => {
      // The peer is untrusted — sanitize both offers before anything uses them.
      const snap: SessionSnapshot = {
        ...raw,
        offers: { a: sanitizeOffer(raw.offers?.a), b: sanitizeOffer(raw.offers?.b) },
      };
      stateRef.current = snap.state;
      setSnapshot(snap);
      const present = snap.present[otherSeat(mySeat)];
      setPeerPresent(present);
      if (present) sendIdentity();
      if (snap.state === 'completed' && !appliedRef.current) {
        appliedRef.current = true;
        const given = snap.offers[mySeat];
        const received = snap.offers[otherSeat(mySeat)];
        void applyCompletedTrade(snap.sessionId, given, received, peerUsername.current).finally(
          () => void clearPersisted(),
        );
      }
      if (snap.state === 'cancelled') void clearPersisted();
    },
    [clearPersisted, sendIdentity],
  );

  const onMessage = useCallback(
    (raw: string) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'session_created':
        case 'session_ready': {
          active.current = {
            code: msg.sessionCode,
            resumeToken: msg.resumeToken,
            seat: msg.seat,
            sessionId: msg.snapshot.sessionId,
          };
          appliedRef.current = false;
          setSeat(msg.seat);
          setStatus('active');
          setError(null);
          handleSnapshot(msg.snapshot, msg.seat);
          void persist();
          break;
        }
        case 'state_sync': {
          if (active.current.seat) handleSnapshot(msg.snapshot, active.current.seat);
          setStatus('active');
          break;
        }
        case 'peer_disconnected':
          setPeerPresent(false);
          break;
        case 'peer_reconnected':
          setPeerPresent(true);
          // The peer may have missed our identity while away — resend.
          sentIdentity.current = false;
          sendIdentity();
          break;
        case 'identity_shared':
          if (typeof msg.username === 'string' && USERNAME_RE.test(msg.username)) {
            peerUsername.current = msg.username;
          }
          sendIdentity(); // mutual: answer with ours if we haven't yet
          break;
        case 'tradelist_requested': {
          // Partner asked to browse our tradelist — answer with a snapshot.
          // The tradelist is by definition the "shown to trade partners" list.
          const c = active.current.code;
          void readOwnTradelist(SHARE_LINE_CAP).then((lines) => {
            const s = ws.current;
            if (c && s && s.readyState === WebSocket.OPEN) {
              s.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'tradelist_share', sessionCode: c, lines }));
            }
          });
          break;
        }
        case 'tradelist_shared':
          setPeerTradelist(sanitizeOffer(msg.lines));
          setPeerTradelistLoading(false);
          break;
        case 'wishlist_requested': {
          // Partner wants match highlighting — answer with a wishlist snapshot.
          // The wishlist is by definition surfaced to trade partners.
          const c = active.current.code;
          void readOwnWishlist(SHARE_LINE_CAP).then((lines) => {
            const s = ws.current;
            if (c && s && s.readyState === WebSocket.OPEN) {
              s.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'wishlist_share', sessionCode: c, lines }));
            }
          });
          break;
        }
        case 'wishlist_shared':
          setPeerWishlist(sanitizeWishlist(msg.lines));
          break;
        case 'error':
          setError(msg.message);
          if (msg.code === 'unknown_session' || msg.code === 'bad_resume' || msg.code === 'session_full') {
            setStatus('error');
            void clearPersisted();
          }
          break;
      }
    },
    [handleSnapshot, persist, clearPersisted, sendIdentity],
  );

  const connect = useCallback(
    (initial: ClientMessage) => {
      // Cancel any pending auto-resume and fully detach the previous socket
      // before opening a new one — otherwise a delayed reconnect racing a fresh
      // create()/join() would leave two live sockets driving the same state.
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      const prev = ws.current;
      if (prev) {
        prev.onopen = prev.onmessage = prev.onerror = prev.onclose = null;
        prev.close();
      }

      intentionalClose.current = false;
      setStatus('connecting');
      setError(null);
      const socket = new WebSocket(TRADE_WS_URL);
      ws.current = socket;
      socket.onopen = () => {
        reconnectAttempts.current = 0;
        socket.send(JSON.stringify(initial));
      };
      socket.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : '');
      socket.onerror = () => setError('connection error');
      socket.onclose = () => {
        if (ws.current !== socket) return; // superseded by a newer socket
        ws.current = null;
        if (intentionalClose.current) return;
        const a = active.current;
        const state = stateRef.current;
        const resumable = !!(a.code && a.resumeToken && state && state !== 'completed' && state !== 'cancelled');
        if (!resumable) {
          // No live session to resume. If we never even established one (a.code
          // unset), the initial connect failed — surface it instead of spinning
          // on "Connecting…" forever.
          if (!a.code) {
            setStatus('error');
            setError('Could not reach the trade server.');
          }
          return;
        }
        if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
          setStatus('error');
          setError('Lost connection to the trade server. Try resuming from the trade screen.');
          return;
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts.current);
        reconnectAttempts.current += 1;
        setStatus('connecting');
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null;
          if (a.code && a.resumeToken) {
            connect({ v: PROTOCOL_VERSION, type: 'resume', sessionCode: a.code, resumeToken: a.resumeToken });
          }
        }, delay);
      };
    },
    [onMessage],
  );

  const send = useCallback((msg: ClientMessage) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify(msg));
    } else {
      // Dropped while reconnecting — tell the user rather than losing it silently
      // (the next state_sync would otherwise just revert their UI with no reason).
      setError('Still connecting — that didn’t go through. Try again in a moment.');
    }
  }, []);

  const code = () => active.current.code;

  const create = useCallback(() => connect({ v: PROTOCOL_VERSION, type: 'create_session' }), [connect]);
  const join = useCallback(
    (c: string) => connect({ v: PROTOCOL_VERSION, type: 'join_session', sessionCode: c.trim().toUpperCase() }),
    [connect],
  );
  const resume = useCallback(
    (t: ActiveTrade) => {
      active.current = t;
      setSeat(t.seat);
      connect({ v: PROTOCOL_VERSION, type: 'resume', sessionCode: t.code, resumeToken: t.resumeToken });
    },
    [connect],
  );

  const sendOffer = useCallback((side: Seat, lines: TradeLine[]) => {
    const c = code();
    if (c) send({ v: PROTOCOL_VERSION, type: 'offer_update', sessionCode: c, side, lines });
  }, [send]);
  const requestTradelist = useCallback(() => {
    const c = code();
    if (c) {
      setPeerTradelistLoading(true);
      send({ v: PROTOCOL_VERSION, type: 'tradelist_request', sessionCode: c });
    }
  }, [send]);
  const requestWishlist = useCallback(() => {
    const c = code();
    if (c) send({ v: PROTOCOL_VERSION, type: 'wishlist_request', sessionCode: c });
  }, [send]);
  const accept = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'accept', sessionCode: c }); }, [send]);
  const unaccept = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'unaccept', sessionCode: c }); }, [send]);
  const confirmComplete = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'confirm_complete', sessionCode: c }); }, [send]);
  const cancel = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'cancel', sessionCode: c }); }, [send]);

  const reset = useCallback(() => {
    intentionalClose.current = true;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    reconnectAttempts.current = 0;
    ws.current?.close();
    ws.current = null;
    active.current = {};
    appliedRef.current = false;
    stateRef.current = null;
    peerUsername.current = null;
    sentIdentity.current = false;
    setStatus('idle');
    setSeat(null);
    setSnapshot(null);
    setPeerPresent(false);
    setError(null);
    setPeerTradelist(null);
    setPeerTradelistLoading(false);
    setPeerWishlist(null);
    void clearPersisted();
  }, [clearPersisted]);

  // Close the socket (and cancel any pending auto-resume) if the component
  // using the hook unmounts — a stray reconnect would re-occupy the trade seat.
  useEffect(() => {
    return () => {
      intentionalClose.current = true;
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      ws.current?.close();
    };
  }, []);

  return { status, seat, snapshot, peerPresent, error, peerTradelist, peerTradelistLoading, peerWishlist, create, join, resume, sendOffer, requestTradelist, requestWishlist, accept, unaccept, confirmComplete, cancel, reset };
}
