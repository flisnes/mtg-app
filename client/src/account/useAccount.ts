import { useLiveQuery } from 'dexie-react-hooks';
import { getSetting } from '../db/settings.js';
import { ACCOUNTS_ENABLED } from './config.js';
import {
  KEY_AUTO_BACKUP,
  KEY_CONFLICT,
  KEY_LAST_BACKUP,
  KEY_SESSION,
  type AccountSession,
  type LastBackup,
  type SyncConflict,
} from './session.js';

export interface AccountState {
  enabled: boolean;
  /** undefined while loading, null when signed out. */
  session: AccountSession | null | undefined;
  lastBackup: LastBackup | null;
  conflict: SyncConflict | null;
  autoBackup: boolean;
}

/** Live view of the account/session settings (updates on every sign-in/backup). */
export function useAccount(): AccountState {
  const session = useLiveQuery(
    async () => (await getSetting<AccountSession>(KEY_SESSION)) ?? null,
    [],
  );
  const lastBackup = useLiveQuery(
    async () => (await getSetting<LastBackup>(KEY_LAST_BACKUP)) ?? null,
    [],
    null,
  );
  const conflict = useLiveQuery(
    async () => (await getSetting<SyncConflict>(KEY_CONFLICT)) ?? null,
    [],
    null,
  );
  const autoBackup = useLiveQuery(
    async () => (await getSetting<boolean>(KEY_AUTO_BACKUP)) !== false,
    [],
    true,
  );
  return { enabled: ACCOUNTS_ENABLED, session, lastBackup, conflict, autoBackup };
}
