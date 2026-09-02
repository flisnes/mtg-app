import type { TradeLine, WishLine } from '@mtg/shared';
import { collectionKey } from './dataAccess.js';
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
  // A TradeLine says what a card is, and special conditions aren't part of that
  // (nor of the protocol) — so an altered copy and a plain one of the same
  // printing and grade are two rows here but one line to the partner. Merged
  // rather than sent twice: two identical lines read as a bug on their board.
  const byKey = new Map<string, TradeLine>();
  for (const e of entries) {
    const key = collectionKey(e);
    const ex = byKey.get(key);
    if (ex) {
      ex.quantity += e.quantityForTrade;
      continue;
    }
    byKey.set(key, {
      oracleId: e.oracleId,
      scryfallId: e.scryfallId,
      name: names.get(e.oracleId)?.name ?? '(unknown card)',
      quantity: e.quantityForTrade,
      condition: e.condition,
      finish: e.finish,
      lang: e.lang,
    });
  }
  return [...byKey.values()];
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
    // Optional preferences (undefined = "any") ride along so partners see, and
    // matching respects, a wish for a specific finish/condition/language.
    condition: e.condition,
    finish: e.finish,
    lang: e.lang,
  }));
}
