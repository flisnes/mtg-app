// USD market prices for sealed products, from TCGCSV (tcgcsv.com) — a daily
// keyless mirror of the TCGplayer catalog. We need it because neither of our
// existing price sources covers sealed: MTGJSON's price feed is singles-only
// (mtgjson/mtgjson#928, still open) and Scryfall has no sealed product object
// at all. Cardmarket publishes a keyless EUR dump too, but it sends no CORS
// header and its redistribution terms are unread, so EUR waits.
//
// TCGCSV's stated rules: identify yourself with a real User-Agent, at most one
// pass per day, and space requests out. We walk every Magic group (~900) once
// per build with a small gap between calls, which lands well inside them.
//
// Best-effort throughout: a price outage must not fail the nightly card-DB
// build. Every failure is counted and skipped, and a completely empty result
// simply means the manifest ships without a sealedPrices artifact.

import type { SealedPriceMap } from '@mtg/shared';
import { USER_AGENT } from './mtgjson.js';

/** Category 1 is Magic; groups are its sets. */
const BASE = 'https://tcgcsv.com/tcgplayer/1';
/** Politeness gap between group fetches. */
const GAP_MS = 120;
const TIMEOUT_MS = 20_000;

interface TcgGroup {
  groupId: number;
}
interface TcgPrice {
  productId: number;
  marketPrice: number | null;
  midPrice: number | null;
}
interface TcgEnvelope<T> {
  success?: boolean;
  results?: T[];
}

export interface SealedPriceStats {
  groups: number;
  groupsFailed: number;
  priced: number;
  wanted: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fetch USD market prices for the given TCGplayer product ids. `wanted` is the
 * set of `identifiers.tcgplayer` values from the sealed catalog; everything
 * else TCGCSV returns (every single card ever printed, mostly) is discarded.
 */
export async function fetchSealedUsdPrices(
  wanted: Set<string>,
): Promise<{ prices: SealedPriceMap; stats: SealedPriceStats }> {
  const prices: SealedPriceMap = {};
  const stats: SealedPriceStats = { groups: 0, groupsFailed: 0, priced: 0, wanted: wanted.size };
  if (wanted.size === 0) return { prices, stats };

  const groups = (await getJson<TcgEnvelope<TcgGroup>>(`${BASE}/groups`)).results ?? [];
  stats.groups = groups.length;
  console.log(`[pipeline] tcgcsv: ${groups.length} groups to scan for ${wanted.size} sealed products`);

  for (const [i, group] of groups.entries()) {
    try {
      const rows = (await getJson<TcgEnvelope<TcgPrice>>(`${BASE}/${group.groupId}/prices`)).results ?? [];
      for (const row of rows) {
        const id = String(row.productId);
        if (!wanted.has(id) || prices[id] !== undefined) continue;
        // Market price is what a copy actually changes hands for; mid is the
        // midpoint of current listings and only stands in when nothing has sold.
        const value = row.marketPrice ?? row.midPrice;
        if (typeof value === 'number' && value > 0) {
          prices[id] = Math.round(value * 100) / 100;
          stats.priced++;
        }
      }
    } catch (e) {
      stats.groupsFailed++;
      if (stats.groupsFailed <= 5) console.warn(`[pipeline] tcgcsv group ${group.groupId} failed: ${(e as Error).message}`);
    }
    if (i % 100 === 99) console.log(`[pipeline] tcgcsv ${i + 1}/${groups.length} groups, ${stats.priced} priced…`);
    await sleep(GAP_MS);
  }

  return { prices, stats };
}
