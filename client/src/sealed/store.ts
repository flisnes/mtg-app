import type { CardDbArtifactMeta, CardDbManifest, SealedBoosterMap, SealedPriceMap, SealedProduct } from '@mtg/shared';
import { db } from '../db/schema.js';
import { CARD_DB_BASE } from '../cardDb/config.js';
import { getManifest } from '../cardDb/manifest.js';
import { fetchArtifactText } from '../cardDb/artifact.js';
import { getPrefs } from '../prefs.js';

// Sealed products (see sealed-products feature). The pipeline expands MTGJSON
// sealed products into concrete Scryfall printings and ships them as one
// content-addressed artifact (manifest.v2.sealed), with USD market prices in a
// second, much smaller one (manifest.v2.sealedPrices) so the daily price churn
// doesn't re-download the catalog. Unlike the card DB neither is part of the
// startup sync — they're fetched lazily the first time the user opens a sealed
// screen, then cached in IndexedDB and refreshed only when the served hash
// moves. Cached blob rows in one table, like scan data; a third artifact,
// what each booster type can contain, rides along with the catalog.

interface SealedStoreRow {
  key: 'current';
  /** sha256 of the uncompressed JSON — matched against the manifest to detect changes. */
  sha256: string;
  count: number;
  products: SealedProduct[];
}

/** Cached price map, refreshed independently of the catalog above. */
interface SealedPricesRow {
  key: 'prices';
  sha256: string;
  count: number;
  prices: SealedPriceMap;
}

/** Cached booster contents, refreshed alongside the catalog. */
interface SealedBoostersRow {
  key: 'boosters';
  sha256: string;
  count: number;
  boosters: SealedBoosterMap;
}

export type SealedRow = SealedStoreRow | SealedPricesRow | SealedBoostersRow;

type SealedLoad =
  | {
      kind: 'ready';
      products: SealedProduct[];
      /** TCGplayer product id → USD market price. Empty when prices are unavailable. */
      prices: SealedPriceMap;
      /** What each booster type can contain. Empty on builds that don't ship it. */
      boosters: SealedBoosterMap;
    }
  /** No endpoint, the build has no sealed artifact, or we're offline with nothing cached. */
  | { kind: 'unavailable' };

const fetchVerified = (meta: CardDbArtifactMeta) => fetchArtifactText(meta, 'sealed');

// The catalog row is multi-megabyte and changes only when its hash moves, so
// it's read from IndexedDB once per session and the copy reused until a put.
let catalogRead: Promise<SealedStoreRow | undefined> | null = null;

function getCatalog(): Promise<SealedStoreRow | undefined> {
  catalogRead ??= (db.sealed.get('current') as Promise<SealedStoreRow | undefined>).catch((e: unknown) => {
    catalogRead = null;
    throw e;
  });
  return catalogRead;
}

async function getPricesRow(): Promise<SealedPricesRow | undefined> {
  return (await db.sealed.get('prices')) as SealedPricesRow | undefined;
}

/**
 * The price map as cached, no network. Safe inside a live query: the startup
 * reading (price/sealedTracking.ts) refreshes the row, and that put re-runs it.
 */
export async function getCachedSealedPrices(): Promise<SealedPriceMap> {
  return (await getPricesRow())?.prices ?? {};
}

async function getBoostersRow(): Promise<SealedBoostersRow | undefined> {
  return (await db.sealed.get('boosters')) as SealedBoostersRow | undefined;
}

/** Bring the cached booster contents up to the manifest's hash. Never throws, like prices. */
async function syncBoosters(v2: CardDbManifest['v2']): Promise<void> {
  try {
    const meta = v2?.sealedBoosters;
    if (meta && (await getBoostersRow())?.sha256 !== meta.sha256) {
      const parsed = JSON.parse(await fetchVerified(meta)) as SealedBoosterMap;
      await db.sealed.put({ key: 'boosters', sha256: meta.sha256, count: Object.keys(parsed).length, boosters: parsed });
    }
  } catch {
    /* keep whatever is cached */
  }
}

/**
 * Bring the cached price map up to the manifest's hash and return the best
 * prices we have. Never throws: prices are decoration on the catalog and the
 * whole point of the daily value reading is that a stale one still beats none.
 */
async function syncPrices(v2: CardDbManifest['v2']): Promise<SealedPriceMap> {
  const cached = await getPricesRow();
  try {
    const meta = v2?.sealedPrices;
    if (meta && cached?.sha256 !== meta.sha256) {
      const parsed = JSON.parse(await fetchVerified(meta)) as SealedPriceMap;
      await db.sealed.put({ key: 'prices', sha256: meta.sha256, count: Object.keys(parsed).length, prices: parsed });
      return parsed;
    }
  } catch {
    /* keep whatever prices are cached */
  }
  return cached?.prices ?? {};
}

/**
 * Just the prices, refreshed. The daily value reading (price/sealedTracking.ts)
 * runs at startup and must not drag the multi-megabyte catalog down with it —
 * the price artifact is small, and owning a box already means the catalog was
 * installed at some point. Falls back to the cached map when offline.
 */
export async function refreshSealedPrices(): Promise<SealedPriceMap> {
  const cached = await getPricesRow();
  if (CARD_DB_BASE && (!cached || getPrefs().cardDbPolicy !== 'never')) {
    try {
      return await syncPrices((await getManifest()).v2);
    } catch {
      /* offline / no manifest → whatever is cached */
    }
  }
  return cached?.prices ?? {};
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
      const v2 = (await getManifest()).v2;
      const meta = v2?.sealed;
      if (meta && installed?.sha256 !== meta.sha256) {
        const text = await fetchVerified(meta);
        const parsed = JSON.parse(text) as SealedProduct[];
        await db.sealed.put({ key: 'current', sha256: meta.sha256, count: parsed.length, products: parsed });
        catalogRead = null;
        products = parsed;
      }
      if (!meta && !installed) return { kind: 'unavailable' };

      // Prices and boosters swallow their own failures, so they can't take the catalog down.
      await Promise.all([syncPrices(v2), syncBoosters(v2)]);
    } catch {
      // Offline / manifest or download failure → fall through to cached copy.
    }
  }

  if (!products) return { kind: 'unavailable' };
  const [pricesRow, boostersRow] = await Promise.all([getPricesRow(), getBoostersRow()]);
  return { kind: 'ready', products, prices: pricesRow?.prices ?? {}, boosters: boostersRow?.boosters ?? {} };
}
