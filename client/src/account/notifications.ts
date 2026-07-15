import type { MatchEntry } from '@mtg/shared';
import { getSetting, setSetting } from '../db/settings.js';
import * as api from './api.js';
import { ACCOUNTS_ENABLED } from './config.js';
import { getAccountSession } from './session.js';

// Match notifications — pull-based, no push. The server computes the current
// matches (users whose published lists overlap mine, either direction) on
// demand; this module fetches them on app open and when the bell is opened,
// and tracks per-user "seen"/"dismissed" state locally so the bell can show a
// red dot only for genuinely new matches.
//
// A match is keyed by the other user's name. Its `signature` (from the server)
// changes whenever the overlapping cards change, which is how we tell "new"
// (never seen this content) from "already acknowledged", and how a dismissed
// match can resurface if the other user later adds a matching card.

export const KEY_NOTIFICATIONS = 'matchNotifications';
const KEY_LAST_FETCH_AT = 'matchLastFetchAt';

/** Don't auto-refetch matches more than once per this window (app-open path). */
const FETCH_MIN_INTERVAL_MS = 10 * 60 * 1000;

export interface NotificationState {
  /** Signature the user has looked at (no longer "new"). */
  seenSig?: string;
  /** Signature the user dismissed; resurfaces if the content changes. */
  dismissedSig?: string;
}

export interface StoredNotifications {
  fetchedAt: number;
  matches: MatchEntry[];
  /** Per-username seen/dismissed bookkeeping. */
  state: Record<string, NotificationState>;
}

/** A current match plus its derived UI flags. */
export interface NotificationItem extends MatchEntry {
  isNew: boolean;
}

export function getStoredNotifications(): Promise<StoredNotifications | undefined> {
  return getSetting<StoredNotifications>(KEY_NOTIFICATIONS);
}

/** Active (non-dismissed) matches, newest first, each flagged new/seen. */
export function activeItems(stored: StoredNotifications | null | undefined): NotificationItem[] {
  if (!stored) return [];
  const items: NotificationItem[] = [];
  for (const m of stored.matches) {
    const s = stored.state[m.username];
    if (s?.dismissedSig === m.signature) continue; // dismissed at this content
    items.push({ ...m, isNew: s?.seenSig !== m.signature });
  }
  return items;
}

/** True when the bell should show its red dot. */
export function hasNew(stored: StoredNotifications | null | undefined): boolean {
  return activeItems(stored).some((i) => i.isNew);
}

/** Fetch matches now (unthrottled) and merge with existing seen/dismissed state. */
export async function fetchMatchesNow(): Promise<void> {
  if (!ACCOUNTS_ENABLED || !navigator.onLine) return;
  const session = await getAccountSession();
  if (!session) return;
  let res;
  try {
    res = await api.getMatches(session.token);
  } catch {
    return; // offline / server error — keep whatever we had
  }
  const prev = await getStoredNotifications();
  // Keep state only for users still matching, so the map can't grow forever.
  const state: Record<string, NotificationState> = {};
  for (const m of res.matches) {
    const carried = prev?.state[m.username];
    if (carried) state[m.username] = carried;
  }
  await setSetting(KEY_NOTIFICATIONS, {
    fetchedAt: Date.now(),
    matches: res.matches,
    state,
  } satisfies StoredNotifications);
  await setSetting(KEY_LAST_FETCH_AT, Date.now());
}

/** Throttled fetch for the app-open path. */
export async function maybeFetchMatches(): Promise<void> {
  if (!ACCOUNTS_ENABLED || !navigator.onLine) return;
  if (!(await getAccountSession())) return;
  const lastAt = (await getSetting<number>(KEY_LAST_FETCH_AT)) ?? 0;
  if (Date.now() - lastAt < FETCH_MIN_INTERVAL_MS) return;
  await fetchMatchesNow();
}

/** Mark every current match as seen at its present content (clears the dot). */
export async function markAllSeen(): Promise<void> {
  const stored = await getStoredNotifications();
  if (!stored) return;
  const state = { ...stored.state };
  for (const m of stored.matches) {
    state[m.username] = { ...state[m.username], seenSig: m.signature };
  }
  await setSetting(KEY_NOTIFICATIONS, { ...stored, state } satisfies StoredNotifications);
}

/** Dismiss one user's match at its present content. */
export async function dismissMatch(username: string): Promise<void> {
  const stored = await getStoredNotifications();
  if (!stored) return;
  const match = stored.matches.find((m) => m.username === username);
  if (!match) return;
  const state = { ...stored.state };
  state[username] = { ...state[username], dismissedSig: match.signature };
  await setSetting(KEY_NOTIFICATIONS, { ...stored, state } satisfies StoredNotifications);
}
