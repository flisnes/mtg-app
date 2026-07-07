import type { CardDbManifest } from '@mtg/shared';
import { CARD_DB_BASE } from './cardDb/config.js';
import { APP_VERSION } from './version.js';

// Server version beacon (beta plan §3.1). The card-DB manifest carries
// `latestAppVersion`; comparing it to the embedded build version lets an
// outdated install learn about an update even when the service worker hasn't
// noticed yet (iOS checks lazily). The SW still performs the actual update.

function parse(v: string): number[] {
  return v.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** True if the served manifest advertises a newer app version than this build. */
export async function isUpdateAvailable(): Promise<boolean> {
  if (!CARD_DB_BASE) return false;
  try {
    const res = await fetch(new URL('manifest.json', CARD_DB_BASE).href, { cache: 'no-store' });
    if (!res.ok) return false;
    const manifest = (await res.json()) as CardDbManifest;
    return isNewer(manifest.latestAppVersion, APP_VERSION);
  } catch {
    return false;
  }
}
