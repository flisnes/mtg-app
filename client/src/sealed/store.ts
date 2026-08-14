import type { CardDbArtifactMeta, CardDbManifest, SealedPriceMap, SealedProduct } from '@mtg/shared';
import { db } from '../db/schema.js';
import { CARD_DB_BASE } from '../cardDb/config.js';
import { getPrefs } from '../prefs.js';
import { sha256Hex } from '../util/sha256.js';

// Sealed products (see sealed-products feature). The pipeline expands MTGJSON
// sealed products into concrete Scryfall printings and ships them as one
// content-addressed artifact (manifest.v2.sealed), with USD market prices in a
// second, much smaller one (manifest.v2.sealedPrices) so the daily price churn
// doesn't re-download the catalog. Unlike the card DB neither is part of the
// startup sync — they're fetched lazily the first time the user opens a sealed
// screen, then cached in IndexedDB and refreshed only when the served hash
// moves. Two cached blob rows in one table, like scan data.

export interface SealedStoreRow {
  key: 'current';
  /** sha256 of the uncompressed JSON — matched against the manifest to detect changes. */
  sha256: string;
  count: number;
  products: SealedProduct[];
}

/** Cached price map, refreshed independently of the catalog above. */
export interface SealedPricesRow {
  key: 'prices';
  sha256: string;
  count: number;
  prices: SealedPriceMap;
}

export type SealedRow = SealedStoreRow | SealedPricesRow;

export type SealedLoad =
  | {
      kind: 'ready';
      products: SealedProduct[];
      /** TCGplayer product id → USD market price. Empty when prices are unavailable. */
      prices: SealedPriceMap;
    }
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

async function fetchVerified(meta: CardDbArtifactMeta): Promise<string> {
  const text = await downloadDecompressed(new URL(meta.url, CARD_DB_BASE!).href);
  if ((await sha256Hex(text)) !== meta.sha256) throw new Error('sealed checksum mismatch: download corrupt');
  return text;
}

async function getCatalog(): Promise<SealedStoreRow | undefined> {
  return (await db.sealed.get('current')) as SealedStoreRow | undefined;
}

async function getPricesRow(): Promise<SealedPricesRow | undefined> {
  return (await db.sealed.get('prices')) as SealedPricesRow | undefined;
}

/**
 * Load the sealed-product catalog for the UI. Refreshes from the manifest when
 * online and the hash has moved, otherwise serves the cached copy. Any
 * network/parse error falls back to whatever is cached; only a total absence of
 * catalog data resolves to 'unavailable' (the UI shows a "not available yet"
 * message). Prices are strictly optional — a priceless catalog is still useful,
 * so a price failure never downgrades the result.
 *
 * The *refresh* follows the card-database download policy, since it's the same
 * kind of spend on the same kind of data. The first download doesn't: the user
 * just opened a sealed screen, and there's nothing to show without it.
 */
export async function loadSealedProducts(): Promise<SealedLoad> {
  const installed = await getCatalog();
  const mayRefresh = !installed || getPrefs().cardDbPolicy !== 'never';
  let products = installed?.products;

  if (CARD_DB_BASE && mayRefresh) {
    try {
      const v2 = (await fetchManifest()).v2;
      const meta = v2?.sealed;
      if (meta && installed?.sha256 !== meta.sha256) {
        const text = await fetchVerified(meta);
        const parsed = JSON.parse(text) as SealedProduct[];
        await db.sealed.put({ key: 'current', sha256: meta.sha256, count: parsed.length, products: parsed });
        products = parsed;
      }
      if (!meta && !installed) return { kind: 'unavailable' };

      // Prices, in their own try: they must not take the catalog down with them.
      try {
        const priceMeta = v2?.sealedPrices;
        const cached = await getPricesRow();
        if (priceMeta && cached?.sha256 !== priceMeta.sha256) {
          const text = await fetchVerified(priceMeta);
          const parsed = JSON.parse(text) as SealedPriceMap;
          await db.sealed.put({
            key: 'prices',
            sha256: priceMeta.sha256,
            count: Object.keys(parsed).length,
            prices: parsed,
          });
        }
      } catch {
        /* keep whatever prices are cached */
      }
    } catch {
      // Offline / manifest or download failure → fall through to cached copy.
    }
  }

  if (!products) return { kind: 'unavailable' };
  return { kind: 'ready', products, prices: (await getPricesRow())?.prices ?? {} };
}
