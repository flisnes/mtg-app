import type { TradeLine, WishLine } from '@mtg/shared';
import { getOracleCardsByIds } from './queries.js';
import { db } from './schema.js';

// Self-contained snapshots of the local tradelist/wishlist (lines carry their
// card name so the receiver renders without card-DB lookups). Two consumers:
// answering a trade partner's request (capped at the relay's 500 lines) and
// publishing to an account's Community lists (capped at MAX_PUBLIC_LINES).

/** Snapshot the local tradelist (`quantityForTrade > 0`) as TradeLines. */
export async function readOwnTradelist(cap: number): Promise<TradeLine[]> {
  // Use the quantityForTrade index (this runs on every sync that touches the
  // collection) and cap before the name lookup, so neither scales with the
  // full collection size.
  const entries = (await db.collection.where('quantityForTrade').above(0).toArray()).slice(0, cap);
  const names = await getOracleCardsByIds(entries.map((e) => e.oracleId));
  return entries.map((e) => ({
    oracleId: e.oracleId,
    scryfallId: e.scryfallId,
    name: names.get(e.oracleId)?.name ?? '(unknown card)',
    quantity: e.quantityForTrade,
    condition: e.condition,
    finish: e.finish,
    lang: e.lang,
  }));
}

/** Snapshot the local wishlist as WishLines. */
export async function readOwnWishlist(cap: number): Promise<WishLine[]> {
  const entries = (await db.wishlist.toArray()).slice(0, cap);
  const names = await getOracleCardsByIds(entries.map((e) => e.oracleId));
  return entries.map((e) => ({
    oracleId: e.oracleId,
    scryfallId: e.scryfallId,
    name: names.get(e.oracleId)?.name ?? '(unknown card)',
    quantity: e.quantity,
  }));
}
