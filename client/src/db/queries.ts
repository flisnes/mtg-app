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

/** Distinct set codes present in the collection, for the set filter. */
export async function getCollectionSets(): Promise<string[]> {
  const scryfallIds = await db.collection.toArray().then((es) => es.map((e) => e.scryfallId));
  const printings = await getPrintingsByIds(scryfallIds);
  const sets = new Map<string, string>();
  printings.forEach((p) => sets.set(p.set, p.setName));
  return [...sets.keys()].sort();
}
