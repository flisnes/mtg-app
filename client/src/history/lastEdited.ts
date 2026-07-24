import { db } from '../db/schema.js';

// "Last edited" for the date sorts = the newest entry in a card's History,
// scoped to the exact printing (matching the per-printing History tab). Each
// printing's timeline is its own events plus the oracle's printing-agnostic
// events (any-printing wishes / deck cards, which show on every edition), so
// the sort value is the newest of those two. Reads the whole event log, so
// callers load it only while a date sort is active.

export interface LastEditedIndex {
  /** scryfallId → newest ts among events naming that printing. */
  perPrinting: Map<string, number>;
  /** oracleId → newest ts among that oracle's printing-agnostic events. */
  perOracleWild: Map<string, number>;
  /** oracleId → newest ts among ALL that oracle's events (for "any printing" rows). */
  perOracleAll: Map<string, number>;
}

export async function loadLastEdited(): Promise<LastEditedIndex> {
  const perPrinting = new Map<string, number>();
  const perOracleWild = new Map<string, number>();
  const perOracleAll = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, ts: number) => {
    const cur = m.get(k);
    if (cur === undefined || ts > cur) m.set(k, ts);
  };
  await db.events.each((e) => {
    bump(perOracleAll, e.oracleId, e.ts);
    if (e.scryfallId) bump(perPrinting, e.scryfallId, e.ts);
    else bump(perOracleWild, e.oracleId, e.ts);
  });
  return { perPrinting, perOracleWild, perOracleAll };
}

/**
 * Newest history date for a specific printing. `scryfallId === null` means an
 * "any printing" row (wishlist), which spans the whole oracle. Returns
 * undefined when the card has no events yet.
 */
export function lastEditedFor(idx: LastEditedIndex, oracleId: string, scryfallId: string | null): number | undefined {
  if (!scryfallId) return idx.perOracleAll.get(oracleId);
  const own = idx.perPrinting.get(scryfallId);
  const wild = idx.perOracleWild.get(oracleId);
  if (own === undefined) return wild;
  if (wild === undefined) return own;
  return Math.max(own, wild);
}
