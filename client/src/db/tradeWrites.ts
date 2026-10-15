import type { Finish, Trade, TradeLine } from '@mtg/shared';
import { db } from './schema.js';
import { getPricesByIds } from '../cardDb/prices.js';
import { acquisitionCents } from '../price/acquisition.js';
import { newEntry } from './collectionWrites.js';
import { copyEvent } from './events.js';
import { collectionKey, entryKey } from './keys.js';
import { removeDeckCardsMatching } from './slotWrites.js';
import { adjustRow, DECK_TABLES, putSynced, write } from './write.js';
import { groupBy, sumQty } from '../util/groupBy.js';

// ---------------------------------------------------------------------------
// Trade completion (beta plan §7). The heart of the app: on `completed`, each
// client atomically updates its own collection/wishlist and writes a Trade
// record. Keyed on the server's sessionId so a re-delivered `completed` is a
// no-op (idempotent).
// ---------------------------------------------------------------------------

/**
 * After a trade removes copies from the collection, take the shortfall out of
 * filing too — but only when there's exactly one place it could have come
 * from. Two identical copies filed in two different containers are
 * deliberately indistinguishable (see usePlacements.ts), so that case is left
 * for the filing-conflict resolver instead of guessing which one is gone.
 */
async function reconcileFilingAfterTrade(line: TradeLine, ownedAfter: number): Promise<void> {
  const slots = await db.deckCards.where('oracleId').equals(line.oracleId).toArray();
  const claiming = slots.filter(
    (s) =>
      !s.anyBasic &&
      s.scryfallId === line.scryfallId &&
      s.condition === line.condition &&
      s.finish === line.finish &&
      s.lang === line.lang,
  );
  if (claiming.length === 0) return;
  const claimed = sumQty(claiming);
  const deficit = claimed - ownedAfter;
  if (deficit <= 0) return; // still enough filed copies to back every claim
  const containerIds = new Set(claiming.map((s) => s.deckId));
  if (containerIds.size !== 1) return; // more than one equally-plausible place — leave for the resolver
  const containerId = claiming[0]!.deckId;
  await removeDeckCardsMatching(containerId, [
    {
      oracleId: line.oracleId,
      scryfallId: line.scryfallId,
      quantity: deficit,
      wants: { condition: line.condition, finish: line.finish, lang: line.lang },
    },
  ]);
}

export async function applyCompletedTrade(
  sessionId: string,
  given: TradeLine[],
  receivedRaw: TradeLine[],
  partner: string | null = null,
): Promise<{ applied: boolean }> {
  // Verify received cards are real (defence against a malicious peer sending
  // fabricated ids). Lines whose oracle card isn't in our card DB are dropped.
  const oracleKnown = await db.oracleCards.bulkGet([...new Set(receivedRaw.map((l) => l.oracleId))]);
  const knownOracles = new Set(oracleKnown.filter(Boolean).map((c) => c!.oracleId));
  const received = receivedRaw.filter((l) => knownOracles.has(l.oracleId));

  // Exit/acquisition prices for the trade's history events, one bulk lookup.
  const prices = await getPricesByIds([...given, ...received].map((l) => l.scryfallId));
  const centsOf = (scryfallId: string, finish: Finish) => acquisitionCents(prices.get(scryfallId), finish);

  // DECK_TABLES in full, not a hand-picked subset: reconcileFilingAfterTrade
  // opens a nested DECK_TABLES transaction, and Dexie aborts the whole trade if
  // that names a table this one doesn't (v0.158.0 added deckBehaviors and every
  // trade giving away a filed card silently rolled back).
  return write([...DECK_TABLES, db.wishlist, db.trades], async (ctx) => {
    if (await db.trades.get(sessionId)) return { applied: false }; // already applied
    const tradeExtra = { source: 'trade' as const, tradeId: sessionId };

    const entries = await db.collection.toArray();
    // Two indexes, because a trade line says what a card IS and nothing about
    // whether the cardboard is signed or altered:
    //  - byKey: full row identity. What a received card merges into, so a plain
    //    copy coming in lands on your plain row, never on your altered one.
    //  - byCopy: rows per copy identity, ordinary copies first. What a given card
    //    comes out of — the plain one goes across the table, and an annotated row
    //    is only touched when it's the only copy of that card you have.
    const byKey = new Map(entries.map((e) => [entryKey(e), e]));
    const byCopy = groupBy(entries, collectionKey);
    byCopy.forEach((list) => list.sort((a, b) => (a.special?.length ? 1 : 0) - (b.special?.length ? 1 : 0)));
    const { now } = ctx;

    // Remove given cards (decrement matching entries; reduce trade qty with them).
    for (const line of given) {
      const copies = byCopy.get(collectionKey(line)) ?? [];
      const ex = copies[0];
      const ownedQty = ex?.quantity ?? 0;
      const finalOwned = ex ? Math.max(0, ex.quantity - line.quantity) : 0;
      if (ex) {
        const next = await adjustRow('collection', ex, finalOwned - ex.quantity, now);
        if (next) {
          Object.assign(ex, next);
        } else {
          byKey.delete(entryKey(ex));
          copies.shift();
        }
      }
      await reconcileFilingAfterTrade(line, finalOwned);
      // You can't give away what the ledger never recorded you owning. If the
      // trade hands over more copies than the collection held, backfill the
      // shortfall as an acquisition first — a history-only add (no row written;
      // it nets against the removal below) so the card reads "added, then traded
      // away" instead of a lone, dangling "traded away". ts is a hair earlier so
      // it sorts before the removal in the timeline.
      const missing = line.quantity - ownedQty;
      const copy = { ...line, special: undefined };
      const priceEurCents = centsOf(line.scryfallId, line.finish);
      if (missing > 0) {
        ctx.emit(copyEvent('collection.add', copy, missing, now, { priceEurCents, ...tradeExtra, reconcile: true }));
      }
      // The event records the full traded quantity even when the card was
      // never registered (or under-registered) in the collection — the trade
      // happened either way, and the card history should say so.
      const ts = missing > 0 ? now + 1 : now;
      ctx.emit(copyEvent('collection.remove', copy, line.quantity, ts, { priceEurCents, reason: 'traded', ...tradeExtra }));
    }

    // Add received cards (merge on the same compound key).
    for (const line of received) {
      const copy = { ...line, lang: line.lang || 'en', special: undefined };
      const ex = byKey.get(entryKey(line));
      const next = await adjustRow('collection', ex, line.quantity, now, (q) => newEntry(copy, q, 0, now));
      if (ex) Object.assign(ex, next);
      else byKey.set(entryKey(next!), next!);
      ctx.emit(
        copyEvent('collection.add', copy, line.quantity, now, {
          priceEurCents: centsOf(line.scryfallId, line.finish),
          ...tradeExtra,
        }),
      );
    }

    // Prune wishlist by received cards (any printing of the oracle card).
    for (const line of received) {
      let toRemove = line.quantity;
      const wl = await db.wishlist.where('oracleId').equals(line.oracleId).toArray();
      for (const w of wl) {
        if (toRemove <= 0) break;
        const dec = Math.min(w.quantity, toRemove);
        toRemove -= dec;
        await adjustRow('wishlist', w, -dec, now);
        ctx.emit({ ts: now, kind: 'wish.fulfilled', oracleId: line.oracleId, scryfallId: line.scryfallId, qty: dec, ...tradeExtra });
      }
    }

    const trade: Trade = { id: sessionId, completedAt: now, partner, given, received };
    await putSynced('trades', trade);
    return { applied: true };
  });
}
