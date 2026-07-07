import type { OracleCard, Printing } from '@mtg/shared';
import { db } from './schema.js';

// Read queries against the card DB, for joining user data (which stores only
// ids) with display data (names, images, sets, prices). Views use these via
// dexie-react-hooks useLiveQuery for reactivity.

export async function getOracleCard(oracleId: string): Promise<OracleCard | undefined> {
  return db.oracleCards.get(oracleId);
}

export async function getPrinting(scryfallId: string): Promise<Printing | undefined> {
  return db.printings.get(scryfallId);
}

/** All printings of a functional card, newest first (for the edition picker). */
export async function getPrintingsForOracle(oracleId: string): Promise<Printing[]> {
  const printings = await db.printings.where('oracleId').equals(oracleId).toArray();
  printings.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  return printings;
}

export async function getOracleCardsByIds(ids: Iterable<string>): Promise<Map<string, OracleCard>> {
  const unique = [...new Set(ids)];
  const cards = await db.oracleCards.bulkGet(unique);
  const map = new Map<string, OracleCard>();
  cards.forEach((c) => {
    if (c) map.set(c.oracleId, c);
  });
  return map;
}

export async function getPrintingsByIds(ids: Iterable<string>): Promise<Map<string, Printing>> {
  const unique = [...new Set(ids)];
  const printings = await db.printings.bulkGet(unique);
  const map = new Map<string, Printing>();
  printings.forEach((p) => {
    if (p) map.set(p.scryfallId, p);
  });
  return map;
}

/** Total owned copies per oracleId (summed across all printings), for deck ownership. */
export async function getOwnedCountsFor(oracleIds: Iterable<string>): Promise<Map<string, number>> {
  const unique = [...new Set(oracleIds)];
  const entries = await db.collection.where('oracleId').anyOf(unique).toArray();
  const map = new Map<string, number>();
  for (const e of entries) map.set(e.oracleId, (map.get(e.oracleId) ?? 0) + e.quantity);
  return map;
}

export interface MissingCard {
  oracleId: string;
  name: string;
  addQty: number;
}

/**
 * Cards this deck needs that aren't fully owned and aren't already on the
 * wishlist (beta plan §6). addQty = needed − owned, aggregated per oracle card
 * across boards.
 */
export async function computeDeckWishlistCandidates(deckId: string): Promise<MissingCard[]> {
  const deckCards = await db.deckCards.where('deckId').equals(deckId).toArray();
  const needed = new Map<string, number>();
  for (const dc of deckCards) needed.set(dc.oracleId, (needed.get(dc.oracleId) ?? 0) + dc.quantity);

  const oracleIds = [...needed.keys()];
  const [owned, wishlist, oracleMap] = await Promise.all([
    getOwnedCountsFor(oracleIds),
    db.wishlist.where('oracleId').anyOf(oracleIds).toArray(),
    getOracleCardsByIds(oracleIds),
  ]);
  const wishlisted = new Set(wishlist.map((w) => w.oracleId));

  const out: MissingCard[] = [];
  for (const [oracleId, need] of needed) {
    if (wishlisted.has(oracleId)) continue;
    const addQty = need - (owned.get(oracleId) ?? 0);
    if (addQty > 0) out.push({ oracleId, name: oracleMap.get(oracleId)?.name ?? '(unknown card)', addQty });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Distinct set codes present in the collection, for the set filter. */
export async function getCollectionSets(): Promise<string[]> {
  const scryfallIds = await db.collection.toArray().then((es) => es.map((e) => e.scryfallId));
  const printings = await getPrintingsByIds(scryfallIds);
  const sets = new Map<string, string>();
  printings.forEach((p) => sets.set(p.set, p.setName));
  return [...sets.keys()].sort();
}
