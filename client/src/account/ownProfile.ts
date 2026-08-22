import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { sanitizeAvatar, sanitizeProfile, type ProfileAvatar } from '@mtg/shared';
import { getUserProfile, putProfile } from './api.js';
import { randomAvatarPreset } from './avatarPresets.js';
import { getSetting, setSetting } from '../db/settings.js';

// The signed-in user's own profile picture, cached in settings so the header
// can wear it instantly (and offline). The profile itself lives server-side;
// this cache is written whenever the Profile page saves or loads your own
// profile, and refreshed from the server once per app launch so a picture
// changed on another device catches up here.

const KEY = 'ownProfileAvatar';

export async function rememberOwnAvatar(avatar: ProfileAvatar | null): Promise<void> {
  await setSetting(KEY, avatar ?? null);
}

/** One background refresh per app launch (re-armed if it fails or the user changes). */
let refreshedFor: string | null = null;

export function useOwnAvatar(
  session: { token: string; username: string } | null | undefined,
): ProfileAvatar | null {
  const cached = useLiveQuery(
    async () => (await getSetting<ProfileAvatar | null>(KEY)) ?? null,
    [],
    null,
  );

  const username = session?.username;
  const token = session?.token;
  useEffect(() => {
    if (!username || !token || refreshedFor === username) return;
    refreshedFor = username;
    getUserProfile(token, username)
      .then(async (res) => {
        const existing = sanitizeAvatar(res.profile?.avatar);
        // Never-saved profile (updatedAt 0): deal a starting picture from the
        // preset list so a new account arrives with a face, not a grey letter.
        // A saved profile is left alone even when its avatar is null — that
        // means the user removed the picture on purpose.
        if (!existing && res.updatedAt === 0) {
          const avatar = randomAvatarPreset();
          await putProfile(token, { ...sanitizeProfile(res.profile), avatar });
          await rememberOwnAvatar(avatar);
          return;
        }
        await rememberOwnAvatar(existing);
      })
      .catch(() => {
        refreshedFor = null; // offline or server down — try again next launch/sign-in
      });
  }, [username, token]);

  return session ? cached : null;
}
