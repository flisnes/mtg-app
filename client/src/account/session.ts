import { deleteAllUserData } from '../db/dataAccess.js';
import { db } from '../db/schema.js';
import { deleteSetting, getSetting, setSetting } from '../db/settings.js';
import {
  clearSyncState,
  getSyncState,
  initPullSync,
  initSeedSync,
  onSessionChanged,
  resumeSync,
} from '../sync/engine.js';
import * as api from './api.js';

// Account session + the sign-in/out flows. The session (bearer token) lives in
// the settings table like other app state.
//
// Data movement is row-level sync (sync/engine.ts), which replaced the old
// whole-snapshot backup/restore in the 2026-07 sync plan. The only decision
// made HERE is what happens when a device first joins an account:
//   - account empty            → this device seeds it (its data uploads)
//   - account has data, device
//     is empty                 → the device just pulls
//   - both have data           → "server wins after first seed": the caller
//     must confirm replacing this device's data (confirmReplaceWithAccount)
//   - same account, synced
//     before                   → resume the cursor; offline edits push as-is

export const KEY_SESSION = 'accountSession';

export interface AccountSession {
  token: string;
  username: string;
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
    // Legacy snapshot-era keys — removed so old installs don't keep stale state.
    deleteSetting('accountLastBackup'),
    deleteSetting('accountSyncConflict'),
    deleteSetting('accountAutoBackup'),
    deleteSetting('accountLastAutoBackupAt'),
    // Match-notification cache (account/notifications.ts). Deleted by literal to
    // avoid an import cycle; keep in sync with KEY_NOTIFICATIONS / KEY_LAST_FETCH_AT.
    deleteSetting('matchNotifications'),
    deleteSetting('matchLastFetchAt'),
  ]);
}

/** How a sign-in proceeded — 'confirm_replace' means nothing happened yet. */
export type SignInAction = 'resumed' | 'seeded' | 'pulled' | 'confirm_replace';

export async function signUp(username: string, password: string, inviteCode: string): Promise<void> {
  const res = await api.register(username, password, inviteCode);
  await clearAccountState();
  await saveSession(res.token, res.username);
  // A brand-new account is empty by definition: this device seeds it.
  await initSeedSync(res.username);
}

export async function signIn(username: string, password: string): Promise<SignInAction> {
  const res = await api.login(username, password);
  const prior = await getSyncState();
  await clearAccountState();
  await saveSession(res.token, res.username);

  const me = await api.me(res.token);
  const serverSeq = me.sync?.seq ?? 0;

  // Same account, synced before, server not reset → resume; offline edits in
  // the outbox simply push.
  if (prior && prior.account === res.username && prior.cursor > 0 && serverSeq >= prior.cursor) {
    resumeSync();
    return 'resumed';
  }

  if (serverSeq === 0) {
    await initSeedSync(res.username);
    return 'seeded';
  }

  const localRows =
    (await db.collection.count()) +
    (await db.wishlist.count()) +
    (await db.decks.count()) +
    (await db.trades.count());
  if (localRows === 0) {
    await initPullSync(res.username);
    return 'pulled';
  }

  // Both sides have data: the caller must confirm the replace (server wins).
  return 'confirm_replace';
}

/**
 * The confirmed "server wins" path: wipe this device's user data (events and
 * outbox included) and pull the account's data.
 */
export async function confirmReplaceWithAccount(): Promise<void> {
  const session = await getAccountSession();
  if (!session) throw new Error('not signed in');
  await deleteAllUserData();
  await initPullSync(session.username);
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
  // The sync state + outbox survive: signing back into the same account
  // resumes the cursor and pushes anything edited while signed out.
  await clearAccountState();
  onSessionChanged();
}

/** Delete the account and everything stored server-side. Local data stays. */
export async function deleteAccount(): Promise<void> {
  const session = await getAccountSession();
  if (session) await api.deleteAccount(session.token);
  await clearAccountState();
  await clearSyncState();
  onSessionChanged();
}
