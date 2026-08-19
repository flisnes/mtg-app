// The card-image cache: how many Scryfall images this device keeps, roughly what
// that costs in storage, and pruning oldest-first when the budget shrinks.
//
// The service worker does the caching (vite.config.ts runtimeCaching, cache name
// 'scryfall-images') through Workbox's ExpirationPlugin. Its maxEntries is baked
// into the generated worker at build time, so it can't *be* the user's setting —
// it is the hard ceiling (IMAGE_CACHE_CEILING) instead, and the user's lower
// budget is enforced from here: on boot, when they hit Save, and on a slow timer
// while the app is open. Between passes the cache can drift a little over
// budget; the next pass pulls it back.

import { getPrefs } from '../prefs.js';

/** Runtime cache the service worker files Scryfall imagery under. */
export const CARD_IMAGE_CACHE = 'scryfall-images';

/** Ceiling for the user's budget. Keep in sync with maxEntries in vite.config.ts. */
export const IMAGE_CACHE_CEILING = 10_000;
export const IMAGE_CACHE_MIN = 100;
export const IMAGE_CACHE_STEP = 100;
/** What the worker capped at before this was a setting, so nothing changes on upgrade. */
export const IMAGE_CACHE_DEFAULT = 3000;

// Scryfall serves a handful of fixed image sizes, and the size lives in the URL
// path (.../small/3/a/....jpg). Bodies can't be measured: the images are fetched
// no-cors by <img>, and an opaque response reads back as an empty blob. So price
// each entry by its size class instead — typical bytes, eyeballed across sets.
const BYTES_BY_SIZE: Record<string, number> = {
  small: 28_000,
  normal: 110_000,
  large: 210_000,
  border_crop: 130_000,
  art_crop: 60_000,
  png: 1_000_000,
};

/** The app's own mix (grids ask for `small`, the card sheet for `normal`). */
const DEFAULT_IMAGE_BYTES = 45_000;

export interface ImageCacheStats {
  /** Images cached right now. */
  count: number;
  /** Their estimated total bytes. */
  bytes: number;
  /** Estimated bytes per image, from the mix actually cached. */
  avgBytes: number;
}

function bytesForUrl(url: string): number {
  // Second path segment for backs.scryfall.io/normal/…, first for cards.scryfall.io.
  for (const part of new URL(url).pathname.split('/')) {
    const known = BYTES_BY_SIZE[part];
    if (known) return known;
  }
  return DEFAULT_IMAGE_BYTES;
}

export function clampImageCacheLimit(n: number): number {
  if (!Number.isFinite(n)) return IMAGE_CACHE_DEFAULT;
  return Math.min(IMAGE_CACHE_CEILING, Math.max(IMAGE_CACHE_MIN, Math.round(n)));
}

/** Human-readable byte count. MB is the unit that matters here; GB past 1000. */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

async function openImageCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    // open() would create the cache if the worker hasn't yet; harmless, and it
    // keeps this a single call whether or not anything has been cached.
    return await caches.open(CARD_IMAGE_CACHE);
  } catch {
    return null; // storage blocked (private mode, no secure context)
  }
}

/** What's cached now, and what it's costing. Cheap: reads keys, never bodies. */
export async function imageCacheStats(): Promise<ImageCacheStats> {
  const cache = await openImageCache();
  if (!cache) return { count: 0, bytes: 0, avgBytes: DEFAULT_IMAGE_BYTES };
  const keys = await cache.keys();
  let bytes = 0;
  for (const req of keys) bytes += bytesForUrl(req.url);
  return {
    count: keys.length,
    bytes,
    avgBytes: keys.length ? Math.round(bytes / keys.length) : DEFAULT_IMAGE_BYTES,
  };
}

/** Storage a budget of `limit` images would take, priced off the mix cached now. */
export function projectImageCacheBytes(limit: number, stats: ImageCacheStats | null): number {
  return clampImageCacheLimit(limit) * (stats?.avgBytes ?? DEFAULT_IMAGE_BYTES);
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

// Workbox keeps a timestamp per cached entry in its own IndexedDB database
// (workbox-expiration, store 'cache-entries', id `${cacheName}|${url}`). Reading
// it is how we know which images are oldest. Opening at version 1 with the same
// schema Workbox creates means it doesn't matter who gets there first; if Workbox
// ever moves to version 2 the open fails and we fall back to Cache API insertion
// order, which for a cache-first route is close enough to oldest-first anyway.
const TIMESTAMP_DB = 'workbox-expiration';
const TIMESTAMP_STORE = 'cache-entries';

function openTimestampDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(TIMESTAMP_DB, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(TIMESTAMP_STORE)) return;
      const store = db.createObjectStore(TIMESTAMP_STORE, { keyPath: 'id' });
      store.createIndex('cacheName', 'cacheName', { unique: false });
      store.createIndex('timestamp', 'timestamp', { unique: false });
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TIMESTAMP_STORE)) {
        db.close();
        resolve(null);
        return;
      }
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function entryId(url: string): string {
  const u = new URL(url, location.href);
  u.hash = '';
  return `${CARD_IMAGE_CACHE}|${u.href}`;
}

/** id → timestamp for this cache's entries. Empty map if the database isn't there. */
async function readTimestamps(db: IDBDatabase): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    const found = new Map<string, number>();
    try {
      const req = db.transaction(TIMESTAMP_STORE, 'readonly').objectStore(TIMESTAMP_STORE).getAll();
      req.onsuccess = () => {
        for (const row of req.result as { id: string; cacheName: string; timestamp: number }[]) {
          if (row?.cacheName === CARD_IMAGE_CACHE) found.set(row.id, row.timestamp);
        }
        resolve(found);
      };
      req.onerror = () => resolve(found);
    } catch {
      resolve(found);
    }
  });
}

function deleteTimestamps(db: IDBDatabase, ids: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(TIMESTAMP_STORE, 'readwrite');
      const store = tx.objectStore(TIMESTAMP_STORE);
      for (const id of ids) store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Trims the image cache down to `limit`, oldest first. Returns how many images
 * were dropped. A no-op when the cache is already within budget.
 */
export async function pruneImageCache(limit: number): Promise<number> {
  const cap = clampImageCacheLimit(limit);
  const cache = await openImageCache();
  if (!cache) return 0;
  const keys = await cache.keys();
  const excess = keys.length - cap;
  if (excess <= 0) return 0;

  const db = await openTimestampDb();
  const stamps = db ? await readTimestamps(db) : new Map<string, number>();

  // Oldest first. Untracked entries (no timestamp) sort by cache insertion
  // order, which is the order keys() hands them back.
  const ordered = keys
    .map((request, index) => ({ request, index, at: stamps.get(entryId(request.url)) }))
    .sort((a, b) => {
      if (a.at !== undefined && b.at !== undefined) return a.at - b.at;
      if (a.at === undefined && b.at !== undefined) return -1;
      if (a.at !== undefined && b.at === undefined) return 1;
      return a.index - b.index;
    });

  const doomed = ordered.slice(0, excess);
  let removed = 0;
  for (const { request } of doomed) {
    if (await cache.delete(request).catch(() => false)) removed++;
  }
  if (db) {
    await deleteTimestamps(
      db,
      doomed.map((d) => entryId(d.request.url)),
    );
    db.close();
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Upkeep
// ---------------------------------------------------------------------------

/** The user's budget, clamped to what the service worker can actually hold. */
export function getImageCacheLimit(): number {
  return clampImageCacheLimit(getPrefs().imageCacheLimit);
}

/** Prunes to the current budget. Safe to call whenever. */
export async function enforceImageCacheLimit(): Promise<number> {
  return pruneImageCache(getImageCacheLimit()).catch(() => 0);
}

const UPKEEP_INTERVAL_MS = 5 * 60 * 1000;
let upkeepStarted = false;

/**
 * Keeps the cache near budget while the app is open: once at boot, then on a
 * slow timer, since the service worker only knows about the build-time ceiling.
 */
export function startImageCacheUpkeep(): void {
  if (upkeepStarted) return;
  upkeepStarted = true;
  void enforceImageCacheLimit();
  setInterval(() => {
    if (document.visibilityState === 'visible') void enforceImageCacheLimit();
  }, UPKEEP_INTERVAL_MS);
}
