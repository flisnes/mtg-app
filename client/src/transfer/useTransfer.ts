import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_TRANSFER_CHUNKS,
  PROTOCOL_VERSION,
  TRANSFER_CHUNK_CHARS,
  type TradeErrorCode,
  type TransferClientMessage,
  type TransferServerMessage,
} from '@mtg/shared';
import { replaceAllUserData } from '../db/dataAccess.js';
import { TRADE_WS_URL } from '../trade/config.js';
import { sha256Hex } from '../util/sha256.js';
import {
  countsOf,
  exportUserData,
  sanitizeTransferPayload,
  type TransferCounts,
  type TransferPayload,
} from './payload.js';

// Client side of a device transfer (shared/src/transfer.ts). One hook serves
// both roles: the sender creates a session and streams ack-paced chunks; the
// receiver reassembles, verifies the SHA-256, sanitizes, and — only after the
// user confirms — replaces this device's data. Unlike trades there is no
// resume: a dropped connection cancels the transfer and the user starts over.

export type TransferRole = 'send' | 'receive';

export type TransferStatus =
  | 'idle'
  | 'connecting'
  | 'waiting' // sender: code shown, waiting for the other device to join
  | 'transferring' // chunks flowing (both roles)
  | 'sent' // sender: every chunk acknowledged
  | 'review' // receiver: payload verified, awaiting the user's confirm
  | 'applying'
  | 'done'
  | 'error';

export interface TransferSession {
  status: TransferStatus;
  role: TransferRole | null;
  code: string | null;
  /** 0..1 while transferring. */
  progress: number;
  /** What the received payload contains (review step). */
  counts: TransferCounts | null;
  error: string | null;
  startSend: () => void;
  startReceive: (code: string) => void;
  /** Receiver's confirm: replace this device's data with the received payload. */
  apply: () => void;
  reset: () => void;
}

interface RecvState {
  totalChunks: number;
  totalChars: number;
  sha256: string;
  chunks: (string | null)[];
  received: number;
}

function errorText(code: TradeErrorCode, message: string): string {
  if (code === 'unknown_session') return 'No transfer found for that code. Check it and try again.';
  if (code === 'session_full') return 'Another device already joined that transfer.';
  return message || 'Transfer failed.';
}

export function useTransfer(): TransferSession {
  const [status, setStatus] = useState<TransferStatus>('idle');
  const [role, setRole] = useState<TransferRole | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [counts, setCounts] = useState<TransferCounts | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const statusRef = useRef<TransferStatus>('idle');
  const codeRef = useRef<string | null>(null);
  const sendChunks = useRef<string[]>([]);
  const recv = useRef<RecvState | null>(null);
  const payloadRef = useRef<TransferPayload | null>(null);
  const intentionalClose = useRef(false);

  const setStat = useCallback((s: TransferStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const post = useCallback((msg: TransferClientMessage) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
  }, []);

  const closeSocket = useCallback(() => {
    intentionalClose.current = true;
    ws.current?.close();
    ws.current = null;
  }, []);

  const fail = useCallback(
    (message: string) => {
      setError(message);
      setStat('error');
      closeSocket();
    },
    [setStat, closeSocket],
  );

  const onMessage = useCallback(
    (raw: string) => {
      let msg: TransferServerMessage | { type: 'error'; code: TradeErrorCode; message: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'transfer_created':
          codeRef.current = msg.transferCode;
          setCode(msg.transferCode);
          setStat('waiting');
          break;

        case 'transfer_peer_joined': {
          // The other device joined — snapshot, hash, and start streaming.
          setStat('transferring');
          setProgress(0);
          void (async () => {
            try {
              const json = JSON.stringify(await exportUserData());
              const sha256 = await sha256Hex(json);
              const chunks: string[] = [];
              for (let i = 0; i < json.length; i += TRANSFER_CHUNK_CHARS) {
                chunks.push(json.slice(i, i + TRANSFER_CHUNK_CHARS));
              }
              if (chunks.length > MAX_TRANSFER_CHUNKS) {
                fail('Your data is too large to transfer in one go.');
                return;
              }
              sendChunks.current = chunks;
              const c = codeRef.current;
              if (!c) return;
              post({
                v: PROTOCOL_VERSION,
                type: 'transfer_begin',
                transferCode: c,
                totalChunks: chunks.length,
                totalChars: json.length,
                sha256,
              });
              post({ v: PROTOCOL_VERSION, type: 'transfer_chunk', transferCode: c, seq: 0, data: chunks[0] ?? '' });
            } catch {
              fail('Could not read your data for the transfer.');
            }
          })();
          break;
        }

        case 'transfer_ack': {
          // Flow control: the receiver confirmed chunk seq, send the next one.
          const chunks = sendChunks.current;
          const c = codeRef.current;
          if (!chunks.length || !c) break;
          const next = msg.seq + 1;
          setProgress(Math.min(1, next / chunks.length));
          if (next < chunks.length) {
            post({ v: PROTOCOL_VERSION, type: 'transfer_chunk', transferCode: c, seq: next, data: chunks[next] ?? '' });
          } else {
            setStat('sent');
            closeSocket();
          }
          break;
        }

        case 'transfer_joined':
          setStat('transferring');
          setProgress(0);
          break;

        case 'transfer_begin':
          if (!Number.isInteger(msg.totalChunks) || msg.totalChunks < 1 || msg.totalChunks > MAX_TRANSFER_CHUNKS) {
            fail('The other device sent an invalid transfer.');
            break;
          }
          recv.current = {
            totalChunks: msg.totalChunks,
            totalChars: msg.totalChars,
            sha256: msg.sha256,
            chunks: new Array<string | null>(msg.totalChunks).fill(null),
            received: 0,
          };
          break;

        case 'transfer_chunk': {
          const r = recv.current;
          const c = codeRef.current;
          if (!r || !c || typeof msg.data !== 'string') break;
          if (!Number.isInteger(msg.seq) || msg.seq < 0 || msg.seq >= r.totalChunks) break;
          if (r.chunks[msg.seq] === null) {
            r.chunks[msg.seq] = msg.data;
            r.received++;
          }
          post({ v: PROTOCOL_VERSION, type: 'transfer_ack', transferCode: c, seq: msg.seq });
          setProgress(r.received / r.totalChunks);
          if (r.received < r.totalChunks) break;
          // All chunks in: reassemble, verify, sanitize, then wait for confirm.
          void (async () => {
            try {
              const json = r.chunks.join('');
              if (json.length !== r.totalChars || (await sha256Hex(json)) !== r.sha256) {
                fail('The transfer arrived corrupted. Please try again.');
                return;
              }
              const payload = sanitizeTransferPayload(JSON.parse(json));
              if (!payload) {
                fail('The received data is not a valid transfer.');
                return;
              }
              payloadRef.current = payload;
              setCounts(countsOf(payload));
              setStat('review');
              closeSocket();
            } catch {
              fail('The transfer arrived corrupted. Please try again.');
            }
          })();
          break;
        }

        case 'transfer_cancelled': {
          // Only fatal while the transfer is still in flight: once every chunk
          // has arrived the peer is no longer needed (the sender closing right
          // after the last ack echoes a cancel while we're still verifying).
          const s = statusRef.current;
          const r = recv.current;
          const payloadComplete = !!r && r.received >= r.totalChunks;
          if (!payloadComplete && (s === 'connecting' || s === 'waiting' || s === 'transferring')) {
            fail('The other device disconnected. Start the transfer again.');
          }
          break;
        }

        case 'error':
          fail(errorText(msg.code, msg.message));
          break;
      }
    },
    [setStat, post, fail, closeSocket],
  );

  const connect = useCallback(
    (initial: TransferClientMessage, r: TransferRole) => {
      intentionalClose.current = false;
      setRole(r);
      setError(null);
      setStat('connecting');
      const socket = new WebSocket(TRADE_WS_URL);
      ws.current = socket;
      socket.onopen = () => socket.send(JSON.stringify(initial));
      socket.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : '');
      socket.onclose = () => {
        if (intentionalClose.current) return;
        const r = recv.current;
        if (r && r.received >= r.totalChunks) return; // payload fully received; verification proceeds
        const s = statusRef.current;
        if (s === 'connecting' || s === 'waiting' || s === 'transferring') {
          setError('Connection lost. Start the transfer again.');
          setStat('error');
        }
      };
    },
    [onMessage, setStat],
  );

  const startSend = useCallback(() => connect({ v: PROTOCOL_VERSION, type: 'transfer_create' }, 'send'), [connect]);

  const startReceive = useCallback(
    (c: string) => {
      const normalized = c.trim().toUpperCase();
      codeRef.current = normalized;
      setCode(normalized);
      connect({ v: PROTOCOL_VERSION, type: 'transfer_join', transferCode: normalized }, 'receive');
    },
    [connect],
  );

  const apply = useCallback(() => {
    const payload = payloadRef.current;
    if (!payload) return;
    setStat('applying');
    replaceAllUserData(payload)
      .then(() => setStat('done'))
      .catch(() => fail('Could not apply the transferred data.'));
  }, [setStat, fail]);

  const reset = useCallback(() => {
    closeSocket(); // the server tells the other side we're gone
    codeRef.current = null;
    sendChunks.current = [];
    recv.current = null;
    payloadRef.current = null;
    setStat('idle');
    setRole(null);
    setCode(null);
    setProgress(0);
    setCounts(null);
    setError(null);
  }, [closeSocket, setStat]);

  // Close the socket if the component using the hook unmounts.
  useEffect(() => {
    return () => {
      intentionalClose.current = true;
      ws.current?.close();
    };
  }, []);

  return { status, role, code, progress, counts, error, startSend, startReceive, apply, reset };
}
