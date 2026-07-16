import { useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import {
  KEY_SYNC_STATE,
  getSyncStatusSnapshot,
  subscribeSyncStatus,
  type SyncState,
  type SyncStatus,
} from '../sync/engine.js';
import { ACCOUNTS_ENABLED } from './config.js';
import { KEY_SESSION, type AccountSession } from './session.js';

export interface AccountState {
  enabled: boolean;
  /** undefined while loading, null when signed out. */
  session: AccountSession | null | undefined;
  /**
   * Whether sync is initialized for the signed-in account. False right after
   * signing into an account that already has data while this device also has
   * data — the "replace this device?" decision is still pending.
   */
  syncReady: boolean;
  /** Local changes not pushed yet. */
  pendingChanges: number;
  sync: SyncStatus;
}

/** Live view of the account/session/sync settings. */
export function useAccount(): AccountState {
  const session = useLiveQuery(
    async () => (await getSetting<AccountSession>(KEY_SESSION)) ?? null,
    [],
  );
  const syncState = useLiveQuery(
    async () => (await getSetting<SyncState>(KEY_SYNC_STATE)) ?? null,
    [],
    null,
  );
  const pendingChanges = useLiveQuery(() => db.outbox.count(), [], 0);
  const sync = useSyncExternalStore(subscribeSyncStatus, getSyncStatusSnapshot);
  const syncReady = !!session && !!syncState && syncState.account === session.username;
  return { enabled: ACCOUNTS_ENABLED, session, syncReady, pendingChanges, sync };
}
