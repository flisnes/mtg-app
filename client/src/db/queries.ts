import type { CollectionEntry, OracleCard, Priced, Printing } from '@mtg/shared';
import { db } from './schema.js';
import { withPrices } from '../cardDb/prices.js';

// Read queries against the card DB, for joining user data (which stores only
// ids) with display data (names, images, sets, prices). Card rows don't carry
// prices (those live in the shard store); these queries join them in, so views
// always see Priced rows. Views use these via dexie-react-hooks useLiveQuery
// for reactivity.

export async function getOracleCard(oracleId: string): Promise<Priced<OracleCard> | undefined> {
  const card = await db.oracleCards.get(oracleId);
  return card && (await withPrices([card], (c) => c.defaultScryfallId))[0];
}

export async function getPrinting(scryfallId: string): Promise<Priced<Printing> | undefined> {
  const printing = await db.printings.get(scryfallId);
  return printing && (await withPrices([printing], (p) => p.scryfallId))[0];
}

/** All printings of a functional card, newest first (for the edition picker). */
export async function getPrintingsForOracle(oracleId: string): Promise<Priced<Printing>[]> {
  const printings = await db.printings.where('oracleId').equals(oracleId).toArray();
  printings.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  return withPrices(printings, (p) => p.scryfallId);
}

export async function getOracleCardsByIds(ids: Iterable<string>): Promise<Map<string, Priced<OracleCard>>> {
  const unique = [...new Set(ids)];
  const cards = (await db.oracleCards.bulkGet(unique)).filter((c): c is OracleCard => !!c);
  const priced = await withPrices(cards, (c) => c.defaultScryfallId);
  return new Map(priced.map((c) => [c.oracleId, c]));
}

export async function getPrintingsByIds(ids: Iterable<string>): Promise<Map<string, Priced<Printing>>> {
  const unique = [...new Set(ids)];
  const printings = (await db.printings.bulkGet(unique)).filter((p): p is Printing => !!p);
  const priced = await withPrices(printings, (p) => p.scryfallId);
  return new Map(priced.map((p) => [p.scryfallId, p]));
}

export interface JoinedEntry {
  entry: CollectionEntry;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
}

/** Join collection entries with their oracle + printing display data. */
export async function joinCollectionEntries(entries: CollectionEntry[]): Promise<JoinedEntry[]> {
  const [oracleMap, printMap] = await Promise.all([
    getOracleCardsByIds(entries.map((e) => e.oracleId)),
    getPrintingsByIds(entries.map((e) => e.scryfallId)),
  ]);
  return entries.map((entry) => ({
    entry,
    oracle: oracleMap.get(entry.oracleId),
    printing: printMap.get(entry.scryfallId),
  }));
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
