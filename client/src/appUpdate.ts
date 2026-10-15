import type { CardDbManifest } from '@mtg/shared';
import { APP_VERSION } from './version.js';

// Server version beacon (beta plan §3.1). The card-DB manifest carries
// `latestAppVersion`; comparing it to the embedded build version lets an
// outdated install learn about an update even when the service worker hasn't
// noticed yet (iOS checks lazily). The SW still performs the actual update.
// No fetch of its own: it reads whatever manifest the card-DB update check
// fetched (cardDb/manifest.ts onManifest), on launch and on every return to the
// foreground.

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
export function advertisesUpdate(manifest: CardDbManifest): boolean {
  return isNewer(manifest.latestAppVersion, APP_VERSION);
}
