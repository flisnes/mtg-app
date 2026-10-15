import type { CardDbManifest } from '@mtg/shared';
import { CARD_DB_BASE } from './config.js';

// The one place that fetches manifest.json. The card-DB sync, the version
// beacon, the tag vocabulary, the set-type map and the sealed catalog all read
// it, and on a launch they used to ask for it five to seven times in a row.
// Now they share one request: the promise is kept for a minute, so everything a
// launch or a return to the foreground kicks off rides on the same answer.
//
// `no-cache` rather than `no-store`: the browser still revalidates every time,
// but an unchanged manifest comes back as a 304 instead of the whole file.

const FRESH_MS = 60_000;

let pending: { at: number; promise: Promise<CardDbManifest> } | null = null;
let latest: CardDbManifest | null = null;
const listeners = new Set<(m: CardDbManifest) => void>();

/**
 * The served manifest, shared with any other caller from the last minute.
 * `fresh` skips the shared answer (Settings' "Check now"). Throws when there is
 * no card-DB endpoint or the request fails; a failure is not remembered.
 */
export function getManifest(fresh = false): Promise<CardDbManifest> {
  if (!CARD_DB_BASE) return Promise.reject(new Error('no card DB endpoint'));
  if (!fresh && pending && Date.now() - pending.at < FRESH_MS) return pending.promise;

  const promise = (async () => {
    const res = await fetch(new URL('manifest.json', CARD_DB_BASE).href, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const manifest = (await res.json()) as CardDbManifest;
    latest = manifest;
    for (const l of listeners) l(manifest);
    return manifest;
  })();
  const entry = { at: Date.now(), promise };
  pending = entry;
  promise.catch(() => {
    if (pending === entry) pending = null;
  });
  return promise;
}

/**
 * Hear about every manifest fetched, whoever asked for it, starting with the
 * last one if there is one. The version beacon listens here instead of
 * fetching on its own schedule.
 */
export function onManifest(listener: (m: CardDbManifest) => void): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => {
    listeners.delete(listener);
  };
}
