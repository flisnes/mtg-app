import type { CardDbArtifactMeta, CardDbManifest, SetTypeMap } from '@mtg/shared';
import { PROMO_SET_TYPES } from '@mtg/shared';
import { db } from '../db/schema.js';
import { sha256Hex } from '../util/sha256.js';
import { CARD_DB_BASE } from './config.js';

// Set code → Scryfall set_type, the signal that tells a normal release from a
// promo product, Secret Lair, token sheet or memorabilia set. The slim card
// rows deliberately don't carry it (it's per-set, not per-card), so it ships as
// its own tiny artifact — a few KB for every set ever printed.
//
// Same lifecycle as the sealed catalog (sealed/store.ts): not part of the
// startup sync, fetched the first time something needs it, cached in one
// IndexedDB row, refreshed only when the served hash moves. Everything here is
// best-effort — with no map the caller falls back to the plain latest printing.

export interface SetTypesRow {
  key: 'current';
  /** sha256 of the uncompressed JSON, matched against the manifest. */
  sha256: string;
  types: SetTypeMap;
}

async function fetchManifest(): Promise<CardDbManifest> {
  const res = await fetch(new URL('manifest.json', CARD_DB_BASE!).href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return (await res.json()) as CardDbManifest;
}

async function download(meta: CardDbArtifactMeta): Promise<SetTypesRow> {
  const res = await fetch(new URL(meta.url, CARD_DB_BASE!).href, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`set-types download HTTP ${res.status}`);
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const text = await new Response(res.body.pipeThrough(gunzip)).text();
  if ((await sha256Hex(text)) !== meta.sha256) throw new Error('set-types checksum mismatch: download corrupt');
  const row: SetTypesRow = { key: 'current', sha256: meta.sha256, types: JSON.parse(text) as SetTypeMap };
  await db.setTypes.put(row);
  return row;
}

// Held in memory once loaded: the promo check runs per printing, per search
// result, so it must not hit IndexedDB each time.
let cached: SetTypeMap | null = null;
let inFlight: Promise<SetTypeMap | null> | null = null;

/**
 * The set-type map, or null when we've never managed to get one. Refreshes when
 * online and the hash has moved; any failure falls back to the cached copy.
 */
export async function loadSetTypes(): Promise<SetTypeMap | null> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const installed = await db.setTypes.get('current');
    if (CARD_DB_BASE) {
      try {
        const meta = (await fetchManifest()).v2?.sets;
        if (meta && installed?.sha256 !== meta.sha256) {
          cached = (await download(meta)).types;
          return cached;
        }
      } catch {
        // Offline / older build with no sets artifact → use whatever is cached.
      }
    }
    cached = installed?.types ?? null;
    return cached;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** The map if it's already in memory, without touching the network or IndexedDB. */
export function getLoadedSetTypes(): SetTypeMap | null {
  return cached;
}

/**
 * Is this printing a promo rather than a normal-set card? Checks the per-card
 * `promo` flag first, then the set's type. An unknown set counts as normal — see
 * PROMO_SET_TYPES on why the safe failure is "show a real printing".
 */
export function isPromoPrinting(p: { set: string; promo?: boolean }, types: SetTypeMap | null): boolean {
  if (p.promo) return true;
  const t = types?.[p.set];
  return t ? PROMO_SET_TYPES.has(t) : false;
}
