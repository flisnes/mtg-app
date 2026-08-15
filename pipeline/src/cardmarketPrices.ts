// EUR prices for sealed products, from Cardmarket's own published price guide.
//
// Cardmarket puts a daily price guide on S3 with no key and no OAuth, and
// states open commercial and personal use with no special permissions
// required. That makes it the only usable European sealed price source: their
// REST API's old endpoints now answer 410 Gone, every third-party mirror is
// dead or key-gated, MTGJSON prices singles only, and Scryfall has no sealed
// product object at all.
//
// The file covers every Magic product, singles included (~126k entries,
// ~26 MB), so we look up only the mcmIds the sealed catalog actually named
// rather than filtering the whole thing. `products_nonsingles_1.json` exists to
// tell sealed from singles, but MTGJSON already told us which ids we want, so
// we skip that download entirely.
//
// No CORS header on the bucket, which is why this lives in the pipeline and
// ships as a static artifact rather than being fetched from the browser.

import { USER_AGENT } from './mtgjson.js';

const PRICE_GUIDE_URL = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';
const TIMEOUT_MS = 180_000;

/** One row of the guide. Foil columns exist for singles and are irrelevant here. */
interface CardmarketPriceGuide {
  idProduct: number;
  idCategory: number;
  /** Cardmarket's "Price Trend" — the headline number on a product page. */
  trend?: number | null;
  /** Average of recent sales. */
  avg?: number | null;
  /** Cheapest current listing. */
  low?: number | null;
}

interface PriceGuideFile {
  version?: number;
  createdAt?: string;
  priceGuides?: CardmarketPriceGuide[];
}

export interface CardmarketStats {
  rows: number;
  priced: number;
  wanted: number;
  createdAt: string | null;
}

/**
 * Fetch EUR prices for the given Cardmarket product ids (`identifiers.mcm` on
 * the sealed catalog). Returns mcmId → price.
 */
export async function fetchSealedEurPrices(
  wanted: Set<string>,
): Promise<{ prices: Record<string, number>; stats: CardmarketStats }> {
  const prices: Record<string, number> = {};
  const stats: CardmarketStats = { rows: 0, priced: 0, wanted: wanted.size, createdAt: null };
  if (wanted.size === 0) return { prices, stats };

  const res = await fetch(PRICE_GUIDE_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`price guide HTTP ${res.status}`);
  const file = (await res.json()) as PriceGuideFile;

  const rows = file.priceGuides ?? [];
  stats.rows = rows.length;
  stats.createdAt = file.createdAt ?? null;

  for (const row of rows) {
    const id = String(row.idProduct);
    if (!wanted.has(id)) continue;
    // Trend is what a Cardmarket product page leads with; average and lowest
    // stand in when a product is too thinly traded to have a trend.
    const value = row.trend ?? row.avg ?? row.low;
    if (typeof value === 'number' && value > 0) {
      prices[id] = Math.round(value * 100) / 100;
      stats.priced++;
    }
  }

  return { prices, stats };
}
