import { db } from './schema.js';

// Typed key/value settings persisted in IndexedDB. Keys used so far:
//   cardDbVersion   — installed card-data version (manifest v2 dataVersion)
//   cardDbUpdatedAt — Scryfall bulk timestamp, shown on the About screen
//   cardDbChunks    — per-chunk {sha256, count} bookkeeping for delta updates
//   cardDbCounts    — expected row counts (integrity check at launch)
//   pricesSha256    — installed prices-artifact hash (compared to manifest)
//   pricesUpdatedAt — ISO date shown as "prices updated <date>"

export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const row = await db.settings.get(key);
  return row?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
