import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { sanitizeAvatar, sanitizeProfile, type ProfileAvatar, type UserProfile } from '@mtg/shared';
import { getUserProfile, putProfile } from './api.js';
import { getSetting, setSetting } from '../db/settings.js';

// The signed-in user's own profile, cached in settings so the header can wear
// the picture instantly (and offline) and a deck's Share can check favorites
// without a round trip. The profile itself lives server-side; this cache is
// written whenever the Profile page saves or loads your own profile, and
// refreshed from the server once per app launch so an edit made on another
// device catches up here.

const KEY = 'ownProfile';
/** Pre-v0.200.11 cache: the avatar alone. Read as a fallback until the first refresh. */
const LEGACY_AVATAR_KEY = 'ownProfileAvatar';

interface Cached {
  username: string;
  profile: UserProfile;
}

type Session = { token: string; username: string } | null | undefined;

const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function rememberOwnProfile(username: string, profile: UserProfile): Promise<void> {
  await setSetting(KEY, { username, profile } satisfies Cached);
}

async function readCached(username: string): Promise<UserProfile | null> {
  const cached = await getSetting<Cached>(KEY);
  if (cached && sameUser(cached.username, username)) return sanitizeProfile(cached.profile);
  if (cached) return null;
  const avatar = sanitizeAvatar(await getSetting(LEGACY_AVATAR_KEY));
  return avatar ? { ...sanitizeProfile(null), avatar } : null;
}

/** Fetch your own profile, cache it, and hand it back. Throws like any API call. */
async function fetchOwnProfile(token: string, username: string): Promise<UserProfile> {
  const res = await getUserProfile(token, username);
  const profile = sanitizeProfile(res.profile);
  await rememberOwnProfile(username, profile);
  return profile;
}

/**
 * Deck ids on your profile's favorites. Trusts the cache when it already lists
 * the deck; otherwise asks the server, since a favorite set on another device
 * since launch would not be in it yet. Offline falls back to the cache.
 */
export async function isFavoriteDeck(session: { token: string; username: string }, deckId: string): Promise<boolean> {
  const has = (p: UserProfile | null) => !!p?.favoriteDecks.some((f) => f.deckId === deckId);
  const cached = await readCached(session.username);
  if (has(cached)) return true;
  try {
    return has(await fetchOwnProfile(session.token, session.username));
  } catch {
    return false;
  }
}

/** One background refresh per app launch (re-armed if it fails or the user changes). */
let refreshedFor: string | null = null;

function useOwnProfile(session: Session): UserProfile | null {
  const username = session?.username;
  const token = session?.token;
  const cached = useLiveQuery(async () => (username ? readCached(username) : null), [username], null);

  useEffect(() => {
    if (!username || !token || refreshedFor === username) return;
    refreshedFor = username;
    getUserProfile(token, username)
      .then(async (res) => {
        const profile = sanitizeProfile(res.profile);
        // Never-saved profile (updatedAt 0): deal a starting picture from the
        // preset list so a new account arrives with a face, not a grey letter.
        // A saved profile is left alone even when its avatar is null: that
        // means the user removed the picture on purpose.
        if (!profile.avatar && res.updatedAt === 0) {
          // Dynamic: the preset list is 16 kB and this runs once per account.
          const { randomAvatarPreset } = await import('./avatarPresets.js');
          const dealt = { ...profile, avatar: randomAvatarPreset() };
          await putProfile(token, dealt);
          await rememberOwnProfile(username, dealt);
          return;
        }
        await rememberOwnProfile(username, profile);
      })
      .catch(() => {
        refreshedFor = null; // offline or server down: try again next launch/sign-in
      });
  }, [username, token]);

  return session ? cached : null;
}

export function useOwnAvatar(session: Session): ProfileAvatar | null {
  return useOwnProfile(session)?.avatar ?? null;
}
