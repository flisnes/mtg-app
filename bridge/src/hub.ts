// The ws side of the bridge: accepts ONE PWA tab on loopback, holds its tool
// manifest, and relays calls. Origin-checked; newest hello wins.

import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentBridgeMessage,
  type AgentTabMessage,
  type AgentToolDescriptor,
} from '@mtg/shared';
import { log } from './log.js';

const HELLO_DEADLINE_MS = 5_000;
const HEARTBEAT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const MAX_CALL_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 128;
const MAX_PAYLOAD = 1024 * 1024;

const DEFAULT_ORIGINS = [
  'https://flisnes.github.io',
  'http://localhost:5173',
  'https://localhost:5173',
  'http://127.0.0.1:5173',
  'https://127.0.0.1:5173',
];

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Tab {
  socket: WebSocket;
  app: string;
  appVersion: string;
  tools: AgentToolDescriptor[];
  alive: boolean;
  missedPings: number;
}

export class TabHub {
  private wss: WebSocketServer;
  private tab: Tab | null = null;
  private pending = new Map<string, PendingCall>();
  private origins: Set<string>;
  /** Fires on connect, disconnect and tools_update — wire to sendToolListChanged. */
  onToolsChanged: () => void = () => {};

  constructor(port: number, extraOrigins: string[]) {
    this.origins = new Set([...DEFAULT_ORIGINS, ...extraOrigins]);
    this.wss = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: MAX_PAYLOAD });
    this.wss.on('listening', () => log(`listening on ws://127.0.0.1:${port}`));
    this.wss.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log(`port ${port} is already in use — another bridge is running.`);
        log('Close the other Claude Code session or set MTG_AGENT_PORT to a free port.');
      } else {
        log('ws server error:', err.message);
      }
      process.exit(1);
    });
    this.wss.on('connection', (socket, req) => this.accept(socket, req.headers.origin));
    setInterval(() => this.heartbeat(), HEARTBEAT_MS).unref();
  }

  tools(): AgentToolDescriptor[] {
    return this.tab?.tools ?? [];
  }

  connected(): boolean {
    return this.tab !== null;
  }

  /** Relay one tool call to the tab; rejects on timeout, eviction or no tab. */
  call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const tab = this.tab;
    if (!tab) return Promise.reject(new Error('No app tab is connected. Open the PWA and enable Agent connections in Settings.'));
    const desc = tab.tools.find((t) => t.name === tool);
    if (!desc) return Promise.reject(new Error(`Unknown tool: ${tool}`));
    const callId = randomUUID();
    const timeoutMs = Math.min(desc.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`Tool ${tool} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
      this.send(tab.socket, { v: AGENT_PROTOCOL_VERSION, type: 'agent_call', callId, tool, args });
    });
  }

  // -------------------------------------------------------------------------

  private accept(socket: WebSocket, origin: string | undefined): void {
    if (!origin || !this.origins.has(origin)) {
      log(`rejected connection from origin ${origin ?? '(none)'}`);
      this.send(socket, {
        v: AGENT_PROTOCOL_VERSION,
        type: 'agent_error',
        code: 'origin_rejected',
        message: `Origin ${origin ?? '(none)'} is not allowed`,
      });
      socket.close(4003);
      return;
    }
    // Pre-auth deadline: a socket that never says hello gets dropped.
    const deadline = setTimeout(() => {
      if (this.tab?.socket !== socket) socket.terminate();
    }, HELLO_DEADLINE_MS);
    socket.on('pong', () => {
      if (this.tab?.socket === socket) {
        this.tab.alive = true;
        this.tab.missedPings = 0;
      }
    });
    socket.on('message', (data) => this.onMessage(socket, data, deadline));
    socket.on('close', () => {
      clearTimeout(deadline);
      if (this.tab?.socket === socket) {
        log(`tab disconnected (${this.tab.app} ${this.tab.appVersion})`);
        this.dropTab('tab disconnected');
      }
    });
    socket.on('error', (err) => log('socket error:', err.message));
  }

  private onMessage(socket: WebSocket, data: RawData, helloDeadline: NodeJS.Timeout): void {
    let msg: AgentTabMessage;
    try {
      msg = JSON.parse(data.toString()) as AgentTabMessage;
    } catch {
      this.send(socket, { v: AGENT_PROTOCOL_VERSION, type: 'agent_error', code: 'malformed', message: 'invalid JSON' });
      socket.close(4002);
      return;
    }
    if (typeof msg !== 'object' || msg === null || msg.v !== AGENT_PROTOCOL_VERSION) {
      this.send(socket, {
        v: AGENT_PROTOCOL_VERSION,
        type: 'agent_error',
        code: 'protocol_version',
        message: `expected protocol v${AGENT_PROTOCOL_VERSION}`,
      });
      socket.close(4002);
      return;
    }
    switch (msg.type) {
      case 'agent_hello': {
        const tools = sanitizeTools(msg.tools);
        if (!tools || typeof msg.app !== 'string' || typeof msg.appVersion !== 'string') {
          this.send(socket, { v: AGENT_PROTOCOL_VERSION, type: 'agent_error', code: 'malformed', message: 'bad hello' });
          socket.close(4002);
          return;
        }
        clearTimeout(helloDeadline);
        if (this.tab && this.tab.socket !== socket) {
          // Newest hello wins; the old tab is told and closed.
          this.send(this.tab.socket, { v: AGENT_PROTOCOL_VERSION, type: 'agent_replaced' });
          this.tab.socket.close(4001);
          this.dropTab('replaced by a newer tab');
        }
        this.tab = { socket, app: msg.app, appVersion: msg.appVersion, tools, alive: true, missedPings: 0 };
        log(`tab connected: ${msg.app} ${msg.appVersion}, ${tools.length} tools`);
        this.onToolsChanged();
        return;
      }
      case 'agent_tools_update': {
        if (this.tab?.socket !== socket) return;
        const tools = sanitizeTools(msg.tools);
        if (!tools) return;
        this.tab.tools = tools;
        this.onToolsChanged();
        return;
      }
      case 'agent_call_result': {
        if (this.tab?.socket !== socket) return;
        if (typeof msg.callId !== 'string') return;
        const pending = this.pending.get(msg.callId);
        if (!pending) return;
        this.pending.delete(msg.callId);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'tool failed'));
        return;
      }
    }
  }

  private dropTab(reason: string): void {
    this.tab = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.onToolsChanged();
  }

  private heartbeat(): void {
    const tab = this.tab;
    if (!tab) return;
    if (!tab.alive) {
      tab.missedPings += 1;
      if (tab.missedPings >= 2) {
        log('tab missed two pings, terminating');
        tab.socket.terminate();
        this.dropTab('tab stopped responding');
        return;
      }
    }
    tab.alive = false;
    tab.socket.ping();
  }

  private send(socket: WebSocket, msg: AgentBridgeMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }
}

function sanitizeTools(input: unknown): AgentToolDescriptor[] | null {
  if (!Array.isArray(input) || input.length > MAX_TOOLS) return null;
  const out: AgentToolDescriptor[] = [];
  const seen = new Set<string>();
  for (const t of input) {
    if (typeof t !== 'object' || t === null) return null;
    const { name, description, inputSchema, timeoutMs } = t as Record<string, unknown>;
    if (typeof name !== 'string' || name.length === 0 || name.length > 64 || !/^[a-z0-9_]+$/.test(name)) return null;
    if (seen.has(name)) return null;
    if (typeof description !== 'string' || description.length > 2000) return null;
    if (typeof inputSchema !== 'object' || inputSchema === null) return null;
    seen.add(name);
    out.push({
      name,
      description,
      inputSchema: inputSchema as Record<string, unknown>,
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
  }
  return out;
}
