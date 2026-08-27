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
import { sanitizeSyncedRow } from '../transfer/payload.js';
import { stagePutMany } from './outbox.js';

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
  /**
   * Set while this device is pulling the account from scratch (after a reseed
   * or a repair rewind) and has not caught up yet. Sent to the server so it
   * serves the next page instead of ordering another reseed, and remembered
   * across restarts so a reseed interrupted half way doesn't wipe twice.
   */
  reseeding?: true;
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
  sealedItems: db.sealedItems,
  wishlist: db.wishlist,
  decks: db.decks,
  deckCards: db.deckCards,
  deckFolders: db.deckFolders,
  trades: db.trades,
  events: db.events,
} as const;

/** A row's own LWW stamp (trades are immutable → completedAt). */
function stampOf(row: Record<string, unknown>): number {
  const v = row.updatedAt ?? row.completedAt ?? row.ts;
  return typeof v === 'number' ? v : 0;
}

/**
 * Apply a page of changes. Returns the sequence number of the first change it
 * could NOT apply (a table added after this build), or null when it applied
 * everything — the caller keeps its cursor below that seq so the row is still
 * waiting after the app updates. A server too old to send `seq` reports 0,
 * which reads as "don't advance at all".
 *
 * Before v0.135.5 an unknown table was skipped while the cursor moved on, so
 * boxes added on a phone could never reach a PC still running an older build
 * (the `syncTableAdditions` repair). Refusing to advance costs a re-pull of one
 * page per sync until that device updates, which it does on its next open.
 */
async function applyServerChanges(changes: SyncChange[]): Promise<number | null> {
  if (!changes.length) return null;
  return db.transaction('rw', [...Object.values(TABLES), db.outbox], async () => {
    let blockedFrom: number | null = null;
    for (const c of changes) {
      const table = TABLES[c.tbl];
      if (!table) {
        const seq = typeof c.seq === 'number' ? c.seq : 0;
        blockedFrom = blockedFrom === null ? seq : Math.min(blockedFrom, seq);
        continue;
      }

      // A pending local change that is NEWER wins locally and will win on the
      // server too — skip the incoming row. Anything older is superseded.
      const pending = await db.outbox.get([c.tbl, c.rowId]);
      if (pending && pending.updatedAt > c.updatedAt) continue;

      // Belt-and-braces LWW, applied to BOTH puts and deletes: a newer local
      // row (even one already acked, so with no pending outbox entry) must not
      // be clobbered by an older incoming change — including an older tombstone.
      const local = (await table.get(c.rowId)) as Record<string, unknown> | undefined;
      if (local && stampOf(local) > c.updatedAt) continue;

      if (c.deleted) {
        await table.delete(c.rowId);
      } else {
        // Sanitize BEFORE dropping the pending entry: a corrupt/mismatched row
        // is skipped without discarding the valid local change it would lose to.
        const row = sanitizeSyncedRow(c.tbl, c.row);
        if (!row || row.id !== c.rowId) continue;
        await (table as (typeof TABLES)['collection']).put(row as never);
      }
      // The incoming change was applied, so the pending local change (if any) is
      // now superseded and can be dropped.
      if (pending) await db.outbox.delete([c.tbl, c.rowId]);
    }
    return blockedFrom;
  });
}

/**
 * Wipe this device's synced tables so the account can be re-pulled from scratch
 * (server answered `resync`: it pruned tombstones past our cursor, so we may be
 * holding rows deleted elsewhere and would never hear about it).
 *
 * Clears the tables DIRECTLY, never through dataAccess — a staged delete here
 * would push tombstones for every row and wipe the account itself. The push in
 * the same call was already applied server-side, so the outbox goes too and
 * everything comes back on the pull. Price histories are left alone: they are
 * local derived data and rebuilding them would lose real chart history.
 */
async function wipeForResync(): Promise<void> {
  await db.transaction('rw', [...Object.values(TABLES), db.outbox], async () => {
    await Promise.all([...Object.values(TABLES), db.outbox].map((t) => t.clear()));
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
function requestSync(delayMs = 2000): void {
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
    // Re-read the session/state INSIDE the lock: a sign-out (or sign-in to
    // another account) may have landed between the checks above and acquiring
    // the lock, and clearSyncState() deleting the row must not be undone by a
    // stale in-flight write below.
    const locked = await getSetting<StoredSession>(KEY_SESSION);
    const lockedState = await getSyncState();
    if (!locked || !lockedState || lockedState.account !== locked.username) return;

    if (retryTimer) clearTimeout(retryTimer);
    setStatus({ ...status, phase: 'syncing' });
    try {
      let cursor = lockedState.cursor;
      // A capped reseed takes many passes; only the first one wipes.
      let reseeding = lockedState.reseeding === true;
      let publishedAnything = false;
      // Bounded loop: each pass pushes ≤SYNC_MAX_PUSH and pulls ≤SYNC_MAX_PULL.
      for (let pass = 0; pass < 100; pass++) {
        const batch = await db.outbox.limit(SYNC_MAX_PUSH).toArray();
        const touchesLists = batch.some((c) => c.tbl === 'collection' || c.tbl === 'wishlist');
        const publish = touchesLists
          ? { tradelist: await readOwnTradelist(MAX_PUBLIC_LINES), wishlist: await readOwnWishlist(MAX_PUBLIC_LINES) }
          : undefined;
        const req: SyncRequest = {
          clientId: lockedState.clientId,
          cursor,
          changes: batch,
          ...(publish ? { publish } : {}),
          ...(reseeding ? { reseeding: true as const } : {}),
        };
        const res = await api.sync(locked.token, req);
        publishedAnything ||= !!publish;

        if (res.resync) {
          // Our push was applied, so nothing local is lost by starting over.
          // Only the first pass wipes: once we are reseeding there is nothing
          // stale left to drop, and wiping on every pass of a capped reseed is
          // an endless wipe-and-refill loop that never finishes.
          if (!reseeding) await wipeForResync();
          reseeding = true;
          cursor = 0;
          const reset = await getSyncState();
          if (!reset || reset.account !== locked.username) return;
          await setSetting(KEY_SYNC_STATE, { ...reset, cursor, reseeding: true } satisfies SyncState);
          continue;
        }

        const blockedFrom = await applyServerChanges(res.changes);
        // Caught up: the account is whole again, so stop claiming a reseed.
        if (!res.hasMore) reseeding = false;
        // When the pull was capped the server did NOT apply the push.
        if (!res.hasMore) await ackOutbox(batch);
        // Stop just short of anything this build couldn't apply, and never move
        // backwards (Math.max also absorbs the seq-less case, which is -1).
        const ceiling = blockedFrom === null ? res.cursor : Math.min(res.cursor, blockedFrom - 1);
        cursor = Math.max(cursor, ceiling);
        // A sign-out during the request deletes the sync state; don't recreate it.
        const current = await getSyncState();
        if (!current || current.account !== locked.username) return;
        const { reseeding: _was, ...rest } = current;
        await setSetting(KEY_SYNC_STATE, { ...rest, cursor, ...(reseeding ? { reseeding: true as const } : {}) } satisfies SyncState);

        // Nothing past the blocked change can be pulled, so looping would only
        // re-fetch the same page. The rows wait on the server until this device
        // updates and knows the table.
        if (blockedFrom !== null) break;
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
      // A revoked/expired token (401) will fail forever; stop retrying and wait
      // for a real sign-in to restart sync (mirrors the WS socketAuthFailed latch).
      if (err instanceof api.ApiError && err.status === 401) {
        setStatus({ phase: 'error', lastSyncAt: status.lastSyncAt, message: 'Signed out — sign in again to sync.' });
        return;
      }
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
      // One bulk stage per table instead of a put per row — first sign-in on a
      // large collection stages tens of thousands of rows and blocked on this.
      await stagePutMany(tbl, rows as Parameters<typeof stagePutMany>[1]);
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
// One-time repairs
// ---------------------------------------------------------------------------

/** Ids of repairs already applied on this device (not a version number — a
 *  device can skip releases and must still run every repair it never ran). */
const KEY_REPAIRS = 'syncRepairs';

/**
 * The repairs this build knows about, oldest first. Every one so far needs the
 * same medicine, so they share the code below and only the id list grows:
 *
 * - `containerKinds` (v0.75.1): sanitizeDeckRow dropped `kind`, so every binder
 *   and box that arrived from the server landed as a plain deck.
 * - `syncTableAdditions` (v0.129.3): applyServerChanges skips a change whose
 *   table it doesn't know (`TABLES[c.tbl]` is undefined) but still advances the
 *   cursor past it. So every device that pulled while running a build older
 *   than the table silently dropped those rows for good — deckFolders before
 *   v0.109.0, sealedItems before v0.117.0. Symptom: boxes added on the phone
 *   never appear on the PC, no matter how often either syncs.
 * - `containerEmblems2` (v0.134.7): containerKinds all over again, for the
 *   `emblem` field added in v0.133.0. A device still on an older build pulled
 *   emblem-bearing deck/binder/box rows, sanitizeDeckRow rebuilt them without
 *   the field, and the cursor moved on — so updating that device never brought
 *   the emblem back. (v0.133.0 shipped a `containerEmblems` repair and v0.133.1
 *   removed it as unnecessary; it wasn't, hence the fresh id — devices that ran
 *   v0.133.0 have the old id recorded and would skip a re-added one.)
 * - `deckCardUnfiled` (v0.135.3): same again for `unfiled` on a deck slot, added
 *   in v0.135.3. A build without the field rebuilds the slot as filed, so a card
 *   you took out of a deck on the phone would look like it was back in it.
 *
 * The medicine: rewind the cursor once so the server re-sends everything it
 * has, flagged as a reseed so the server pages us all the way back up instead
 * of ordering a wipe half way (v0.133.1 — a rewind on an account with more than
 * one page of history used to wipe and refill forever). Sync-row content is
 * opaque to the server, so the correct rows were always in the stored JSON, and
 * a re-pull only skips an incoming row when the local copy is STRICTLY newer —
 * so dropped rows land while pending local edits still win.
 *
 * THE LIST SHOULD NOT NEED TO GROW AGAIN. Every id above is one release paying
 * for the same design: the sanitizers rebuilt each row from the keys they knew,
 * so any build older than a field wrote that field away and moved its cursor
 * past the only change carrying it. Since v0.135.5 both halves are fixed at the
 * source instead:
 *
 * - A new FIELD survives an older build (sanitizeSyncedRow keeps keys it
 *   doesn't recognize; adding one to a row type fails the build until
 *   KNOWN_KEYS in transfer/payload.ts is updated, which is the whole fix).
 * - A new TABLE no longer moves the cursor past itself (applyServerChanges
 *   reports the seq it stopped at), so the rows simply wait for the update.
 *
 * Both live in code paths the compiler and the protocol enforce, which is why
 * this is a list of four historical ids rather than a standing ritual. If you
 * ever do need a fifth, note that a repair only heals rows the server still
 * holds: a stale device that edits such a row first pushes its stripped copy
 * with a newer stamp, and then the field is gone from the account for good.
 */
const REPAIRS = ['containerKinds', 'syncTableAdditions', 'containerEmblems2', 'deckCardUnfiled'] as const;

async function runOneTimeRepairs(): Promise<void> {
  const done = (await getSetting<string[]>(KEY_REPAIRS)) ?? [];
  const pending = REPAIRS.filter((r) => !done.includes(r));
  if (pending.length === 0) return;
  const state = await getSyncState();
  if (state && state.cursor > 0) {
    await setSetting(KEY_SYNC_STATE, { ...state, cursor: 0, reseeding: true } satisfies SyncState);
  }
  await setSetting(KEY_REPAIRS, [...done, ...pending]);
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

  // Repairs first: a rewound cursor must be durable before anything can pull,
  // including a sync_notify off the socket (which would save the old cursor back
  // and strand the repair, since it is only ever attempted once). If it fails,
  // sync still starts and the repair retries on the next app open.
  void runOneTimeRepairs()
    .catch(() => {})
    .then(() => {
      void ensureSocket();
      return syncNow();
    });
}
