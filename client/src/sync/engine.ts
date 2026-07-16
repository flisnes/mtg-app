import { liveQuery } from 'dexie';
import {
  MAX_PUBLIC_LINES,
  PROTOCOL_VERSION,
  SYNC_MAX_PUSH,
  type ServerMessage,
  type SyncChange,
  type SyncRequest,
  type SyncTable,
} from '@mtg/shared';
import * as api from '../account/api.js';
import { ACCOUNTS_ENABLED } from '../account/config.js';
import { db } from '../db/schema.js';
import { readOwnTradelist, readOwnWishlist } from '../db/ownLists.js';
import { getSetting, setSetting, deleteSetting } from '../db/settings.js';
import { TRADE_ENABLED, TRADE_WS_URL } from '../trade/config.js';
import {
  sanitizeCollectionRow,
  sanitizeDeckCardRow,
  sanitizeDeckRow,
  sanitizeEventRow,
  sanitizeTradeRow,
  sanitizeWishlistRow,
} from '../transfer/payload.js';
import { stagePut } from './outbox.js';

// The sync engine (sync plan, 2026-07-16). Drains the outbox to POST /api/sync
// and applies what comes back, last-write-wins per row. Runs whenever anything
// nudges it: app open, tab visible again, back online, a local mutation
// (outbox observer), or a live sync_notify from the server's WS feed. All
// entry points funnel through syncNow(), which serializes itself via the Web
// Locks API so two tabs never sync concurrently.
//
// Server rows are applied DIRECTLY to the Dexie tables — never through
// dataAccess — so they are not re-staged into the outbox or re-evented.

// Keep in sync with account/session.ts KEY_SESSION (read directly to avoid an
// import cycle: session.ts imports this module for the login flows).
const KEY_SESSION = 'accountSession';
export const KEY_SYNC_STATE = 'syncState';

interface StoredSession {
  token: string;
  username: string;
}

export interface SyncState {
  /** Random per-device id; the server uses it to skip echo notifications. */
  clientId: string;
  /** The account this state belongs to (sign-in to another account resets it). */
  account: string;
  /** Highest server seq applied locally. */
  cursor: number;
}

export function getSyncState(): Promise<SyncState | undefined> {
  return getSetting<SyncState>(KEY_SYNC_STATE);
}

export async function clearSyncState(): Promise<void> {
  await deleteSetting(KEY_SYNC_STATE);
  await db.outbox.clear();
}

// ---------------------------------------------------------------------------
// Status (for the header indicator): a tiny external store for React.
// ---------------------------------------------------------------------------

export interface SyncStatus {
  phase: 'idle' | 'syncing' | 'error';
  /** Last successful sync in this session (ms epoch), if any. */
  lastSyncAt: number | null;
  message?: string;
}

let status: SyncStatus = { phase: 'idle', lastSyncAt: null };
const statusListeners = new Set<() => void>();

function setStatus(next: SyncStatus): void {
  status = next;
  statusListeners.forEach((cb) => cb());
}

export function getSyncStatusSnapshot(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

// ---------------------------------------------------------------------------
// Applying server changes
// ---------------------------------------------------------------------------

const TABLES = {
  collection: db.collection,
  wishlist: db.wishlist,
  decks: db.decks,
  deckCards: db.deckCards,
  trades: db.trades,
  events: db.events,
} as const;

const SANITIZERS: Record<SyncTable, (raw: unknown) => { id: string } | null> = {
  collection: sanitizeCollectionRow,
  wishlist: sanitizeWishlistRow,
  decks: sanitizeDeckRow,
  deckCards: sanitizeDeckCardRow,
  trades: sanitizeTradeRow,
  events: sanitizeEventRow,
};

/** A row's own LWW stamp (trades are immutable → completedAt). */
function stampOf(row: Record<string, unknown>): number {
  const v = row.updatedAt ?? row.completedAt ?? row.ts;
  return typeof v === 'number' ? v : 0;
}

async function applyServerChanges(changes: SyncChange[]): Promise<void> {
  if (!changes.length) return;
  await db.transaction('rw', [...Object.values(TABLES), db.outbox], async () => {
    for (const c of changes) {
      const table = TABLES[c.tbl];
      if (!table) continue;

      // A pending local change that is NEWER wins locally and will win on the
      // server too — skip the incoming row. Anything older is superseded.
      const pending = await db.outbox.get([c.tbl, c.rowId]);
      if (pending && pending.updatedAt > c.updatedAt) continue;
      if (pending) await db.outbox.delete([c.tbl, c.rowId]);

      if (c.deleted) {
        await table.delete(c.rowId);
        continue;
      }
      const row = SANITIZERS[c.tbl](c.row);
      if (!row || row.id !== c.rowId) continue; // corrupt/mismatched row — drop
      const local = (await table.get(c.rowId)) as Record<string, unknown> | undefined;
      if (local && stampOf(local) > c.updatedAt) continue; // belt-and-braces LWW
      await (table as (typeof TABLES)['collection']).put(row as never);
    }
  });
}

/** Drop pushed outbox entries — unless a newer local change replaced them mid-flight. */
async function ackOutbox(pushed: SyncChange[]): Promise<void> {
  if (!pushed.length) return;
  await db.transaction('rw', db.outbox, async () => {
    for (const c of pushed) {
      const entry = await db.outbox.get([c.tbl, c.rowId]);
      if (entry && entry.updatedAt === c.updatedAt && !!entry.deleted === !!c.deleted) {
        await db.outbox.delete([c.tbl, c.rowId]);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The sync loop
// ---------------------------------------------------------------------------

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
/** Fallback mutex for browsers without the Web Locks API. */
let runningFallback = false;

async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request('mtg-sync', { ifAvailable: true }, async (lock) => {
      if (!lock) return undefined; // another tab is syncing
      return fn();
    });
  }
  if (runningFallback) return undefined;
  runningFallback = true;
  try {
    return await fn();
  } finally {
    runningFallback = false;
  }
}

/** Debounced entry point for mutation-driven syncs. */
export function requestSync(delayMs = 2000): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void syncNow(), delayMs);
}

/**
 * Push the outbox and pull everything new, looping until both sides are
 * drained. Safe to call from anywhere, any time; no-ops when signed out,
 * uninitialized, offline, or already running in another tab.
 */
export async function syncNow(): Promise<void> {
  if (!ACCOUNTS_ENABLED) return;
  const session = await getSetting<StoredSession>(KEY_SESSION);
  if (!session) return;
  const state = await getSyncState();
  if (!state || state.account !== session.username) return; // login flow not done
  if (!navigator.onLine) return; // the 'online' listener will retry

  await withSyncLock(async () => {
    if (retryTimer) clearTimeout(retryTimer);
    setStatus({ ...status, phase: 'syncing' });
    try {
      let cursor = state.cursor;
      let publishedAnything = false;
      // Bounded loop: each pass pushes ≤SYNC_MAX_PUSH and pulls ≤SYNC_MAX_PULL.
      for (let pass = 0; pass < 100; pass++) {
        const batch = await db.outbox.limit(SYNC_MAX_PUSH).toArray();
        const touchesLists = batch.some((c) => c.tbl === 'collection' || c.tbl === 'wishlist');
        const publish = touchesLists
          ? { tradelist: await readOwnTradelist(MAX_PUBLIC_LINES), wishlist: await readOwnWishlist(MAX_PUBLIC_LINES) }
          : undefined;
        const req: SyncRequest = { clientId: state.clientId, cursor, changes: batch, ...(publish ? { publish } : {}) };
        const res = await api.sync(session.token, req);
        publishedAnything ||= !!publish;

        await applyServerChanges(res.changes);
        // When the pull was capped the server did NOT apply the push.
        if (!res.hasMore) await ackOutbox(batch);
        cursor = res.cursor;
        await setSetting(KEY_SYNC_STATE, { ...state, cursor } satisfies SyncState);

        if (!res.hasMore && (await db.outbox.count()) === 0) break;
      }
      failures = 0;
      setStatus({ phase: 'idle', lastSyncAt: Date.now() });
      if (publishedAnything) {
        // Published lists changed → matches may have too. Lazy import: this
        // module must not statically depend on account/session.ts.
        void import('../account/notifications.js').then((m) => m.fetchMatchesNow());
      }
    } catch (err) {
      failures += 1;
      const message =
        err instanceof api.ApiError ? err.friendlyMessage : err instanceof Error ? err.message : 'Sync failed.';
      setStatus({ ...status, phase: 'error', message });
      const delay = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(failures - 1, 6));
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => void syncNow(), delay);
    }
  });
}

// ---------------------------------------------------------------------------
// Login-flow initialization (called by account/session.ts)
// ---------------------------------------------------------------------------

async function baseState(username: string): Promise<SyncState> {
  const prior = await getSyncState();
  return { clientId: prior?.clientId ?? crypto.randomUUID(), account: username, cursor: 0 };
}

/**
 * First device on the account: everything local becomes the account's data.
 * Stages every user-data row and starts pushing.
 */
export async function initSeedSync(username: string): Promise<void> {
  await db.transaction('rw', [...Object.values(TABLES), db.outbox], async () => {
    await db.outbox.clear();
    for (const [tbl, table] of Object.entries(TABLES) as [SyncTable, (typeof TABLES)['collection']][]) {
      const rows = await table.toArray();
      for (const row of rows) await stagePut(tbl, row as Parameters<typeof stagePut>[1]);
    }
  });
  await setSetting(KEY_SYNC_STATE, await baseState(username));
  onSessionChanged();
}

/** Device with no local data joining an account that has data: pull everything. */
export async function initPullSync(username: string): Promise<void> {
  await db.outbox.clear();
  await setSetting(KEY_SYNC_STATE, await baseState(username));
  onSessionChanged();
}

/** Same account, cursor intact (e.g. sign-out → sign-in): pick up where we left off. */
export function resumeSync(): void {
  onSessionChanged();
}

// ---------------------------------------------------------------------------
// Live push: one WS subscription to the user's change feed
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let socketReconnectTimer: ReturnType<typeof setTimeout> | undefined;
let socketAuthFailed = false;

function closeSocket(): void {
  if (socketReconnectTimer) clearTimeout(socketReconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
}

async function ensureSocket(): Promise<void> {
  if (!ACCOUNTS_ENABLED || !TRADE_ENABLED || socketAuthFailed) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const session = await getSetting<StoredSession>(KEY_SESSION);
  const state = await getSyncState();
  if (!session || !state || state.account !== session.username) {
    closeSocket();
    return;
  }

  const ws = new WebSocket(TRADE_WS_URL);
  socket = ws;
  ws.onopen = () => {
    ws.send(
      JSON.stringify({ v: PROTOCOL_VERSION, type: 'sync_sub', token: session.token, clientId: state.clientId }),
    );
  };
  ws.onmessage = (e) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(e.data)) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === 'sync_notify') {
      void getSyncState().then((s) => {
        if (s && msg.seq > s.cursor) void syncNow();
      });
    } else if (msg.type === 'error' && msg.code === 'unauthorized') {
      // Stale token — stop reconnecting until the session changes.
      socketAuthFailed = true;
      closeSocket();
    }
  };
  ws.onclose = () => {
    socket = null;
    if (socketReconnectTimer) clearTimeout(socketReconnectTimer);
    socketReconnectTimer = setTimeout(() => void ensureSocket(), 15_000);
  };
}

/** Re-evaluate socket + sync after sign-in/out or account deletion. */
export function onSessionChanged(): void {
  socketAuthFailed = false;
  closeSocket();
  void ensureSocket();
  void syncNow();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let initialized = false;

/** Call once at app startup (replaces the old auto-backup-on-open). */
export function initSyncEngine(): void {
  if (initialized || !ACCOUNTS_ENABLED) return;
  initialized = true;

  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void ensureSocket();
      void syncNow();
    }
  });

  // Any local mutation lands in the outbox → debounce a push. This also fires
  // on the engine's own acks/clears, where the follow-up sync is a cheap no-op.
  liveQuery(() => db.outbox.count()).subscribe({
    next: (count) => {
      if (count > 0) requestSync();
    },
    error: () => {},
  });

  void ensureSocket();
  void syncNow();
}
