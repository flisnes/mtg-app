import type { CardDbArtifactMeta, CardDbManifest, SealedProduct } from '@mtg/shared';
import { db } from '../db/schema.js';
import { CARD_DB_BASE } from '../cardDb/config.js';
import { sha256Hex } from '../util/sha256.js';

// Sealed products (see sealed-products feature). The pipeline expands MTGJSON
// sealed products into concrete Scryfall printings and ships them as one
// content-addressed artifact (manifest.v2.sealed). Unlike the card DB this is
// NOT part of the startup sync — it's fetched lazily the first time the user
// opens "Add sealed product", then cached in IndexedDB and refreshed only when
// the served hash moves. One cached blob row (keyed 'current'), like scan data.

export interface SealedStoreRow {
  key: 'current';
  /** sha256 of the uncompressed JSON — matched against the manifest to detect changes. */
  sha256: string;
  count: number;
  products: SealedProduct[];
}

export type SealedLoad =
  | { kind: 'ready'; products: SealedProduct[] }
  /** No endpoint, the build has no sealed artifact, or we're offline with nothing cached. */
  | { kind: 'unavailable' };

async function fetchManifest(): Promise<CardDbManifest> {
  const res = await fetch(new URL('manifest.json', CARD_DB_BASE!).href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return (await res.json()) as CardDbManifest;
}

/** Fetch a .gz artifact and return the decompressed text (platform DecompressionStream). */
async function downloadDecompressed(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`sealed download HTTP ${res.status}`);
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  return await new Response(res.body.pipeThrough(gunzip)).text();
}

async function download(meta: CardDbArtifactMeta): Promise<SealedStoreRow> {
  const text = await downloadDecompressed(new URL(meta.url, CARD_DB_BASE!).href);
  if ((await sha256Hex(text)) !== meta.sha256) throw new Error('sealed checksum mismatch: download corrupt');
  const products = JSON.parse(text) as SealedProduct[];
  const row: SealedStoreRow = { key: 'current', sha256: meta.sha256, count: products.length, products };
  await db.sealed.put(row);
  return row;
}

/**
 * Load the sealed-product catalog for the UI. Refreshes from the manifest when
 * online and the hash has moved, otherwise serves the cached copy. Any
 * network/parse error falls back to whatever is cached; only a total absence of
 * data resolves to 'unavailable' (the UI shows a "not available yet" message).
 */
export async function loadSealedProducts(): Promise<SealedLoad> {
  const installed = await db.sealed.get('current');

  if (CARD_DB_BASE) {
    try {
      const meta = (await fetchManifest()).v2?.sealed;
      if (meta && installed?.sha256 !== meta.sha256) {
        const row = await download(meta);
        return { kind: 'ready', products: row.products };
      }
      if (!meta && !installed) return { kind: 'unavailable' };
    } catch {
      // Offline / manifest or download failure → fall through to cached copy.
    }
  }

  if (installed) return { kind: 'ready', products: installed.products };
  return { kind: 'unavailable' };
}
