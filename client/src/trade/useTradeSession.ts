import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type Seat,
  type ServerMessage,
  type SessionSnapshot,
  type TradeLine,
} from '@mtg/shared';
import { applyCompletedTrade } from '../db/dataAccess.js';
import { getSetting, setSetting } from '../db/settings.js';
import { TRADE_WS_URL } from './config.js';

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
  create: () => void;
  join: (code: string) => void;
  resume: (t: ActiveTrade) => void;
  sendOffer: (lines: TradeLine[]) => void;
  accept: () => void;
  unaccept: () => void;
  confirmComplete: () => void;
  cancel: () => void;
  reset: () => void;
}

export function otherSeat(seat: Seat): Seat {
  return seat === 'a' ? 'b' : 'a';
}

/** Read any persisted in-flight trade (for the resume prompt). */
export async function getPersistedTrade(): Promise<ActiveTrade | undefined> {
  return getSetting<ActiveTrade>(ACTIVE_KEY);
}

export function useTradeSession(): TradeSession {
  const [status, setStatus] = useState<TradeStatus>('idle');
  const [seat, setSeat] = useState<Seat | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [peerPresent, setPeerPresent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const active = useRef<Partial<ActiveTrade>>({});
  const appliedRef = useRef(false);
  const intentionalClose = useRef(false);

  const persist = useCallback(async () => {
    const a = active.current;
    if (a.code && a.resumeToken && a.seat && a.sessionId) {
      await setSetting(ACTIVE_KEY, a as ActiveTrade);
    }
  }, []);

  const clearPersisted = useCallback(async () => {
    await setSetting(ACTIVE_KEY, undefined);
  }, []);

  const handleSnapshot = useCallback(
    (snap: SessionSnapshot, mySeat: Seat) => {
      setSnapshot(snap);
      setPeerPresent(snap.present[otherSeat(mySeat)]);
      if (snap.state === 'completed' && !appliedRef.current) {
        appliedRef.current = true;
        const given = snap.offers[mySeat];
        const received = snap.offers[otherSeat(mySeat)];
        void applyCompletedTrade(snap.sessionId, given, received).finally(() => void clearPersisted());
      }
      if (snap.state === 'cancelled') void clearPersisted();
    },
    [clearPersisted],
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
    [handleSnapshot, persist, clearPersisted],
  );

  const connect = useCallback(
    (initial: ClientMessage) => {
      intentionalClose.current = false;
      setStatus('connecting');
      setError(null);
      const socket = new WebSocket(TRADE_WS_URL);
      ws.current = socket;
      socket.onopen = () => socket.send(JSON.stringify(initial));
      socket.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : '');
      socket.onerror = () => setError('connection error');
      socket.onclose = () => {
        if (intentionalClose.current) return;
        // Auto-resume if we dropped mid-trade and the session may still be alive.
        const a = active.current;
        const state = snapshot?.state;
        if (a.code && a.resumeToken && state && state !== 'completed' && state !== 'cancelled') {
          setStatus('connecting');
          setTimeout(() => {
            if (a.code && a.resumeToken)
              connect({ v: PROTOCOL_VERSION, type: 'resume', sessionCode: a.code, resumeToken: a.resumeToken });
          }, 1200);
        }
      };
    },
    [onMessage, snapshot],
  );

  const send = useCallback((msg: ClientMessage) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
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

  const sendOffer = useCallback((lines: TradeLine[]) => {
    const c = code();
    if (c) send({ v: PROTOCOL_VERSION, type: 'offer_update', sessionCode: c, lines });
  }, [send]);
  const accept = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'accept', sessionCode: c }); }, [send]);
  const unaccept = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'unaccept', sessionCode: c }); }, [send]);
  const confirmComplete = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'confirm_complete', sessionCode: c }); }, [send]);
  const cancel = useCallback(() => { const c = code(); if (c) send({ v: PROTOCOL_VERSION, type: 'cancel', sessionCode: c }); }, [send]);

  const reset = useCallback(() => {
    intentionalClose.current = true;
    ws.current?.close();
    ws.current = null;
    active.current = {};
    appliedRef.current = false;
    setStatus('idle');
    setSeat(null);
    setSnapshot(null);
    setPeerPresent(false);
    setError(null);
    void clearPersisted();
  }, [clearPersisted]);

  // Close the socket if the component using the hook unmounts.
  useEffect(() => {
    return () => {
      intentionalClose.current = true;
      ws.current?.close();
    };
  }, []);

  return { status, seat, snapshot, peerPresent, error, create, join, resume, sendOffer, accept, unaccept, confirmComplete, cancel, reset };
}
