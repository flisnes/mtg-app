import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CollectionEntry, DeckCard, OracleCard, TradeLine, UserEvent } from '@mtg/shared';
import { db, USER_DATA_TABLES } from '../src/db/schema.js';
import { invalidatePriceCache, priceShardKey } from '../src/cardDb/prices.js';
import { setSetting } from '../src/db/settings.js';
import {
  addDeckCard,
  addDeckCardsBulk,
  addSealedItem,
  addToCollection,
  addToWishlist,
  addToWishlistBulk,
  applyCompletedTrade,
  applyImport,
  clearTradelist,
  countFiledCopies,
  createContainer,
  createDeckFolder,
  deleteAllUserData,
  deleteDeck,
  deleteDeckCardTag,
  deleteDeckFolder,
  editUserEvent,
  markOwnedForTrade,
  moveDeckCard,
  moveDeckCardsBulk,
  moveDeckCardsToContainer,
  reconcileDeck,
  redoEntry,
  removeCollectionEntriesBulk,
  removeDeckCard,
  removeDeckCardsBulk,
  removeDeckCardsMatching,
  removeFromCollection,
  removeFromWishlist,
  removeSealedItem,
  renameDeck,
  renameDeckCardTag,
  renameDeckFolder,
  replaceAllUserData,
  setCardBehavior,
  setContainerForTrade,
  setDeckArchived,
  setDeckCardChosenColor,
  setDeckCardQuantity,
  setDeckCardsForTrade,
  setDeckCardsUnfiled,
  setDeckEmblem,
  setDeckFolder,
  setDeckFormat,
  setQuantityForTrade,
  setQuantityForTradeBulk,
  setSealedItemQuantity,
  tagDeckCards,
  tidyDeckBoards,
  unfileWholeContainer,
  undoEntry,
  updateCollectionEntry,
  updateDeckCard,
  updateWishlistEntry,
} from '../src/db/dataAccess.js';

// Characterization tests for the write layer: they pin what dataAccess does
// today (rows, history events, outbox staging, deck touches) so the
// write-context refactor can prove it changed nothing. Where today's behavior
// looks odd it is pinned as is and called out; fix it in its own change.

// A controllable clock. Every writer reads Date.now() once per transaction, so
// stepping it between calls gives each write its own instant (the undo guard and
// the slot-edit coalescing both depend on telling writes apart in time).
let clock = 1_000_000;
const tick = (ms = 1000) => (clock += ms);

beforeEach(async () => {
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  await Promise.all([...USER_DATA_TABLES, db.outbox, db.priceShards, db.oracleCards, db.settings].map((t) => t.clear()));
  invalidatePriceCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- fixtures -------------------------------------------------------------

const BOLT = { oracleId: 'o-bolt', scryfallId: 's-bolt-m10' };
const BOLT_ALT = { oracleId: 'o-bolt', scryfallId: 's-bolt-2xm' };
const GOYF = { oracleId: 'o-goyf', scryfallId: 's-goyf-fut' };
const ISLAND = { oracleId: 'o-island', scryfallId: 's-island-1' };

const copy = { condition: 'NM' as const, finish: 'nonfoil' as const, lang: 'en' };

function oracle(oracleId: string, name: string): OracleCard {
  return {
    oracleId,
    name,
    manaCost: null,
    cmc: 1,
    typeLine: 'Instant',
    oracleText: null,
    colors: [],
    colorIdentity: [],
    rarity: 'common',
    imageSmall: null,
    imageNormal: null,
    defaultScryfallId: `${oracleId}-default`,
  } as OracleCard;
}

/** Seed a price: [eur, usd, eurFoil, usdFoil]. */
async function seedPrice(scryfallId: string, tuple: (number | null)[]) {
  const key = priceShardKey(scryfallId);
  const row = (await db.priceShards.get(key)) ?? { key, prices: {} };
  (row.prices as Record<string, (number | null)[]>)[scryfallId] = tuple;
  await db.priceShards.put(row as never);
  invalidatePriceCache();
}

async function seedEntry(over: Partial<CollectionEntry> & { id: string }): Promise<CollectionEntry> {
  const e: CollectionEntry = {
    ...BOLT,
    ...copy,
    quantity: 1,
    quantityForTrade: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
  await db.collection.put(e);
  return e;
}

async function seedSlot(over: Partial<DeckCard> & { id: string; deckId: string }): Promise<DeckCard> {
  const s: DeckCard = { oracleId: BOLT.oracleId, quantity: 1, board: 'main', updatedAt: 1, ...over };
  await db.deckCards.put(s);
  return s;
}

// ---- normalized readers ---------------------------------------------------

// Events sharing a timestamp come back in primary-key (random uuid) order, so
// sort on content after ts: kind, card, board, printing.
const eventOrder = (e: UserEvent) => [e.kind, e.oracleId, e.board ?? '', e.scryfallId ?? ''].join('|');

async function rawEvents(): Promise<UserEvent[]> {
  return (await db.events.toArray()).sort((a, b) => a.ts - b.ts || eventOrder(a).localeCompare(eventOrder(b)));
}

/** Events in time order, ids and the sync stamp stripped. */
async function events(): Promise<Array<Omit<UserEvent, 'id' | 'updatedAt'>>> {
  return (await rawEvents()).map(({ id: _id, updatedAt: _u, ...rest }) => rest);
}

/** The outbox as "tbl:rowId:put|del", sorted. */
async function outbox(): Promise<string[]> {
  const rows = await db.outbox.toArray();
  return rows.map((r) => `${r.tbl}:${r.rowId}:${r.deleted ? 'del' : 'put'}`).sort();
}

/** Outbox entries for one table, as put/del counts (row ids are random). */
async function outboxOf(tbl: string): Promise<{ put: number; del: number }> {
  const rows = (await db.outbox.toArray()).filter((r) => r.tbl === tbl);
  return { put: rows.filter((r) => !r.deleted).length, del: rows.filter((r) => r.deleted).length };
}

async function collection() {
  const rows = await db.collection.toArray();
  return rows
    .map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest)
    .sort((a, b) => `${a.scryfallId}|${a.condition}|${a.finish}`.localeCompare(`${b.scryfallId}|${b.condition}|${b.finish}`));
}

async function slots(deckId: string) {
  const rows = await db.deckCards.where('deckId').equals(deckId).toArray();
  return rows
    .map(({ id: _id, updatedAt: _u, deckId: _d, ...rest }) => rest)
    .sort((a, b) => `${a.board}|${a.oracleId}|${a.scryfallId ?? ''}`.localeCompare(`${b.board}|${b.oracleId}|${b.scryfallId ?? ''}`));
}

async function wishlist() {
  const rows = await db.wishlist.toArray();
  return rows.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest);
}

// ===========================================================================
// Collection
// ===========================================================================

describe('addToCollection', () => {
  test('creates a row, emits collection.add with price, stages both', async () => {
    await seedPrice(BOLT.scryfallId, [1.5, 2]);
    const id = await addToCollection({ ...BOLT, ...copy, quantity: 2 });

    const row = await db.collection.get(id);
    expect(row).toMatchObject({ ...BOLT, ...copy, quantity: 2, quantityForTrade: 0, createdAt: clock, updatedAt: clock });
    expect(row).not.toHaveProperty('special');
    expect(await events()).toEqual([
      { ts: clock, kind: 'collection.add', ...BOLT, qty: 2, ...copy, priceEurCents: 150, source: 'manual' },
    ]);
    const ev = (await rawEvents())[0]!;
    expect(await outbox()).toEqual([`collection:${id}:put`, `events:${ev.id}:put`].sort());
  });

  test('merges into the matching row; quantityForTrade takes the max, clamped', async () => {
    await seedEntry({ id: 'e1', quantity: 2, quantityForTrade: 1 });
    const id = await addToCollection({ ...BOLT, ...copy, quantity: 1, quantityForTrade: 5, source: 'scan' });
    expect(id).toBe('e1');
    expect(await db.collection.get('e1')).toMatchObject({ quantity: 3, quantityForTrade: 3, updatedAt: clock, createdAt: 1 });
    expect((await events())[0]).toMatchObject({ kind: 'collection.add', qty: 1, source: 'scan', priceEurCents: null });
  });

  test('a special copy gets its own row and never merges into the plain one', async () => {
    await seedEntry({ id: 'plain', quantity: 1 });
    const id = await addToCollection({ ...BOLT, ...copy, special: ['signed'] });
    expect(id).not.toBe('plain');
    expect(await collection()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quantity: 1, special: ['signed'] }),
        expect.not.objectContaining({ special: expect.anything() }),
      ]),
    );
    expect((await events())[0]).toMatchObject({ special: ['signed'] });
  });

  test('blank lang defaults to en', async () => {
    const id = await addToCollection({ ...BOLT, ...copy, lang: '' });
    expect((await db.collection.get(id))!.lang).toBe('en');
  });

  test('a matching wish emits wish.fulfilled (capped at the wish qty) and leaves the wishlist alone', async () => {
    await db.wishlist.put({ id: 'w1', oracleId: BOLT.oracleId, scryfallId: null, quantity: 1, createdAt: 1, updatedAt: 1 });
    await addToCollection({ ...BOLT, ...copy, quantity: 3 });
    expect((await events()).map((e) => [e.kind, e.qty, e.source])).toEqual([
      ['collection.add', 3, 'manual'],
      ['wish.fulfilled', 1, 'manual'],
    ]);
    expect(await db.wishlist.get('w1')).toMatchObject({ quantity: 1 });
  });

  test('a wish for another printing does not fulfil', async () => {
    await db.wishlist.put({ id: 'w1', oracleId: BOLT.oracleId, scryfallId: BOLT_ALT.scryfallId, quantity: 1, createdAt: 1, updatedAt: 1 });
    await addToCollection({ ...BOLT, ...copy });
    expect((await events()).map((e) => e.kind)).toEqual(['collection.add']);
  });

  test('eventId names the add event', async () => {
    await addToCollection({ ...BOLT, ...copy, eventId: 'ev-mine' });
    expect(await db.events.get('ev-mine')).toMatchObject({ kind: 'collection.add' });
  });
});

describe('updateCollectionEntry', () => {
  test('quantity up emits a manual add (+ wish.fulfilled); clamps quantityForTrade', async () => {
    await seedEntry({ id: 'e1', quantity: 2, quantityForTrade: 2 });
    await db.wishlist.put({ id: 'w1', oracleId: BOLT.oracleId, scryfallId: null, quantity: 5, createdAt: 1, updatedAt: 1 });
    await updateCollectionEntry('e1', { quantity: 4, quantityForTrade: 9 });
    expect(await db.collection.get('e1')).toMatchObject({ quantity: 4, quantityForTrade: 4, updatedAt: clock });
    expect((await events()).map((e) => [e.kind, e.qty, e.source])).toEqual([
      ['collection.add', 2, 'manual'],
      ['wish.fulfilled', 2, 'manual'],
    ]);
  });

  test('quantity down emits a remove with reason sold and clamps the trade count', async () => {
    await seedEntry({ id: 'e1', quantity: 4, quantityForTrade: 3 });
    await updateCollectionEntry('e1', { quantity: 1 });
    expect(await db.collection.get('e1')).toMatchObject({ quantity: 1, quantityForTrade: 1 });
    expect(await events()).toEqual([
      expect.objectContaining({ kind: 'collection.remove', qty: 3, reason: 'sold', source: 'manual' }),
    ]);
  });

  test('a non-quantity edit emits nothing but still stages the row', async () => {
    await seedEntry({ id: 'e1', quantity: 2 });
    await updateCollectionEntry('e1', { quantityForTrade: 1 });
    expect(await events()).toEqual([]);
    expect(await outbox()).toEqual(['collection:e1:put']);
  });

  test('a cleared special list deletes the field rather than storing []', async () => {
    await seedEntry({ id: 'e1', special: ['altered'] });
    await updateCollectionEntry('e1', { special: [] });
    expect(await db.collection.get('e1')).not.toHaveProperty('special');
  });

  test('re-keying onto an existing row merges the two and tombstones the edited one', async () => {
    await seedEntry({ id: 'nm', quantity: 2, quantityForTrade: 1 });
    await seedEntry({ id: 'lp', condition: 'LP', quantity: 1, quantityForTrade: 1 });
    await updateCollectionEntry('nm', { condition: 'LP' });
    expect(await db.collection.get('nm')).toBeUndefined();
    expect(await db.collection.get('lp')).toMatchObject({ quantity: 3, quantityForTrade: 2 });
    expect(await outbox()).toEqual(['collection:lp:put', 'collection:nm:del']);
    expect(await events()).toEqual([]);
  });

  test('re-keying takes the copy’s filed slots along (no events)', async () => {
    await db.decks.put({ id: 'd1', name: 'Burn', kind: 'deck', createdAt: 1, updatedAt: 1 });
    await seedEntry({ id: 'e1', quantity: 1 });
    await seedSlot({ id: 'slot', deckId: 'd1', ...BOLT, ...copy });
    await updateCollectionEntry('e1', { lang: 'de' });
    expect(await db.deckCards.get('slot')).toMatchObject({ ...BOLT, condition: 'NM', finish: 'nonfoil', lang: 'de', updatedAt: clock });
    expect(await events()).toEqual([]);
  });

  test('a missing id is a no-op', async () => {
    await updateCollectionEntry('nope', { quantity: 3 });
    expect(await outbox()).toEqual([]);
  });
});

describe('removeFromCollection', () => {
  test('decrements and clamps quantityForTrade', async () => {
    await seedEntry({ id: 'e1', quantity: 3, quantityForTrade: 3 });
    await removeFromCollection('e1', 1, 'lost');
    expect(await db.collection.get('e1')).toMatchObject({ quantity: 2, quantityForTrade: 2 });
    expect(await events()).toEqual([
      expect.objectContaining({ kind: 'collection.remove', qty: 1, reason: 'lost', source: 'manual', priceEurCents: null }),
    ]);
  });

  test('removing all (default) deletes the row and stages a tombstone', async () => {
    await seedEntry({ id: 'e1', quantity: 3, special: ['signed'] });
    await removeFromCollection('e1');
    expect(await db.collection.get('e1')).toBeUndefined();
    expect(await outboxOf('collection')).toEqual({ put: 0, del: 1 });
    expect((await events())[0]).toMatchObject({ qty: 3, reason: 'sold', special: ['signed'] });
  });

  test('over-removal records only what was there', async () => {
    await seedEntry({ id: 'e1', quantity: 2 });
    await removeFromCollection('e1', 5);
    expect((await events())[0]).toMatchObject({ qty: 2 });
  });
});

describe('tradelist flags', () => {
  test('setQuantityForTrade goes through updateCollectionEntry: clamped, no event', async () => {
    await seedEntry({ id: 'e1', quantity: 2 });
    await setQuantityForTrade('e1', 7);
    expect(await db.collection.get('e1')).toMatchObject({ quantityForTrade: 2 });
    expect(await events()).toEqual([]);
  });

  test('setQuantityForTradeBulk clamps each row, skips missing ids, emits nothing', async () => {
    await seedEntry({ id: 'a', quantity: 2 });
    await seedEntry({ id: 'b', ...GOYF, quantity: 1, quantityForTrade: 1 });
    await setQuantityForTradeBulk([
      { id: 'a', quantityForTrade: 5 },
      { id: 'b', quantityForTrade: -1 },
      { id: 'gone', quantityForTrade: 1 },
    ]);
    expect((await db.collection.get('a'))!.quantityForTrade).toBe(2);
    expect((await db.collection.get('b'))!.quantityForTrade).toBe(0);
    expect(await outbox()).toEqual(['collection:a:put', 'collection:b:put']);
    expect(await events()).toEqual([]);
  });

  test('clearTradelist zeroes every flagged row and returns the count', async () => {
    await seedEntry({ id: 'a', quantity: 2, quantityForTrade: 2 });
    await seedEntry({ id: 'b', ...GOYF, quantity: 1 });
    expect(await clearTradelist()).toBe(1);
    expect((await db.collection.get('a'))!.quantityForTrade).toBe(0);
    expect(await outbox()).toEqual(['collection:a:put']);
  });
});

describe('markOwnedForTrade', () => {
  test('prefers the exact printing, then plain over special; one batch, one event per row', async () => {
    await seedEntry({ id: 'other', ...BOLT_ALT, quantity: 2 });
    await seedEntry({ id: 'exact-signed', quantity: 1, special: ['signed'] });
    await seedEntry({ id: 'exact', quantity: 1 });
    const n = await markOwnedForTrade(
      [
        { ...BOLT, ...copy, quantity: 2 },
        { ...BOLT, ...copy, quantity: 1 },
      ],
      { source: 'scan', batchLabel: 'Tradelist scan' },
    );
    expect(n).toBe(3);
    expect((await db.collection.get('exact'))!.quantityForTrade).toBe(1);
    expect((await db.collection.get('exact-signed'))!.quantityForTrade).toBe(1);
    expect((await db.collection.get('other'))!.quantityForTrade).toBe(1);

    const evs = await rawEvents();
    expect(evs.map((e) => [e.scryfallId, e.qty, e.kind, e.source, e.batchLabel])).toEqual(
      expect.arrayContaining([
        [BOLT.scryfallId, 1, 'tradelist.mark', 'scan', 'Tradelist scan'],
        [BOLT.scryfallId, 1, 'tradelist.mark', 'scan', 'Tradelist scan'],
        [BOLT_ALT.scryfallId, 1, 'tradelist.mark', 'scan', 'Tradelist scan'],
      ]),
    );
    expect(evs).toHaveLength(3);
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
  });

  test('a second request on the same row accumulates into one event line', async () => {
    await seedEntry({ id: 'e1', quantity: 3 });
    await markOwnedForTrade([
      { ...BOLT, ...copy, quantity: 1 },
      { ...BOLT, ...copy, quantity: 1 },
    ]);
    expect(await events()).toEqual([expect.objectContaining({ qty: 2, source: 'manual' })]);
  });

  test('nothing owned, nothing flagged, nothing written', async () => {
    expect(await markOwnedForTrade([{ ...GOYF, ...copy, quantity: 1 }])).toBe(0);
    expect(await outbox()).toEqual([]);
  });

  test('a passed batchId is used', async () => {
    await seedEntry({ id: 'e1' });
    await markOwnedForTrade([{ ...BOLT, ...copy, quantity: 1 }], { batchId: 'b-1' });
    expect((await rawEvents())[0]!.batchId).toBe('b-1');
  });
});

describe('setContainerForTrade / setDeckCardsForTrade', () => {
  test('marks owned copies for the container’s filed slots, skips unfiled and any-basic', async () => {
    await seedEntry({ id: 'bolt', quantity: 4 });
    await seedEntry({ id: 'goyf', ...GOYF, quantity: 1 });
    await seedEntry({ id: 'island', ...ISLAND, quantity: 10 });
    await seedSlot({ id: 's1', deckId: 'box', ...BOLT, quantity: 2 });
    await seedSlot({ id: 's2', deckId: 'box', ...GOYF, unfiled: true });
    await seedSlot({ id: 's3', deckId: 'box', oracleId: ISLAND.oracleId, anyBasic: true, quantity: 5 });
    expect(await setContainerForTrade('box', true)).toBe(2);
    expect((await db.collection.get('bolt'))!.quantityForTrade).toBe(2);
    expect((await db.collection.get('goyf'))!.quantityForTrade).toBe(0);
    expect((await db.collection.get('island'))!.quantityForTrade).toBe(0);
    expect((await events()).map((e) => e.kind)).toEqual(['tradelist.mark']);
  });

  test('unmarking takes copies off the tradelist, exact printing first, with no event', async () => {
    await seedEntry({ id: 'alt', ...BOLT_ALT, quantity: 2, quantityForTrade: 2 });
    await seedEntry({ id: 'bolt', quantity: 2, quantityForTrade: 1 });
    await seedSlot({ id: 's1', deckId: 'box', ...BOLT, quantity: 2 });
    expect(await setDeckCardsForTrade(['s1'], false)).toBe(2);
    expect((await db.collection.get('bolt'))!.quantityForTrade).toBe(0);
    expect((await db.collection.get('alt'))!.quantityForTrade).toBe(1);
    expect(await events()).toEqual([]);
  });
});

describe('removeCollectionEntriesBulk', () => {
  test('deletes outright, one remove event per row with its own price', async () => {
    await seedPrice(GOYF.scryfallId, [40, 50]);
    await seedEntry({ id: 'a', quantity: 2 });
    await seedEntry({ id: 'b', ...GOYF, finish: 'foil', quantity: 1 });
    await removeCollectionEntriesBulk(['a', 'b', 'missing'], 'traded');
    expect(await db.collection.count()).toBe(0);
    expect(await outboxOf('collection')).toEqual({ put: 0, del: 2 });
    const evs = await events();
    expect(evs).toHaveLength(2);
    expect(evs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...BOLT, qty: 2, reason: 'traded', source: 'manual', priceEurCents: null }),
        // No foil slot in the price tuple: foil falls back to nonfoil.
        expect.objectContaining({ ...GOYF, qty: 1, finish: 'foil', priceEurCents: 4000 }),
      ]),
    );
    // Not a batch: the bulk delete reads as separate entries.
    expect(evs.every((e) => e.batchId === undefined)).toBe(true);
  });
});

describe('applyImport', () => {
  test('merges into the plain row, creates the rest, one batch with the label', async () => {
    await seedEntry({ id: 'plain', quantity: 1, quantityForTrade: 0 });
    await seedEntry({ id: 'signed', quantity: 1, special: ['signed'] });
    const res = await applyImport(
      [
        { ...BOLT, ...copy, quantity: 2, quantityForTrade: 1 },
        { ...GOYF, ...copy, lang: '', quantity: 1, quantityForTrade: 3 },
      ],
      { label: 'My import' },
    );
    expect(res).toEqual({ entries: 2, cards: 3 });
    expect(await db.collection.get('plain')).toMatchObject({ quantity: 3, quantityForTrade: 1 });
    expect(await db.collection.get('signed')).toMatchObject({ quantity: 1 });
    const goyf = (await db.collection.where('oracleId').equals(GOYF.oracleId).toArray())[0]!;
    expect(goyf).toMatchObject({ lang: 'en', quantity: 1, quantityForTrade: 1 });

    const evs = await rawEvents();
    expect(evs.map((e) => [e.kind, e.oracleId, e.qty, e.source, e.batchLabel])).toEqual([
      ['collection.add', BOLT.oracleId, 2, 'import', 'My import'],
      ['collection.add', GOYF.oracleId, 1, 'import', 'My import'],
    ]);
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
  });

  test('wish fulfilment rides the batch but carries no label', async () => {
    await db.wishlist.put({ id: 'w', oracleId: GOYF.oracleId, scryfallId: null, quantity: 1, createdAt: 1, updatedAt: 1 });
    await applyImport([{ ...GOYF, ...copy, quantity: 2, quantityForTrade: 0 }], { source: 'scan', batchId: 'B', label: 'L' });
    expect(await events()).toEqual([
      expect.objectContaining({ kind: 'collection.add', source: 'scan', batchId: 'B', batchLabel: 'L' }),
      { ts: clock, kind: 'wish.fulfilled', ...GOYF, qty: 1, source: 'scan', batchId: 'B' },
    ]);
  });

  test('batchLabel wins over label', async () => {
    await applyImport([{ ...GOYF, ...copy, quantity: 1, quantityForTrade: 0 }], { label: 'L', batchLabel: 'BL' });
    expect((await events())[0]).toMatchObject({ batchLabel: 'BL' });
  });

  test('removals take N copies (reason other) before the adds, in the same batch', async () => {
    await seedEntry({ id: 'old', quantity: 2, quantityForTrade: 2 });
    await applyImport([{ ...BOLT_ALT, ...copy, quantity: 1, quantityForTrade: 0 }], {
      source: 'scan',
      removals: [{ id: 'old', qty: 1 }],
    });
    expect(await db.collection.get('old')).toMatchObject({ quantity: 1, quantityForTrade: 1 });
    const evs = await rawEvents();
    expect(evs.map((e) => [e.kind, e.scryfallId, e.qty, e.reason])).toEqual([
      ['collection.add', BOLT_ALT.scryfallId, 1, undefined],
      ['collection.remove', BOLT.scryfallId, 1, 'other'],
    ]);
    expect(evs[0]!.batchId).toBe(evs[1]!.batchId);
  });

  test('a removal with `to` re-files only the slots the remaining copies can’t back', async () => {
    await db.decks.put({ id: 'd1', name: 'Burn', kind: 'deck', createdAt: 1, updatedAt: 1 });
    await seedEntry({ id: 'old', quantity: 2 });
    await seedSlot({ id: 'slot', deckId: 'd1', ...BOLT, ...copy, quantity: 2 });
    await applyImport([{ ...BOLT_ALT, ...copy, quantity: 1, quantityForTrade: 0 }], {
      removals: [{ id: 'old', qty: 1, to: { scryfallId: BOLT_ALT.scryfallId, ...copy } }],
    });
    // One copy left of the old printing backs one slot copy; the other follows the swap.
    expect(await slots('d1')).toEqual([
      expect.objectContaining({ scryfallId: BOLT_ALT.scryfallId, quantity: 1 }),
      expect.objectContaining({ scryfallId: BOLT.scryfallId, quantity: 1 }),
    ]);
  });

  test('removing the whole row deletes it and lets an add land fresh', async () => {
    await seedEntry({ id: 'old', quantity: 1 });
    await applyImport([{ ...BOLT, ...copy, quantity: 1, quantityForTrade: 0 }], { removals: [{ id: 'old', qty: 5 }] });
    expect(await db.collection.get('old')).toBeUndefined();
    expect(await db.collection.count()).toBe(1);
    expect((await events()).find((e) => e.kind === 'collection.remove')).toMatchObject({ qty: 1 });
  });
});

// ===========================================================================
// Wishlist
// ===========================================================================

describe('wishlist', () => {
  test('addToWishlist creates then merges on the full wish key', async () => {
    const a = await addToWishlist({ oracleId: BOLT.oracleId, quantity: 2 });
    tick();
    const b = await addToWishlist({ oracleId: BOLT.oracleId });
    tick();
    const c = await addToWishlist({ oracleId: BOLT.oracleId, finish: 'foil', source: 'scan' });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(await db.wishlist.get(a)).toMatchObject({ scryfallId: null, quantity: 3 });
    expect((await events()).map((e) => [e.kind, e.qty, e.source, e.finish])).toEqual([
      ['wish.add', 2, 'manual', undefined],
      ['wish.add', 1, 'manual', undefined],
      ['wish.add', 1, 'scan', 'foil'],
    ]);
  });

  test('addToWishlistBulk merges by oracle + wish key and shares an import batch', async () => {
    await db.wishlist.put({ id: 'w', oracleId: BOLT.oracleId, scryfallId: null, quantity: 1, createdAt: 1, updatedAt: 1 });
    const res = await addToWishlistBulk(
      [
        { oracleId: BOLT.oracleId, scryfallId: null, quantity: 2 },
        { ...GOYF, quantity: 1, lang: 'ja' },
        { ...GOYF, quantity: 1, lang: 'ja' },
      ],
      { label: 'Want list' },
    );
    expect(res).toEqual({ entries: 3, cards: 4 });
    expect(await db.wishlist.get('w')).toMatchObject({ quantity: 3 });
    expect((await db.wishlist.where('oracleId').equals(GOYF.oracleId).toArray())).toEqual([
      expect.objectContaining({ quantity: 2, lang: 'ja', scryfallId: GOYF.scryfallId }),
    ]);
    const evs = await rawEvents();
    expect(evs).toHaveLength(3);
    expect(evs.every((e) => e.kind === 'wish.add' && e.source === 'import' && e.batchLabel === 'Want list')).toBe(true);
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
  });

  test('updateWishlistEntry: quantity edit emits add/remove, floors at 1', async () => {
    await db.wishlist.put({ id: 'w', oracleId: BOLT.oracleId, scryfallId: null, quantity: 2, createdAt: 1, updatedAt: 1 });
    await updateWishlistEntry('w', { quantity: 0 });
    expect(await db.wishlist.get('w')).toMatchObject({ quantity: 1 });
    tick();
    await updateWishlistEntry('w', { quantity: 3 });
    expect((await events()).map((e) => [e.kind, e.qty, e.source])).toEqual([
      ['wish.remove', 1, 'manual'],
      ['wish.add', 2, 'manual'],
    ]);
  });

  test('updateWishlistEntry: a present-but-undefined key clears to "any"; a collision merges', async () => {
    await db.wishlist.put({ id: 'w1', oracleId: BOLT.oracleId, scryfallId: BOLT.scryfallId, finish: 'foil', quantity: 1, createdAt: 1, updatedAt: 1 });
    await db.wishlist.put({ id: 'w2', oracleId: BOLT.oracleId, scryfallId: null, quantity: 2, createdAt: 1, updatedAt: 1 });
    await updateWishlistEntry('w1', { scryfallId: null, finish: undefined });
    expect(await db.wishlist.get('w1')).toBeUndefined();
    expect(await db.wishlist.get('w2')).toMatchObject({ quantity: 3 });
    expect(await outbox()).toEqual(['wishlist:w1:del', 'wishlist:w2:put']);
    // A pure re-key emits nothing (quantity unchanged).
    expect(await events()).toEqual([]);
  });

  test('removeFromWishlist decrements, then deletes at zero', async () => {
    await db.wishlist.put({ id: 'w', oracleId: BOLT.oracleId, scryfallId: null, quantity: 3, createdAt: 1, updatedAt: 1 });
    await removeFromWishlist('w', 1);
    expect(await db.wishlist.get('w')).toMatchObject({ quantity: 2 });
    tick();
    await removeFromWishlist('w');
    expect(await db.wishlist.get('w')).toBeUndefined();
    expect((await events()).map((e) => [e.kind, e.qty])).toEqual([
      ['wish.remove', 1],
      ['wish.remove', 2],
    ]);
    expect(await outbox()).toEqual(expect.arrayContaining(['wishlist:w:del']));
  });
});

// ===========================================================================
// Containers, folders
// ===========================================================================

describe('containers', () => {
  test('createContainer: decks carry format and folder, storage does not; blank names fall back', async () => {
    const d = await createContainer('  ', 'deck', 'modern', 'f1');
    const b = await createContainer('Trade binder', 'binder', 'modern', 'f1');
    expect(await db.decks.get(d)).toMatchObject({ name: 'Untitled deck', kind: 'deck', format: 'modern', folderId: 'f1' });
    const binder = await db.decks.get(b);
    expect(binder).toMatchObject({ name: 'Trade binder', kind: 'binder' });
    expect(binder).not.toHaveProperty('format');
    expect(binder).not.toHaveProperty('folderId');
    expect(await outbox()).toEqual([`decks:${b}:put`, `decks:${d}:put`].sort());
    expect(await events()).toEqual([]);
  });

  test('renameDeck trims and falls back per kind', async () => {
    const b = await createContainer('x', 'box');
    tick();
    await renameDeck(b, '   ');
    expect(await db.decks.get(b)).toMatchObject({ name: 'Untitled box', updatedAt: clock });
  });

  test('setDeckFormat to commander tidies the sideboard into Considering (no events)', async () => {
    await db.oracleCards.put(oracle(GOYF.oracleId, 'Tarmogoyf'));
    const d = await createContainer('Goyf', 'deck', 'modern');
    await seedSlot({ id: 'side', deckId: d, ...GOYF, board: 'side' });
    tick();
    await setDeckFormat(d, 'commander');
    expect(await db.decks.get(d)).toMatchObject({ format: 'commander', updatedAt: clock });
    expect(await db.deckCards.get('side')).toMatchObject({ board: 'maybe' });
    // moveSlotRaw collects events into an array tidyBoardsRaw throws away.
    expect(await events()).toEqual([]);
  });

  test('deleteDeck: deck.remove per slot, tombstones slots/behaviors/deck, stamps named copies', async () => {
    const d = await createContainer('Burn');
    await seedEntry({ id: 'e1', updatedAt: 5 });
    await seedSlot({ id: 's1', deckId: d, ...BOLT, ...copy, quantity: 2 });
    await seedSlot({ id: 's2', deckId: d, oracleId: ISLAND.oracleId, anyBasic: true, quantity: 3 });
    await db.deckBehaviors.put({ id: 'beh', deckId: d, oracleId: BOLT.oracleId, behavior: { rules: [] } as never, updatedAt: 1 });
    await db.outbox.clear();
    tick();
    await deleteDeck(d);
    expect(await db.decks.get(d)).toBeUndefined();
    expect(await db.deckCards.count()).toBe(0);
    expect(await db.deckBehaviors.count()).toBe(0);
    expect((await db.collection.get('e1'))!.updatedAt).toBe(clock);
    expect(
      (await outbox()).filter((o) => !o.startsWith('events:')),
    ).toEqual([`deckBehaviors:beh:del`, `deckCards:s1:del`, `deckCards:s2:del`, `decks:${d}:del`, 'collection:e1:put'].sort());
    expect((await events()).map((e) => [e.kind, e.oracleId, e.qty, e.deckName, e.board, e.batchId])).toEqual([
      ['deck.remove', BOLT.oracleId, 2, 'Burn', 'main', undefined],
      ['deck.remove', ISLAND.oracleId, 3, 'Burn', 'main', undefined],
    ]);
  });

  test('archive and folders write the deck row only', async () => {
    const d = await createContainer('Burn');
    const f = await createDeckFolder('  ');
    expect(await db.deckFolders.get(f)).toMatchObject({ name: 'Untitled folder' });
    await renameDeckFolder(f, 'Modern');
    expect(await db.deckFolders.get(f)).toMatchObject({ name: 'Modern' });

    await setDeckFolder(d, f);
    expect(await db.decks.get(d)).toMatchObject({ folderId: f });

    tick();
    await setDeckArchived(d, true);
    expect(await db.decks.get(d)).toMatchObject({ archivedAt: clock, folderId: f });
    tick();
    await setDeckArchived(d, true); // already archived: untouched
    expect((await db.decks.get(d))!.archivedAt).toBe(clock - 1000);
    await setDeckArchived(d, false);
    expect(await db.decks.get(d)).not.toHaveProperty('archivedAt');

    await deleteDeckFolder(f);
    expect(await db.deckFolders.get(f)).toBeUndefined();
    expect(await db.decks.get(d)).not.toHaveProperty('folderId');
    expect(await outbox()).toEqual(expect.arrayContaining([`deckFolders:${f}:del`, `decks:${d}:put`]));
    expect(await events()).toEqual([]);
  });
});

// ===========================================================================
// Slots
// ===========================================================================

describe('addDeckCard', () => {
  test('creates a slot, touches the deck, emits deck.add, stamps the named copy', async () => {
    const d = await createContainer('Burn');
    await seedEntry({ id: 'e1', updatedAt: 5 });
    tick();
    await addDeckCard({ deckId: d, ...BOLT, quantity: 2, wants: copy });
    expect(await slots(d)).toEqual([{ ...BOLT, ...copy, quantity: 2, board: 'main' }]);
    expect((await db.decks.get(d))!.updatedAt).toBe(clock);
    expect((await db.collection.get('e1'))!.updatedAt).toBe(clock);
    expect(await events()).toEqual([
      { ts: clock, kind: 'deck.add', ...BOLT, qty: 2, deckId: d, deckName: 'Burn', board: 'main' },
    ]);
  });

  test('merges on the exact slot key; another printing is another line', async () => {
    const d = await createContainer('Binder', 'binder');
    await addDeckCard({ deckId: d, ...BOLT });
    await addDeckCard({ deckId: d, ...BOLT });
    await addDeckCard({ deckId: d, ...BOLT_ALT });
    expect(await slots(d)).toEqual([
      { ...BOLT_ALT, quantity: 1, board: 'main' },
      { ...BOLT, quantity: 2, board: 'main' },
    ]);
    // Storage names its kind on the event.
    expect((await events())[0]).toMatchObject({ deckName: 'Binder', deckKind: 'binder' });
  });

  test('an any-printing basic is its own slot and pins no printing', async () => {
    const d = await createContainer('Lands', 'box');
    await addDeckCard({ deckId: d, ...ISLAND });
    tick();
    await addDeckCard({ deckId: d, ...ISLAND, anyBasic: true, quantity: 4 });
    expect(await slots(d)).toEqual([
      { oracleId: ISLAND.oracleId, anyBasic: true, quantity: 4, board: 'main' },
      { ...ISLAND, quantity: 1, board: 'main' },
    ]);
    expect((await events())[1]).not.toHaveProperty('scryfallId');
  });
});

describe('addDeckCardsBulk', () => {
  test('vague: folds editions by (oracle, board), adopts a printing, labels with the deck', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'brew', deckId: d, oracleId: BOLT.oracleId, quantity: 1 });
    await addDeckCardsBulk(d, [
      { ...BOLT, quantity: 2, board: 'main', wants: copy },
      { ...BOLT_ALT, quantity: 1, board: 'main' },
      { ...GOYF, quantity: 1, board: 'side' },
    ]);
    expect(await slots(d)).toEqual([
      { ...BOLT, ...copy, quantity: 4, board: 'main' },
      { ...GOYF, quantity: 1, board: 'side' },
    ]);
    const evs = await rawEvents();
    expect(evs.map((e) => [e.kind, e.scryfallId, e.qty, e.board, e.source, e.batchLabel])).toEqual([
      ['deck.add', BOLT_ALT.scryfallId, 1, 'main', 'manual', 'Burn'],
      ['deck.add', BOLT.scryfallId, 2, 'main', 'manual', 'Burn'],
      ['deck.add', GOYF.scryfallId, 1, 'side', 'manual', 'Burn'],
    ]);
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
  });

  test('exact: printing and wants split the lines', async () => {
    const d = await createContainer('Box', 'box');
    await addDeckCardsBulk(
      d,
      [
        { ...BOLT, quantity: 1, board: 'main', wants: copy },
        { ...BOLT, quantity: 1, board: 'main', wants: { ...copy, finish: 'foil' } },
        { ...BOLT, quantity: 1, board: 'main', wants: copy },
      ],
      { exact: true, source: 'scan', batchId: 'B', batchLabel: 'Scan' },
    );
    expect(await slots(d)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ finish: 'nonfoil', quantity: 2 }),
        expect.objectContaining({ finish: 'foil', quantity: 1 }),
      ]),
    );
    expect((await rawEvents()).every((e) => e.batchId === 'B' && e.source === 'scan' && e.batchLabel === 'Scan')).toBe(true);
  });
});

describe('reconcileDeck', () => {
  test('sets, re-points, adds and sweeps in one batch; any-basic sits out', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'exact', deckId: d, ...BOLT, ...copy, quantity: 4 });
    await seedSlot({ id: 'brew', deckId: d, oracleId: GOYF.oracleId, quantity: 1, tags: ['beater'] });
    await seedSlot({ id: 'gone', deckId: d, oracleId: 'o-skred', quantity: 2 });
    await seedSlot({ id: 'lands', deckId: d, oracleId: ISLAND.oracleId, anyBasic: true, quantity: 8 });
    tick();
    const res = await reconcileDeck(d, [
      { ...BOLT, board: 'main', quantity: 3, wants: copy },
      { ...GOYF, board: 'main', quantity: 1, wants: copy },
      { oracleId: 'o-new', scryfallId: 's-new', board: 'main', quantity: 1 },
      { oracleId: 'o-zero', board: 'main', quantity: 0 },
    ]);
    expect(res).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(await db.deckCards.get('exact')).toMatchObject({ quantity: 3 });
    // The brew line is re-pinned in place and keeps its tags.
    expect(await db.deckCards.get('brew')).toMatchObject({ ...GOYF, ...copy, tags: ['beater'], quantity: 1 });
    expect(await db.deckCards.get('gone')).toBeUndefined();
    expect(await db.deckCards.get('lands')).toMatchObject({ quantity: 8 });

    const evs = await rawEvents();
    expect(evs.map((e) => [e.kind, e.oracleId, e.qty])).toEqual([
      ['deck.add', 'o-new', 1],
      ['deck.remove', BOLT.oracleId, 1],
      ['deck.remove', 'o-skred', 2],
    ]);
    expect(evs.every((e) => e.batchLabel === 'Burn' && e.source === 'manual')).toBe(true);
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
  });

  test('an unfiled slot the scan saw is filed again', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 's', deckId: d, ...BOLT, ...copy, quantity: 1, unfiled: true });
    await reconcileDeck(d, [{ ...BOLT, board: 'main', quantity: 1, wants: copy }]);
    expect((await db.deckCards.get('s'))!.unfiled).toBeUndefined();
    expect(await events()).toEqual([]);
  });
});

describe('board moves', () => {
  test('moveDeckCard writes a remove/add pair under one batch; merges tags into an existing slot', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'm', deckId: d, ...BOLT, quantity: 2, tags: ['burn'] });
    await seedSlot({ id: 's', deckId: d, ...BOLT, quantity: 1, board: 'side', tags: ['sb'] });
    tick();
    await moveDeckCard('m', 'side');
    expect(await db.deckCards.get('m')).toBeUndefined();
    expect(await db.deckCards.get('s')).toMatchObject({ quantity: 3, tags: ['burn', 'sb'] });
    const evs = await rawEvents();
    expect(evs.map((e) => [e.kind, e.board, e.qty, e.source])).toEqual([
      ['deck.add', 'side', 2, 'manual'],
      ['deck.remove', 'main', 2, 'manual'],
    ]);
    expect(evs[0]!.batchId).toBeDefined();
    expect(evs[0]!.batchId).toBe(evs[1]!.batchId);
    // A board move carries no label.
    expect(evs[0]!.batchLabel).toBeUndefined();
  });

  test('moving to the board it is on does nothing', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'm', deckId: d });
    await db.outbox.clear();
    await moveDeckCard('m', 'main');
    expect(await outbox()).toEqual([]);
  });

  test('moveDeckCardsBulk: one labelled batch, returns copies moved, skips same-board', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'a', deckId: d, ...BOLT, quantity: 2 });
    await seedSlot({ id: 'b', deckId: d, ...GOYF, quantity: 1 });
    await seedSlot({ id: 'c', deckId: d, oracleId: 'o-x', quantity: 1, board: 'maybe' });
    expect(await moveDeckCardsBulk(['a', 'b', 'c'], 'maybe')).toBe(3);
    const evs = await rawEvents();
    expect(evs).toHaveLength(4);
    expect(evs.every((e) => e.batchLabel === 'Burn')).toBe(true);
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
  });

  test('moveDeckCardsToContainer: leaves here, arrives there (merging tags), one batch naming the target', async () => {
    const from = await createContainer('Burn');
    const to = await createContainer('Trade binder', 'binder');
    await seedEntry({ id: 'e1', updatedAt: 5 });
    await seedSlot({ id: 'a', deckId: from, ...BOLT, ...copy, quantity: 2, tags: ['x'] });
    await seedSlot({ id: 'b', deckId: from, ...GOYF, quantity: 1, board: 'side' });
    await seedSlot({ id: 't', deckId: to, ...BOLT, quantity: 1, tags: ['y'] });
    tick();
    const n = await moveDeckCardsToContainer(['a', 'b', 'missing'], to, () => 'main');
    expect(n).toBe(3);
    expect(await slots(from)).toEqual([]);
    expect(await slots(to)).toEqual([
      { ...BOLT, quantity: 3, board: 'main', tags: ['x', 'y'] },
      { ...GOYF, quantity: 1, board: 'main' },
    ]);
    expect((await db.collection.get('e1'))!.updatedAt).toBe(clock);
    expect((await db.decks.get(from))!.updatedAt).toBe(clock);
    expect((await db.decks.get(to))!.updatedAt).toBe(clock);
    const evs = await rawEvents();
    expect(evs.map((e) => [e.kind, e.oracleId, e.deckId === to ? 'to' : 'from', e.board, e.deckKind])).toEqual([
      ['deck.add', BOLT.oracleId, 'to', 'main', 'binder'],
      ['deck.add', GOYF.oracleId, 'to', 'main', 'binder'],
      ['deck.remove', BOLT.oracleId, 'from', 'main', undefined],
      ['deck.remove', GOYF.oracleId, 'from', 'side', undefined],
    ]);
    expect(evs.every((e) => e.batchLabel === 'Trade binder')).toBe(true);
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
  });

  test('moveDeckCardsToContainer into a missing target writes nothing', async () => {
    await seedSlot({ id: 'a', deckId: 'd' });
    expect(await moveDeckCardsToContainer(['a'], 'nope', () => 'main')).toBe(0);
    expect(await outbox()).toEqual([]);
  });
});

describe('slot edits', () => {
  test('setDeckCardQuantity emits the delta, touches the deck, and coalesces a run of same-direction edits', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 's', deckId: d, ...BOLT, quantity: 1 });
    tick();
    await setDeckCardQuantity('s', 2);
    expect((await db.decks.get(d))!.updatedAt).toBe(clock);
    tick();
    await setDeckCardQuantity('s', 4);
    expect(await events()).toEqual([
      { ts: clock, kind: 'deck.add', ...BOLT, qty: 3, deckId: d, deckName: 'Burn', board: 'main' },
    ]);
    // A change of direction starts a new entry.
    tick();
    await setDeckCardQuantity('s', 3);
    expect((await events()).map((e) => [e.kind, e.qty])).toEqual([
      ['deck.add', 3],
      ['deck.remove', 1],
    ]);
    // Past the 30s window a same-direction edit is its own entry again.
    tick(31_000);
    await setDeckCardQuantity('s', 2);
    expect((await events()).map((e) => [e.kind, e.qty])).toEqual([
      ['deck.add', 3],
      ['deck.remove', 1],
      ['deck.remove', 1],
    ]);
  });

  test('removeDeckCard deletes the slot and records the whole quantity', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 's', deckId: d, quantity: 3 });
    await removeDeckCard('s');
    expect(await db.deckCards.get('s')).toBeUndefined();
    expect(await events()).toEqual([expect.objectContaining({ kind: 'deck.remove', qty: 3 })]);
  });

  test('updateDeckCard: empty scryfallId clears to any edition, wants refile an unfiled slot, tags survive', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 's', deckId: d, ...BOLT, ...copy, quantity: 1, unfiled: true, tags: ['t'] });
    await updateDeckCard('s', { quantity: 1, scryfallId: '', wants: { finish: 'foil' } });
    const s = await db.deckCards.get('s');
    expect(s).toMatchObject({ quantity: 1, finish: 'foil', tags: ['t'] });
    expect(s!.scryfallId).toBeUndefined();
    expect(s!.condition).toBeUndefined();
    expect(s!.unfiled).toBeUndefined();
    expect(await events()).toEqual([]);
  });

  test('setDeckCardsUnfiled flips filed slots only, no events', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'filed', deckId: d, ...BOLT, ...copy, quantity: 2 });
    await seedSlot({ id: 'brew', deckId: d, ...GOYF });
    expect(await setDeckCardsUnfiled(['filed', 'brew'], true)).toBe(2);
    expect((await db.deckCards.get('filed'))!.unfiled).toBe(true);
    expect(await setDeckCardsUnfiled(['filed'], true)).toBe(0);
    expect(await setDeckCardsUnfiled(['filed'], false)).toBe(2);
    expect((await db.deckCards.get('filed'))!.unfiled).toBeUndefined();
    expect(await events()).toEqual([]);
  });

  test('tags: add/remove, rename (merging), delete; no events', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'a', deckId: d, tags: ['Burn'] });
    await seedSlot({ id: 'b', deckId: d, oracleId: 'o-x', tags: ['burn', 'Reach'] });
    expect(await tagDeckCards(['a', 'b'], { add: ['Reach'] })).toBe(1);
    expect((await db.deckCards.get('a'))!.tags).toEqual(['Burn', 'Reach']);
    expect(await renameDeckCardTag(d, 'reach', 'Burn')).toBe(2);
    expect((await db.deckCards.get('a'))!.tags).toEqual(['Burn']);
    expect(await deleteDeckCardTag(d, 'BURN')).toBe(2);
    expect((await db.deckCards.get('a'))!.tags).toBeUndefined();
    expect(await events()).toEqual([]);
  });
});

describe('bulk slot removal', () => {
  test('removeDeckCardsBulk: one labelled batch, tombstones, returns copies', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'a', deckId: d, ...BOLT, quantity: 2 });
    await seedSlot({ id: 'b', deckId: d, ...GOYF, quantity: 1, board: 'side' });
    expect(await removeDeckCardsBulk(['a', 'b', 'x'])).toBe(3);
    expect(await outboxOf('deckCards')).toEqual({ put: 0, del: 2 });
    const evs = await rawEvents();
    expect(evs.map((e) => [e.kind, e.qty, e.board, e.batchLabel, e.source])).toEqual([
      ['deck.remove', 2, 'main', 'Burn', 'manual'],
      ['deck.remove', 1, 'side', 'Burn', 'manual'],
    ]);
    expect(evs[0]!.batchId).toBe(evs[1]!.batchId);
  });

  test('removeDeckCardsMatching: exact printing first, then edition-less; decrement vs delete', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'vague', deckId: d, oracleId: BOLT.oracleId, quantity: 2 });
    await seedSlot({ id: 'exact', deckId: d, ...BOLT, quantity: 1 });
    await seedSlot({ id: 'other', deckId: d, ...BOLT_ALT, quantity: 4 });
    await seedSlot({ id: 'basic', deckId: d, oracleId: ISLAND.oracleId, anyBasic: true, quantity: 4 });
    const n = await removeDeckCardsMatching(
      d,
      [
        { ...BOLT, quantity: 2 },
        { oracleId: ISLAND.oracleId, quantity: 1 },
      ],
      { source: 'trade', batchId: 'B' },
    );
    expect(n).toBe(2);
    expect(await db.deckCards.get('exact')).toBeUndefined();
    expect(await db.deckCards.get('vague')).toMatchObject({ quantity: 1 });
    expect(await db.deckCards.get('other')).toMatchObject({ quantity: 4 });
    expect(await db.deckCards.get('basic')).toMatchObject({ quantity: 4 });
    expect((await events()).map((e) => [e.scryfallId, e.qty, e.source, e.batchId, e.batchLabel])).toEqual([
      [undefined, 1, 'trade', 'B', 'Burn'],
      [BOLT.scryfallId, 1, 'trade', 'B', 'Burn'],
    ]);
  });
});

// ===========================================================================
// Trade
// ===========================================================================

const line = (over: Partial<TradeLine>): TradeLine => ({ ...BOLT, name: 'Lightning Bolt', quantity: 1, ...copy, ...over });

describe('applyCompletedTrade', () => {
  test('gives, receives, prunes wishes, records the trade; idempotent on the session id', async () => {
    await db.oracleCards.put(oracle(GOYF.oracleId, 'Tarmogoyf'));
    await seedEntry({ id: 'bolt', quantity: 3, quantityForTrade: 3 });
    await seedEntry({ id: 'bolt-signed', quantity: 1, special: ['signed'] });
    await db.wishlist.put({ id: 'w', oracleId: GOYF.oracleId, scryfallId: null, quantity: 2, createdAt: 1, updatedAt: 1 });

    const given = [line({ quantity: 2 })];
    const received = [
      line({ ...GOYF, name: 'Tarmogoyf', quantity: 1 }),
      line({ oracleId: 'o-fake', scryfallId: 's-fake', name: 'Fake' }),
    ];
    expect(await applyCompletedTrade('T1', given, received, 'alice')).toEqual({ applied: true });

    // The plain copy goes across the table; the signed one stays.
    expect(await db.collection.get('bolt')).toMatchObject({ quantity: 1, quantityForTrade: 1 });
    expect(await db.collection.get('bolt-signed')).toMatchObject({ quantity: 1 });
    // Unknown oracle dropped; the known one lands.
    expect(await collection()).toEqual(
      expect.arrayContaining([expect.objectContaining({ ...GOYF, quantity: 1, quantityForTrade: 0 })]),
    );
    expect(await db.collection.where('oracleId').equals('o-fake').count()).toBe(0);
    expect(await db.wishlist.get('w')).toMatchObject({ quantity: 1 });

    expect((await events()).map((e) => [e.kind, e.oracleId, e.qty, e.reason, e.source, e.tradeId])).toEqual([
      ['collection.add', GOYF.oracleId, 1, undefined, 'trade', 'T1'],
      ['collection.remove', BOLT.oracleId, 2, 'traded', 'trade', 'T1'],
      ['wish.fulfilled', GOYF.oracleId, 1, undefined, 'trade', 'T1'],
    ]);
    const trade = await db.trades.get('T1');
    expect(trade).toMatchObject({ partner: 'alice', completedAt: clock, given, received: [received[0]] });
    expect(await outbox()).toEqual(expect.arrayContaining(['trades:T1:put', 'collection:bolt:put', 'wishlist:w:put']));

    tick();
    expect(await applyCompletedTrade('T1', given, received)).toEqual({ applied: false });
    expect(await db.events.count()).toBe(3);
  });

  test('giving more than recorded backfills a reconcile add one tick before the remove', async () => {
    await seedEntry({ id: 'bolt', quantity: 1 });
    await applyCompletedTrade('T2', [line({ quantity: 3 })], []);
    expect(await db.collection.get('bolt')).toBeUndefined();
    expect(await events()).toEqual([
      expect.objectContaining({ ts: clock, kind: 'collection.add', qty: 2, reconcile: true, tradeId: 'T2' }),
      expect.objectContaining({ ts: clock + 1, kind: 'collection.remove', qty: 3, reason: 'traded' }),
    ]);
  });

  test('a filed copy given away comes out of its only container', async () => {
    const d = await createContainer('Burn');
    await seedEntry({ id: 'bolt', quantity: 1 });
    await seedSlot({ id: 's', deckId: d, ...BOLT, ...copy, quantity: 1 });
    await applyCompletedTrade('T3', [line({ quantity: 1 })], []);
    expect(await db.deckCards.get('s')).toBeUndefined();
    const evs = await events();
    expect(evs.find((e) => e.kind === 'deck.remove')).toMatchObject({ deckId: d, qty: 1, source: 'manual' });
    // The filing fix gets its own batch, not the trade id.
    expect(evs.find((e) => e.kind === 'deck.remove')!.tradeId).toBeUndefined();
  });

  test('a filed copy claimed by two containers is left for the resolver', async () => {
    const a = await createContainer('A');
    const b = await createContainer('B');
    await seedEntry({ id: 'bolt', quantity: 2 });
    await seedSlot({ id: 'sa', deckId: a, ...BOLT, ...copy });
    await seedSlot({ id: 'sb', deckId: b, ...BOLT, ...copy });
    await applyCompletedTrade('T4', [line({ quantity: 1 })], []);
    expect(await db.deckCards.count()).toBe(2);
  });
});

// ===========================================================================
// Undo / redo
// ===========================================================================

describe('undo and redo', () => {
  test('a single add round-trips: undo removes the copy and its events, redo puts both back fresh', async () => {
    await db.wishlist.put({ id: 'w', oracleId: BOLT.oracleId, scryfallId: null, quantity: 1, createdAt: 1, updatedAt: 1 });
    await addToCollection({ ...BOLT, ...copy, quantity: 2, eventId: 'add' });
    tick();
    const undone = await undoEntry({ type: 'single', id: 'add' });
    expect(undone.undone).toBe(true);
    if (!undone.undone) return;
    // The paired wish.fulfilled is folded in.
    expect(undone.events.map((e) => e.kind).sort()).toEqual(['collection.add', 'wish.fulfilled']);
    expect(await db.collection.count()).toBe(0);
    expect(await db.events.count()).toBe(0);
    expect(await db.wishlist.get('w')).toMatchObject({ quantity: 1 });
    expect(await outboxOf('events')).toEqual({ put: 0, del: 2 });

    tick();
    const since = clock;
    tick();
    const redone = await redoEntry({ events: undone.events, since });
    expect(redone.redone).toBe(true);
    expect(await collection()).toEqual([expect.objectContaining({ ...BOLT, quantity: 2 })]);
    const evs = await rawEvents();
    expect(evs).toHaveLength(2);
    expect(evs.every((e) => e.ts === clock && e.id !== 'add')).toBe(true);
  });

  test('undo of a gone entry says so', async () => {
    expect(await undoEntry({ type: 'single', id: 'nope' })).toEqual({ undone: false, reason: 'gone' });
    expect(await undoEntry({ type: 'batch', batchId: 'nope' })).toEqual({ undone: false, reason: 'gone' });
  });

  test('a batch undo reverses every line; redo regroups under the same batchId', async () => {
    const d = await createContainer('Burn');
    await addDeckCardsBulk(d, [
      { ...BOLT, quantity: 2, board: 'main' },
      { ...GOYF, quantity: 1, board: 'main' },
    ], { batchId: 'B' });
    tick();
    const undone = await undoEntry({ type: 'batch', batchId: 'B' });
    expect(undone.undone).toBe(true);
    if (!undone.undone) return;
    expect(await slots(d)).toEqual([]);
    tick();
    const redone = await redoEntry({ events: undone.events, since: clock - 1 });
    expect(redone.redone).toBe(true);
    // deckAdjustRaw re-adds as a bare slot: printing kept, no wants (none were set).
    expect(await slots(d)).toEqual([
      { ...BOLT, quantity: 2, board: 'main' },
      { ...GOYF, quantity: 1, board: 'main' },
    ]);
    expect((await rawEvents()).every((e) => e.batchId === 'B')).toBe(true);
  });

  test('a board move undoes back to where it was', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'm', deckId: d, ...BOLT, quantity: 2 });
    await moveDeckCard('m', 'side');
    const batchId = (await rawEvents())[0]!.batchId!;
    tick();
    expect((await undoEntry({ type: 'batch', batchId })).undone).toBe(true);
    expect(await slots(d)).toEqual([{ ...BOLT, quantity: 2, board: 'main' }]);
  });

  test('a trade undo restores given and received copies, wishes, and drops the trade row', async () => {
    await db.oracleCards.put(oracle(GOYF.oracleId, 'Tarmogoyf'));
    await seedEntry({ id: 'bolt', quantity: 1 });
    await db.wishlist.put({ id: 'w', oracleId: GOYF.oracleId, scryfallId: null, quantity: 1, createdAt: 1, updatedAt: 1 });
    await applyCompletedTrade('T', [line({ quantity: 2 })], [line({ ...GOYF, name: 'Tarmogoyf' })]);
    tick();
    const undone = await undoEntry({ type: 'trade', tradeId: 'T' });
    expect(undone.undone).toBe(true);
    if (!undone.undone) return;
    expect(undone.trade).toMatchObject({ id: 'T' });
    // The backfill add and the remove net out to the one copy truly owned.
    expect(await collection()).toEqual([expect.objectContaining({ ...BOLT, quantity: 1 })]);
    expect(await wishlist()).toEqual([expect.objectContaining({ oracleId: GOYF.oracleId, quantity: 1 })]);
    expect(await db.trades.get('T')).toBeUndefined();

    tick();
    const redone = await redoEntry({ events: undone.events, trade: undone.trade, since: clock - 1 });
    expect(redone.redone).toBe(true);
    expect(await db.trades.get('T')).toBeDefined();
    expect(await collection()).toEqual([expect.objectContaining({ ...GOYF, quantity: 1 })]);
  });

  test('the conflict guard: a newer change to the same row blocks undo; a different row does not', async () => {
    await addToCollection({ ...BOLT, ...copy, eventId: 'first' });
    tick();
    await addToCollection({ ...GOYF, ...copy, eventId: 'unrelated' });
    tick();
    expect((await undoEntry({ type: 'single', id: 'first' })).undone).toBe(true);

    await addToCollection({ ...BOLT, ...copy, eventId: 'older' });
    tick();
    await addToCollection({ ...BOLT, ...copy, eventId: 'newer' });
    tick();
    expect(await undoEntry({ type: 'single', id: 'older' })).toEqual({ undone: false, reason: 'conflict' });
    expect(await db.events.get('older')).toBeDefined();
  });

  test('the redo guard: a change to the same row since the undo blocks it, unless it is our own', async () => {
    await addToCollection({ ...BOLT, ...copy, eventId: 'a' });
    tick();
    const undone = await undoEntry({ type: 'single', id: 'a' });
    if (!undone.undone) throw new Error('expected undo');
    const since = clock;
    tick();
    await addToCollection({ ...BOLT, ...copy, eventId: 'later' });
    tick();
    expect(await redoEntry({ events: undone.events, since })).toEqual({ redone: false, reason: 'conflict' });
    expect(await redoEntry({ events: undone.events, since, ownEventIds: new Set(['later']) })).toMatchObject({ redone: true });
  });

  test('tradelist.mark undoes by lowering the flag', async () => {
    await seedEntry({ id: 'e', quantity: 2 });
    await markOwnedForTrade([{ ...BOLT, ...copy, quantity: 2 }], { batchId: 'M' });
    tick();
    await undoEntry({ type: 'batch', batchId: 'M' });
    expect((await db.collection.get('e'))!.quantityForTrade).toBe(0);
  });

  test('wish.add / wish.remove undo symmetrically', async () => {
    await addToWishlist({ oracleId: BOLT.oracleId, quantity: 2, eventId: 'wa' });
    tick();
    const w = (await db.wishlist.toArray())[0]!;
    await removeFromWishlist(w.id, 1);
    const rm = (await rawEvents()).find((e) => e.kind === 'wish.remove')!;
    tick();
    expect((await undoEntry({ type: 'single', id: rm.id })).undone).toBe(true);
    expect(await db.wishlist.get(w.id)).toMatchObject({ quantity: 2 });
    tick();
    expect((await undoEntry({ type: 'single', id: 'wa' })).undone).toBe(true);
    expect(await db.wishlist.count()).toBe(0);
  });
});

// ===========================================================================
// History edits
// ===========================================================================

describe('editUserEvent', () => {
  test('patches the editable fields and bumps updatedAt only', async () => {
    await addToCollection({ ...BOLT, ...copy, eventId: 'e' });
    const ts = clock;
    tick();
    await editUserEvent('e', { priceEurCents: 99, reason: 'lost' });
    expect(await db.events.get('e')).toMatchObject({ ts, updatedAt: clock, priceEurCents: 99, reason: 'lost' });
  });
});

// ===========================================================================
// The rest of the container writers
// ===========================================================================

describe('container odds and ends', () => {
  test('setDeckEmblem sanitizes on the way in; an unusable emblem clears it', async () => {
    const d = await createContainer('Burn');
    await setDeckEmblem(d, { type: 'set', set: 'M10', color: 'nope' as never });
    expect((await db.decks.get(d))!.emblem).toEqual({ type: 'set', set: 'm10' });
    await setDeckEmblem(d, { type: 'symbol', symbol: 'not valid!' });
    expect(await db.decks.get(d)).not.toHaveProperty('emblem');
  });

  test('tidyDeckBoards sends a stray companion back to the sideboard, decks only', async () => {
    const d = await createContainer('Burn', 'deck', 'modern');
    await seedSlot({ id: 'c', deckId: d, board: 'companion' });
    expect(await tidyDeckBoards(d)).toBe(1);
    expect(await db.deckCards.get('c')).toMatchObject({ board: 'side' });
    const b = await createContainer('Binder', 'binder');
    await seedSlot({ id: 'bc', deckId: b, board: 'companion' });
    expect(await tidyDeckBoards(b)).toBe(0);
    expect(await events()).toEqual([]);
  });

  test('setCardBehavior writes, clears with a tombstone stamped after the row, skips a no-op clear', async () => {
    await setCardBehavior('d', BOLT.oracleId, { v: 1, rules: [{ kind: 'x' }] } as never);
    const row = (await db.deckBehaviors.toArray())[0]!;
    expect(row).toMatchObject({ deckId: 'd', oracleId: BOLT.oracleId, updatedAt: clock });
    // A row from a device whose clock runs ahead: the clear must still win.
    await db.deckBehaviors.put({ ...row, updatedAt: clock + 5000 });
    await setCardBehavior('d', BOLT.oracleId, { v: 1, rules: [] } as never);
    expect(await db.deckBehaviors.count()).toBe(0);
    expect(await db.outbox.get(['deckBehaviors', row.id])).toMatchObject({ deleted: true, updatedAt: clock + 5001 });
    await db.outbox.clear();
    await setCardBehavior('d', BOLT.oracleId, null);
    expect(await outbox()).toEqual([]);
  });

  test('setDeckCardChosenColor rewrites the slot and touches the deck, no event; same color is a no-op', async () => {
    const d = await createContainer('Edh', 'deck', 'commander');
    await seedSlot({ id: 'cmd', deckId: d, board: 'commander' });
    tick();
    await setDeckCardChosenColor('cmd', 'R');
    expect(await db.deckCards.get('cmd')).toMatchObject({ chosenColor: 'R', updatedAt: clock });
    expect((await db.decks.get(d))!.updatedAt).toBe(clock);
    await db.outbox.clear();
    await setDeckCardChosenColor('cmd', 'R');
    expect(await outbox()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  test('unfileWholeContainer frees every filed copy; countFiledCopies counts them first', async () => {
    const d = await createContainer('Burn');
    await seedSlot({ id: 'a', deckId: d, ...BOLT, ...copy, quantity: 3 });
    await seedSlot({ id: 'b', deckId: d, ...GOYF });
    await seedSlot({ id: 'c', deckId: d, oracleId: ISLAND.oracleId, anyBasic: true, quantity: 5 });
    expect(await countFiledCopies(d)).toBe(3);
    expect(await unfileWholeContainer(d)).toBe(3);
    expect(await countFiledCopies(d)).toBe(0);
    expect(await events()).toEqual([]);
  });
});

// ===========================================================================
// Sealed, and the whole-device writers
// ===========================================================================

describe('sealed items', () => {
  const box = { productId: 'p1', name: 'M10 Booster Box', set: 'm10' };

  test('add merges by product, clamps, refreshes display fields; quantity 0 removes; no events', async () => {
    const first = await addSealedItem(box, 2.7);
    expect(first).toMatchObject({ productId: 'p1', quantity: 2 });
    const again = await addSealedItem({ ...box, setName: 'Magic 2010', tcgplayerId: '42' }, 0);
    expect(again).toMatchObject({ id: first.id, quantity: 3, setName: 'Magic 2010', tcgplayerId: '42' });
    await setSealedItemQuantity(first.id, 20_000);
    expect((await db.sealedItems.get(first.id))!.quantity).toBe(9999);
    await removeSealedItem(first.id);
    expect(await db.sealedItems.count()).toBe(0);
    expect(await outbox()).toEqual([`sealedItems:${first.id}:del`]);
    expect(await events()).toEqual([]);
  });
});

describe('whole-device writers', () => {
  const empty = {
    collection: [],
    sealedItems: [],
    wishlist: [],
    decks: [],
    deckCards: [],
    deckFolders: [],
    deckBehaviors: [],
    trades: [],
    priceHistories: [],
    sealedPriceHistories: [],
    events: [],
  };

  test('replaceAllUserData wipes and restores every table (folders included) and clears the outbox', async () => {
    await addToCollection({ ...BOLT, ...copy });
    const folder = { id: 'f', name: 'Modern', createdAt: 1, updatedAt: 1 };
    const entry: CollectionEntry = { id: 'g', ...GOYF, ...copy, quantity: 1, quantityForTrade: 0, createdAt: 1, updatedAt: 1 };
    await replaceAllUserData({ ...empty, collection: [entry], deckFolders: [folder] });
    expect(await db.collection.toArray()).toEqual([entry]);
    expect(await db.deckFolders.toArray()).toEqual([folder]);
    expect(await db.events.count()).toBe(0);
    expect(await outbox()).toEqual([]);
  });

  test('replaceAllUserData refuses while signed in', async () => {
    await setSetting('accountSession', { token: 't', username: 'u' });
    await addToCollection({ ...BOLT, ...copy });
    await expect(replaceAllUserData(empty)).rejects.toThrow(/Sign out/);
    expect(await db.collection.count()).toBe(1);
  });

  test('deleteAllUserData empties user tables and the outbox, keeps the card DB', async () => {
    await db.oracleCards.put(oracle(BOLT.oracleId, 'Lightning Bolt'));
    await addToCollection({ ...BOLT, ...copy });
    await deleteAllUserData();
    expect(await db.collection.count()).toBe(0);
    expect(await db.events.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.oracleCards.count()).toBe(1);
  });
});
