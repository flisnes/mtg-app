// Agent connection manager: while prefs.agentBridge is on, this tab keeps a
// WebSocket to the local MCP bridge (bridge/ workspace) and answers its tool
// calls. Module singleton in the style of sync/engine.ts.

import {
  AGENT_PROTOCOL_VERSION,
  type AgentBridgeMessage,
  type AgentTabMessage,
} from '@mtg/shared';
import { getPrefs, subscribePrefs } from '../prefs.js';
import { APP_VERSION } from '../version.js';
import { AGENT_WS_URL } from './config.js';
import { dispatch, manifestOf } from './registry.js';
import { AGENT_TOOLS } from './tools.js';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

// ---------------------------------------------------------------------------
// Status: a tiny external store for the Settings section.
// ---------------------------------------------------------------------------

/**
 * off: pref disabled. waiting: enabled, no bridge answering (it only runs
 * while a Claude Code session has spawned it). connected: live. replaced:
 * another tab took over; this one stays quiet until re-enabled or reloaded.
 */
export type AgentStatus = 'off' | 'waiting' | 'connected' | 'replaced';

let status: AgentStatus = 'off';
const statusListeners = new Set<() => void>();

function setStatus(next: AgentStatus): void {
  if (status === next) return;
  status = next;
  statusListeners.forEach((cb) => cb());
}

export function getAgentStatusSnapshot(): AgentStatus {
  return status;
}

export function subscribeAgentStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempts = 0;
let replaced = false;
let initialized = false;

function send(msg: AgentTabMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function scheduleReconnect(): void {
  if (reconnectTimer || !getPrefs().agentBridge || replaced) return;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, delay);
}

async function handleCall(callId: string, tool: string, args: Record<string, unknown>): Promise<void> {
  try {
    const result = await dispatch(AGENT_TOOLS, tool, args);
    send({ v: AGENT_PROTOCOL_VERSION, type: 'agent_call_result', callId, ok: true, result });
  } catch (err) {
    send({
      v: AGENT_PROTOCOL_VERSION,
      type: 'agent_call_result',
      callId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function onMessage(ev: MessageEvent): void {
  let msg: AgentBridgeMessage;
  try {
    msg = JSON.parse(String(ev.data)) as AgentBridgeMessage;
  } catch {
    return;
  }
  if (typeof msg !== 'object' || msg === null || msg.v !== AGENT_PROTOCOL_VERSION) return;
  switch (msg.type) {
    case 'agent_call':
      if (typeof msg.callId === 'string' && typeof msg.tool === 'string') {
        void handleCall(msg.callId, msg.tool, (msg.args ?? {}) as Record<string, unknown>);
      }
      return;
    case 'agent_replaced':
      // Another tab said hello. Back off for good — two tabs fighting over
      // one bridge would reconnect-loop forever.
      replaced = true;
      setStatus('replaced');
      return;
    case 'agent_error':
      return; // the close that follows carries the consequence
  }
}

function ensureSocket(): void {
  if (!getPrefs().agentBridge || replaced) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setStatus('waiting');
  let ws: WebSocket;
  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    attempts = 0;
    send({
      v: AGENT_PROTOCOL_VERSION,
      type: 'agent_hello',
      app: 'mtg-app',
      appVersion: APP_VERSION,
      tools: manifestOf(AGENT_TOOLS),
    });
    setStatus('connected');
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (getPrefs().agentBridge && !replaced) {
      setStatus('waiting');
      scheduleReconnect();
    } else if (!replaced) {
      setStatus('off');
    }
  };
  ws.onerror = () => {
    // onclose follows and handles the retry.
  };
}

function closeSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  attempts = 0;
  const ws = socket;
  socket = null;
  ws?.close();
  setStatus(getPrefs().agentBridge ? 'waiting' : 'off');
}

/** Called once from App.tsx. Safe to call again (no-op). */
export function initAgentBridge(): void {
  if (initialized) return;
  initialized = true;
  subscribePrefs(() => {
    if (getPrefs().agentBridge) {
      // Re-enabling also forgives a 'replaced' verdict: the user asked again.
      replaced = false;
      ensureSocket();
    } else if (socket || reconnectTimer) {
      closeSocket();
    }
  });
  ensureSocket();
}
