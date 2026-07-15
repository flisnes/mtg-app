import { useLiveQuery } from 'dexie-react-hooks';
import { getSetting } from '../db/settings.js';
import { ACCOUNTS_ENABLED } from './config.js';
import { KEY_SESSION, type AccountSession } from './session.js';
import {
  KEY_NOTIFICATIONS,
  activeItems,
  hasNew,
  type NotificationItem,
  type StoredNotifications,
} from './notifications.js';

export interface NotificationsView {
  enabled: boolean;
  /** Active (non-dismissed) matches, newest first, each flagged new/seen. */
  items: NotificationItem[];
  /** Whether the bell should show its red dot. */
  hasNew: boolean;
  /** undefined while loading. */
  fetchedAt: number | undefined;
}

/** Live view of the locally-stored match notifications. */
export function useNotifications(): NotificationsView {
  const view = useLiveQuery(async (): Promise<{ items: NotificationItem[]; hasNew: boolean; fetchedAt: number | undefined }> => {
    // Signed out → nothing to show (and stale state stays hidden).
    const session = await getSetting<AccountSession>(KEY_SESSION);
    if (!session) return { items: [], hasNew: false, fetchedAt: undefined };
    const stored = (await getSetting<StoredNotifications>(KEY_NOTIFICATIONS)) ?? null;
    return { items: activeItems(stored), hasNew: hasNew(stored), fetchedAt: stored?.fetchedAt };
  }, []);
  return {
    enabled: ACCOUNTS_ENABLED,
    items: view?.items ?? [],
    hasNew: view?.hasNew ?? false,
    fetchedAt: view?.fetchedAt,
  };
}
