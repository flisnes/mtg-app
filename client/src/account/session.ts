import { MAX_PUBLIC_LINES, type SnapshotCounts } from '@mtg/shared';
import { replaceAllUserData } from '../db/dataAccess.js';
import { readOwnTradelist, readOwnWishlist } from '../db/ownLists.js';
import { deleteSetting, getSetting, setSetting } from '../db/settings.js';
import {
  countsOf,
  exportUserData,
  sanitizeTransferPayload,
  type TransferPayload,
} from '../transfer/payload.js';
import * as api from './api.js';
import { ACCOUNTS_ENABLED } from './config.js';

// Account session + backup/restore logic. The session (bearer token) lives in
// the settings table like other app state. Sync is snapshot-based: "back up"
// pushes the whole serialized user data (the device-transfer payload) plus the
// published trade/wishlists; "restore" replaces local data with the stored
// snapshot after the same sanitization a device transfer gets.
//
// `lastBackup.version` is the optimistic-concurrency token: it is the server
// version this device last pushed or restored. A push whose base doesn't match
// the server's current version means another device wrote in between → the
// server answers 409 and we surface a conflict for the user to resolve
// (overwrite or restore first) instead of silently losing either side.

export const KEY_SESSION = 'accountSession';
export const KEY_LAST_BACKUP = 'accountLastBackup';
export const KEY_CONFLICT = 'accountSyncConflict';
export const KEY_AUTO_BACKUP = 'accountAutoBackup';
const KEY_LAST_AUTO_AT = 'accountLastAutoBackupAt';

/** Don't auto-push more than once per this window. */
const AUTO_BACKUP_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AccountSession {
  token: string;
  username: string;
}

export interface LastBackup {
  version: number;
  at: number;
  counts: SnapshotCounts;
}

/** Server-side snapshot meta carried by a 409 (another device pushed). */
export interface SyncConflict {
  version: number;
  updatedAt: number;
}

export function getAccountSession(): Promise<AccountSession | undefined> {
  return getSetting<AccountSession>(KEY_SESSION);
}

async function saveSession(token: string, username: string): Promise<void> {
  await setSetting(KEY_SESSION, { token, username } satisfies AccountSession);
}

async function clearAccountState(): Promise<void> {
  await Promise.all([
    deleteSetting(KEY_SESSION),
    deleteSetting(KEY_LAST_BACKUP),
    deleteSetting(KEY_CONFLICT),
    deleteSetting(KEY_LAST_AUTO_AT),
  ]);
}

export async function signUp(username: string, password: string, inviteCode: string): Promise<void> {
  const res = await api.register(username, password, inviteCode);
  await clearAccountState();
  await saveSession(res.token, res.username);
}

export async function signIn(username: string, password: string): Promise<void> {
  const res = await api.login(username, password);
  // A fresh sign-in has not synced anything yet: no lastBackup version, so the
  // first push against an existing server snapshot correctly conflicts.
  await clearAccountState();
  await saveSession(res.token, res.username);
}

/** Sign out on this device (local data stays). Best-effort server-side revoke. */
export async function signOut(): Promise<void> {
  const session = await getAccountSession();
  if (session) {
    try {
      await api.logout(session.token);
    } catch {
      // offline is fine — the token just stays revocable server-side
    }
  }
  await clearAccountState();
}

/** Delete the account and everything stored server-side. Local data stays. */
export async function deleteAccount(): Promise<void> {
  const session = await getAccountSession();
  if (session) await api.deleteAccount(session.token);
  await clearAccountState();
}

export interface BackupResult {
  version: number;
  at: number;
  counts: SnapshotCounts;
}

/**
 * Push a full snapshot. `baseVersionOverride` is the explicit-overwrite path:
 * the Account page passes the version from a conflict so the push wins.
 * On a version conflict this records the server meta and throws the ApiError
 * (status 409, body.version/updatedAt) for the caller to surface.
 */
export async function backupNow(baseVersionOverride?: number): Promise<BackupResult> {
  const session = await getAccountSession();
  if (!session) throw new Error('not signed in');
  const data = await exportUserData();
  const counts = countsOf(data);
  const lastBackup = await getSetting<LastBackup>(KEY_LAST_BACKUP);
  try {
    const res = await api.putSnapshot(session.token, {
      baseVersion: baseVersionOverride ?? lastBackup?.version ?? null,
      payload: JSON.stringify(data),
      counts,
      tradelist: await readOwnTradelist(MAX_PUBLIC_LINES),
      wishlist: await readOwnWishlist(MAX_PUBLIC_LINES),
    });
    const result: BackupResult = { version: res.version, at: res.updatedAt, counts };
    await setSetting(KEY_LAST_BACKUP, { ...result } satisfies LastBackup);
    await deleteSetting(KEY_CONFLICT);
    return result;
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 409 && err.body?.version != null) {
      await setSetting(KEY_CONFLICT, {
        version: err.body.version,
        updatedAt: err.body.updatedAt ?? 0,
      } satisfies SyncConflict);
    }
    throw err;
  }
}

export interface FetchedBackup {
  version: number;
  updatedAt: number;
  counts: SnapshotCounts;
  payload: TransferPayload;
}

/** Download and sanitize the stored snapshot (does not touch local data yet). */
export async function fetchBackup(): Promise<FetchedBackup> {
  const session = await getAccountSession();
  if (!session) throw new Error('not signed in');
  const res = await api.getSnapshot(session.token);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.payload);
  } catch {
    throw new Error('The stored backup is corrupted.');
  }
  const payload = sanitizeTransferPayload(parsed);
  if (!payload) throw new Error('The stored backup is not valid.');
  return { version: res.version, updatedAt: res.updatedAt, counts: countsOf(payload), payload };
}

/** Replace local data with a fetched backup (after the user confirmed). */
export async function applyBackup(backup: FetchedBackup): Promise<void> {
  await replaceAllUserData(backup.payload);
  await setSetting(KEY_LAST_BACKUP, {
    version: backup.version,
    at: backup.updatedAt,
    counts: backup.counts,
  } satisfies LastBackup);
  await deleteSetting(KEY_CONFLICT);
}

/**
 * Throttled background push, called on app open. Quietly does nothing when
 * signed out, disabled, recently pushed, or in a known conflict; a new 409
 * records the conflict (shown on the Account page) without bothering the user.
 */
export async function maybeAutoBackup(): Promise<void> {
  if (!ACCOUNTS_ENABLED || !navigator.onLine) return;
  const session = await getAccountSession();
  if (!session) return;
  if ((await getSetting<boolean>(KEY_AUTO_BACKUP)) === false) return;
  if (await getSetting<SyncConflict>(KEY_CONFLICT)) return;
  const lastAt = (await getSetting<number>(KEY_LAST_AUTO_AT)) ?? 0;
  if (Date.now() - lastAt < AUTO_BACKUP_MIN_INTERVAL_MS) return;
  try {
    await backupNow();
    await setSetting(KEY_LAST_AUTO_AT, Date.now());
  } catch {
    // Offline / conflict / server error — the Account page shows the state.
  }
}
