import type {
  CollectionEntry,
  Condition,
  DeckCard,
  Finish,
  OracleCard,
  Priced,
  Printing,
  WishlistEntry,
} from '@mtg/shared';
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

export interface JoinedWish {
  entry: WishlistEntry;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
}

/** Join wishlist entries with their oracle + printing display data. A wish may
 *  target a specific printing (scryfallId) or "any printing" (null). */
export async function joinWishlistEntries(entries: WishlistEntry[]): Promise<JoinedWish[]> {
  const [oracleMap, printMap] = await Promise.all([
    getOracleCardsByIds(entries.map((e) => e.oracleId)),
    getPrintingsByIds(entries.map((e) => e.scryfallId).filter((id): id is string => id !== null)),
  ]);
  return entries.map((entry) => ({
    entry,
    oracle: oracleMap.get(entry.oracleId),
    printing: entry.scryfallId ? printMap.get(entry.scryfallId) : undefined,
  }));
}

export interface JoinedDeckCard {
  entry: DeckCard;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
}

/** Join a deck/binder/box's cards with their oracle + printing display data. */
export async function joinDeckCards(entries: DeckCard[]): Promise<JoinedDeckCard[]> {
  const [oracleMap, printMap] = await Promise.all([
    getOracleCardsByIds(entries.map((e) => e.oracleId)),
    getPrintingsByIds(entries.map((e) => e.scryfallId).filter((id): id is string => !!id)),
  ]);
  return entries.map((entry) => ({
    entry,
    oracle: oracleMap.get(entry.oracleId),
    printing: entry.scryfallId ? printMap.get(entry.scryfallId) : undefined,
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
  /** What the deck's slots want of the copy, when they all agree — the wish
   *  inherits it, so a deck asking for a foil wishes for a foil. */
  condition?: Condition;
  finish?: Finish;
  lang?: string;
}

/** The wants shared by every slot of one card, or undefined where they differ. */
function agreedWants(slots: DeckCard[]): Pick<MissingCard, 'condition' | 'finish' | 'lang'> {
  const same = <T,>(pick: (s: DeckCard) => T | undefined): T | undefined => {
    const first = pick(slots[0]!);
    return first !== undefined && slots.every((s) => pick(s) === first) ? first : undefined;
  };
  const condition = same((s) => s.condition);
  const finish = same((s) => s.finish);
  const lang = same((s) => s.lang);
  return {
    ...(condition ? { condition } : {}),
    ...(finish ? { finish } : {}),
    ...(lang ? { lang } : {}),
  };
}

/**
 * Cards this deck needs that aren't fully owned and aren't already on the
 * wishlist (beta plan §6). addQty = needed − owned, aggregated per oracle card
 * across boards. "Any printing" basics are already covered by the lands box, so
 * they never turn up here.
 */
export async function computeDeckWishlistCandidates(deckId: string): Promise<MissingCard[]> {
  const deckCards = await db.deckCards.where('deckId').equals(deckId).toArray();
  const needed = new Map<string, number>();
  const slotsFor = new Map<string, DeckCard[]>();
  for (const dc of deckCards) {
    // Tokens aren't shopping list material, and "any basic" is already covered
    // by the lands box.
    if (dc.anyBasic || dc.board === 'token') continue;
    needed.set(dc.oracleId, (needed.get(dc.oracleId) ?? 0) + dc.quantity);
    const list = slotsFor.get(dc.oracleId);
    if (list) list.push(dc);
    else slotsFor.set(dc.oracleId, [dc]);
  }

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
    if (addQty > 0) {
      out.push({
        oracleId,
        name: oracleMap.get(oracleId)?.name ?? '(unknown card)',
        addQty,
        ...agreedWants(slotsFor.get(oracleId) ?? []),
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

/** One set in the installed card DB, for pickers that offer set symbols. */
export interface CardSetInfo {
  /** Lowercase Scryfall set code, e.g. "sth". */
  set: string;
  setName: string;
  /** ISO date of the newest printing seen for the set (its release, near enough). */
  releasedAt: string;
}

// The card DB is replaced wholesale on a version bump (and the app reloads for
// it), so within one session this list can't go stale.
let setListCache: CardSetInfo[] | null = null;

/**
 * Every set the installed card DB knows about, newest first.
 *
 * Walked off the printings `set` index — one key per set, then one row per set
 * for its name — rather than read out of the table: 150k printings is not a
 * list you scan to fill a picker.
 */
export async function getSetList(): Promise<CardSetInfo[]> {
  if (setListCache) return setListCache;
  const codes: string[] = [];
  await db.printings.orderBy('set').eachUniqueKey((k) => codes.push(String(k)));
  const rows = await Promise.all(codes.map((code) => db.printings.where('set').equals(code).first()));
  const sets = rows
    .filter((p): p is Printing => !!p)
    .map((p) => ({ set: p.set, setName: p.setName, releasedAt: p.releasedAt }));
  sets.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || a.setName.localeCompare(b.setName));
  setListCache = sets;
  return sets;
}
