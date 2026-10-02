import { describe, expect, test } from 'vitest';
import {
  CARD_BEHAVIOR_VERSION,
  CONDITIONS,
  EVENT_SOURCES,
  FINISHES,
  REMOVAL_REASONS,
  SYNC_MAX_ROW_ID,
  type CollectionEntry,
  type Deck,
  type DeckCard,
  type UserEvent,
} from '@mtg/shared';
import {
  PAYLOAD_VERSION,
  sanitizeCollectionRow,
  sanitizeDeckBehaviorRow,
  sanitizeDeckCardRow,
  sanitizeDeckRow,
  sanitizeEventRow,
  sanitizeSealedItemRow,
  sanitizeSyncedRow,
  sanitizeTradeRow,
  sanitizeTransferPayload,
  sanitizeWishlistRow,
  type TransferPayload,
} from '../src/transfer/payload.js';

// Rows the loose way a hostile/ancient sender would send them: everything is
// unknown, the sanitizer must come back with a row the app can store, or null.

const collectionRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'e1',
  oracleId: 'o1',
  scryfallId: 's1',
  condition: 'NM',
  finish: 'nonfoil',
  lang: 'en',
  quantity: 2,
  quantityForTrade: 1,
  createdAt: 1000,
  updatedAt: 2000,
  ...over,
});

describe('sanitizeCollectionRow', () => {
  test('passes a well-formed row through unchanged', () => {
    expect(sanitizeCollectionRow(collectionRow())).toEqual(collectionRow());
  });

  test('rejects non-objects and rows missing a required id', () => {
    expect(sanitizeCollectionRow(null)).toBeNull();
    expect(sanitizeCollectionRow('row')).toBeNull();
    expect(sanitizeCollectionRow(collectionRow({ id: '' }))).toBeNull();
    expect(sanitizeCollectionRow(collectionRow({ oracleId: 42 }))).toBeNull();
    expect(sanitizeCollectionRow(collectionRow({ scryfallId: undefined }))).toBeNull();
  });

  test('defaults unknown enums instead of dropping the row', () => {
    const clean = sanitizeCollectionRow(collectionRow({ condition: 'Mint++', finish: 'glitter', lang: '' }))!;
    expect(clean.condition).toBe('NM');
    expect(clean.finish).toBe('nonfoil');
    expect(clean.lang).toBe('en');
  });

  test('clamps quantities and caps quantityForTrade at quantity', () => {
    const clean = sanitizeCollectionRow(collectionRow({ quantity: 3, quantityForTrade: 99 }))!;
    expect(clean.quantityForTrade).toBe(3);
    expect(sanitizeCollectionRow(collectionRow({ quantity: -5 }))!.quantity).toBe(1);
    expect(sanitizeCollectionRow(collectionRow({ quantity: 1e9 }))!.quantity).toBe(9999);
    expect(sanitizeCollectionRow(collectionRow({ quantity: 'many' }))!.quantity).toBe(1);
    expect(sanitizeCollectionRow(collectionRow({ quantityForTrade: -1 }))!.quantityForTrade).toBe(0);
  });

  test('bounds ids to SYNC_MAX_ROW_ID characters', () => {
    const clean = sanitizeCollectionRow(collectionRow({ id: 'x'.repeat(500) }))!;
    expect(clean.id).toHaveLength(SYNC_MAX_ROW_ID);
  });

  test('normalizes special conditions to a fixed deduped order, junk absent', () => {
    const a = sanitizeCollectionRow(collectionRow({ special: ['signed', 'altered', 'signed'] }))!;
    const b = sanitizeCollectionRow(collectionRow({ special: ['altered', 'signed'] }))!;
    expect(a.special).toEqual(b.special);
    expect(a.special).toHaveLength(2);
    expect(sanitizeCollectionRow(collectionRow({ special: ['sparkly'] }))!.special).toBeUndefined();
    expect(sanitizeCollectionRow(collectionRow({ special: 'signed' }))!.special).toBeUndefined();
  });

  test('replaces unparseable timestamps rather than storing NaN', () => {
    const clean = sanitizeCollectionRow(collectionRow({ createdAt: 'yesterday', updatedAt: -3 }))!;
    expect(clean.createdAt).toBeGreaterThan(0);
    expect(clean.updatedAt).toBeGreaterThan(0);
  });
});

describe('sanitizeWishlistRow', () => {
  test('preferences stay undefined ("any") on junk instead of being defaulted', () => {
    const clean = sanitizeWishlistRow({ id: 'w1', oracleId: 'o1', condition: 'x', finish: 'x', quantity: 1, createdAt: 5 })!;
    expect(clean.condition).toBeUndefined();
    expect(clean.finish).toBeUndefined();
    expect(clean.lang).toBeUndefined();
    expect(clean.scryfallId).toBeNull();
  });

  test('pre-v0.11 senders without updatedAt get createdAt as the LWW stamp', () => {
    const clean = sanitizeWishlistRow({ id: 'w1', oracleId: 'o1', quantity: 1, createdAt: 1234 })!;
    expect(clean.updatedAt).toBe(1234);
  });
});

describe('sanitizeSealedItemRow', () => {
  test('requires id and productId, placeholders the rest', () => {
    expect(sanitizeSealedItemRow({ id: 'i1' })).toBeNull();
    const clean = sanitizeSealedItemRow({ id: 'i1', productId: 'p1', name: '  ', set: 'BLB' })!;
    expect(clean.name).toBe('Sealed product');
    expect(clean.set).toBe('blb');
    expect(clean.quantity).toBe(1);
  });
});

describe('sanitizeDeckRow', () => {
  const deck = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'd1',
    name: 'Goblins',
    kind: 'deck',
    format: 'commander',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  });

  test('a missing or unknown kind is a deck with a format', () => {
    expect(sanitizeDeckRow(deck({ kind: undefined }))!.kind).toBe('deck');
    expect(sanitizeDeckRow(deck({ kind: 'shoebox' }))!.kind).toBe('deck');
    expect(sanitizeDeckRow(deck({ format: 'silly' }))!.format).toBe('casual');
  });

  test('a binder never gains deck-only fields', () => {
    const clean = sanitizeDeckRow(deck({ kind: 'binder', format: 'commander', folderId: 'f1', archivedAt: 123 }))!;
    expect(clean.kind).toBe('binder');
    expect(clean).not.toHaveProperty('format');
    expect(clean).not.toHaveProperty('folderId');
    expect(clean).not.toHaveProperty('archivedAt');
  });

  test('a bad archivedAt means "not archived", never "archived now"', () => {
    expect(sanitizeDeckRow(deck({ archivedAt: 'oops' }))).not.toHaveProperty('archivedAt');
    expect(sanitizeDeckRow(deck({ archivedAt: 500 }))!.archivedAt).toBe(500);
  });

  test('blank names get a placeholder', () => {
    expect(sanitizeDeckRow(deck({ name: '   ' }))!.name).toBe('Untitled deck');
  });
});

describe('sanitizeDeckCardRow', () => {
  const slot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'c1',
    deckId: 'd1',
    oracleId: 'o1',
    scryfallId: 's1',
    quantity: 4,
    board: 'main',
    updatedAt: 1,
    ...over,
  });

  test('anyBasic wins over a pinned printing, wants and unfiled', () => {
    const clean = sanitizeDeckCardRow(slot({ anyBasic: true, finish: 'foil', unfiled: true }))!;
    expect(clean.anyBasic).toBe(true);
    expect(clean).not.toHaveProperty('scryfallId');
    expect(clean).not.toHaveProperty('finish');
    expect(clean).not.toHaveProperty('unfiled');
  });

  test('unknown board falls back to main; only real colors survive chosenColor', () => {
    expect(sanitizeDeckCardRow(slot({ board: 'maybeboard' }))!.board).toBe('main');
    expect(sanitizeDeckCardRow(slot({ chosenColor: 'P' }))).not.toHaveProperty('chosenColor');
    expect(sanitizeDeckCardRow(slot({ chosenColor: 'W' }))!.chosenColor).toBe('W');
  });

  test('tags are deduped case-insensitively and sorted', () => {
    const clean = sanitizeDeckCardRow(slot({ tags: ['Ramp', 'ramp', ' Draw '] }))!;
    expect(clean.tags).toEqual(['Draw', 'Ramp']);
  });
});

describe('sanitizeDeckBehaviorRow', () => {
  const behavior = {
    v: CARD_BEHAVIOR_VERSION,
    rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }],
  };

  test('keeps a row whose behavior parses', () => {
    const clean = sanitizeDeckBehaviorRow({ id: 'd1:o1', deckId: 'd1', oracleId: 'o1', behavior, updatedAt: 1 });
    expect(clean).not.toBeNull();
    expect(clean!.behavior.rules).toHaveLength(1);
  });

  test('drops the whole row when the behavior does not survive', () => {
    expect(sanitizeDeckBehaviorRow({ id: 'd1:o1', deckId: 'd1', oracleId: 'o1', behavior: { v: 999, rules: [] }, updatedAt: 1 })).toBeNull();
    expect(sanitizeDeckBehaviorRow({ id: 'd1:o1', deckId: 'd1', oracleId: 'o1', behavior: 'draw a card', updatedAt: 1 })).toBeNull();
  });
});

describe('sanitizeTradeRow', () => {
  test('enforces the username shape and sanitizes both offers', () => {
    const line = { oracleId: 'o1', scryfallId: 's1', name: 'Lightning Bolt', quantity: 1, condition: 'NM', finish: 'nonfoil', lang: 'en' };
    const clean = sanitizeTradeRow({ id: 't1', completedAt: 9, partner: 'ok_name', given: [line, { junk: true }], received: 'nope' })!;
    expect(clean.partner).toBe('ok_name');
    expect(clean.given).toEqual([line]);
    expect(clean.received).toEqual([]);
    expect(sanitizeTradeRow({ id: 't1', completedAt: 9, partner: 'has spaces!' })!.partner).toBeNull();
  });
});

describe('sanitizeEventRow', () => {
  const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'ev1',
    ts: 100,
    updatedAt: 100,
    kind: 'collection.add',
    oracleId: 'o1',
    ...over,
  });

  test('requires a known kind', () => {
    expect(sanitizeEventRow(event({ kind: 'collection.teleport' }))).toBeNull();
    expect(sanitizeEventRow(event())).not.toBeNull();
  });

  test('keeps provenance fields (source, batchId, batchLabel)', () => {
    const source = EVENT_SOURCES[0]!;
    const clean = sanitizeEventRow(event({ source, batchId: 'b1', batchLabel: 'CSV import' }))!;
    expect(clean.source).toBe(source);
    expect(clean.batchId).toBe('b1');
    expect(clean.batchLabel).toBe('CSV import');
  });

  test('optional fields appear only when sent; enums are enforced', () => {
    const clean = sanitizeEventRow(event())!;
    expect(clean).not.toHaveProperty('qty');
    expect(clean).not.toHaveProperty('priceEurCents');
    const reason = REMOVAL_REASONS[0]!;
    const rich = sanitizeEventRow(event({ qty: 3, priceEurCents: 12.7, reason, condition: CONDITIONS[0], finish: FINISHES[0] }))!;
    expect(rich.qty).toBe(3);
    expect(rich.priceEurCents).toBe(13);
    expect(rich.reason).toBe(reason);
    expect(sanitizeEventRow(event({ reason: 'vanished' }))).not.toHaveProperty('reason');
    expect(sanitizeEventRow(event({ priceEurCents: 'free' }))!.priceEurCents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitizeSyncedRow: the same sanitizers, plus preserveUnknown. This is the
// mechanism that ended the repair-release era (v0.75.1 … v0.135.3), so its
// contract gets spelled out in full.
// ---------------------------------------------------------------------------

describe('sanitizeSyncedRow (preserveUnknown)', () => {
  test('a field this build has never heard of rides through untouched', () => {
    const raw = collectionRow({ someFutureField: { nested: true }, anotherOne: 7 });
    const clean = sanitizeSyncedRow('collection', raw) as Record<string, unknown>;
    expect(clean.someFutureField).toEqual({ nested: true });
    expect(clean.anotherOne).toBe(7);
    expect((clean as unknown as CollectionEntry).quantity).toBe(2);
  });

  test('known keys always take the sanitizer value (a binder keeps losing a stray format)', () => {
    const raw = { id: 'd1', name: 'Bulk binder', kind: 'binder', format: 'commander', createdAt: 1, updatedAt: 2 };
    const clean = sanitizeSyncedRow('decks', raw) as Deck;
    expect(clean.kind).toBe('binder');
    expect(clean).not.toHaveProperty('format');
  });

  test('an unknown key one level down survives (the emblem.color story, v0.133.2)', () => {
    const raw = {
      id: 'd1', name: 'X', kind: 'deck', format: 'casual', createdAt: 1, updatedAt: 2,
      emblem: { type: 'set', set: 'blb', futureKnob: 'shiny' },
    };
    const clean = sanitizeSyncedRow('decks', raw) as Record<string, unknown>;
    expect((clean.emblem as Record<string, unknown>).set).toBe('blb');
    expect((clean.emblem as Record<string, unknown>).futureKnob).toBe('shiny');
  });

  test('prototype-polluting keys never ride through', () => {
    const raw = JSON.parse(
      `{"id":"e1","oracleId":"o1","scryfallId":"s1","quantity":1,"quantityForTrade":0,"createdAt":1,"updatedAt":2,"__proto__":{"polluted":true},"constructor":{"bad":1}}`,
    );
    const clean = sanitizeSyncedRow('collection', raw) as Record<string, unknown>;
    expect(Object.keys(clean)).not.toContain('__proto__');
    expect(Object.hasOwn(clean, 'constructor')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('a row the sanitizer rejects stays rejected', () => {
    expect(sanitizeSyncedRow('collection', { futureField: 1 })).toBeNull();
    expect(sanitizeSyncedRow('trades', null)).toBeNull();
  });

  test('a slot with unfiled keeps it on the sync path (the v0.135.3 bug shape)', () => {
    const raw = { id: 'c1', deckId: 'd1', oracleId: 'o1', scryfallId: 's1', quantity: 1, board: 'main', unfiled: true, updatedAt: 1 };
    const clean = sanitizeSyncedRow('deckCards', raw) as DeckCard;
    expect(clean.unfiled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Variants: an enum value this build has never seen (the v0.187.0 formats, the
// v0.188.0 zones) rides through on the sync path, so a release that adds one
// needs no repair re-pull. The transfer path keeps coercing.
// ---------------------------------------------------------------------------

describe('sanitizeSyncedRow (variants of known enums)', () => {
  const slot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'c1', deckId: 'd1', oracleId: 'o1', scryfallId: 's1', quantity: 1, board: 'main', updatedAt: 1, ...over,
  });

  test('a zone this build does not know stays on the slot (the v0.188.0 bug shape)', () => {
    expect((sanitizeSyncedRow('deckCards', slot({ board: 'wishboard' })) as DeckCard).board).toBe('wishboard');
    // The transfer path still coerces: a stranger's rows are rebuilt.
    expect(sanitizeDeckCardRow(slot({ board: 'wishboard' }))!.board).toBe('main');
  });

  test('a format this build does not know stays on the deck (the v0.187.0 bug shape)', () => {
    const raw = { id: 'd1', name: 'X', kind: 'deck', format: 'oathbreaker', createdAt: 1, updatedAt: 2 };
    expect((sanitizeSyncedRow('decks', raw) as Deck).format).toBe('oathbreaker');
    expect(sanitizeDeckRow(raw)!.format).toBe('casual');
  });

  test('an unknown finish, condition, reason, source and event kind ride through', () => {
    const entry = sanitizeSyncedRow('collection', collectionRow({ finish: 'gilded', condition: 'PSA10' })) as CollectionEntry;
    expect(entry.finish).toBe('gilded');
    expect(entry.condition).toBe('PSA10');
    const ev = sanitizeSyncedRow('events', {
      id: 'ev1', ts: 1, updatedAt: 1, kind: 'collection.lend', oracleId: 'o1', reason: 'eaten', source: 'telepathy', board: 'wishboard',
    }) as UserEvent;
    expect(ev.kind).toBe('collection.lend');
    expect(ev.reason).toBe('eaten');
    expect(ev.source).toBe('telepathy');
    expect(ev.board).toBe('wishboard');
    // Transfer path: an unknown kind still drops the event.
    expect(sanitizeEventRow({ id: 'ev1', ts: 1, updatedAt: 1, kind: 'collection.lend', oracleId: 'o1' })).toBeNull();
  });

  test('a value the sanitizer dropped on purpose stays dropped (known values are not variants)', () => {
    // anyBasic wins over a pinned finish the build DOES know.
    const basic = sanitizeSyncedRow('deckCards', slot({ anyBasic: true, finish: 'foil' })) as DeckCard;
    expect(basic).not.toHaveProperty('finish');
    // A binder keeps losing a stray (known) format.
    const binder = sanitizeSyncedRow('decks', { id: 'd1', name: 'B', kind: 'binder', format: 'commander', createdAt: 1, updatedAt: 2 }) as Deck;
    expect(binder).not.toHaveProperty('format');
  });

  test('a variant is a short string: junk shapes and long strings are still coerced', () => {
    expect((sanitizeSyncedRow('deckCards', slot({ board: 42 })) as DeckCard).board).toBe('main');
    expect((sanitizeSyncedRow('deckCards', slot({ board: '' })) as DeckCard).board).toBe('main');
    expect((sanitizeSyncedRow('deckCards', slot({ board: 'x'.repeat(41) })) as DeckCard).board).toBe('main');
    expect((sanitizeSyncedRow('deckCards', slot({ board: { nested: true } })) as DeckCard).board).toBe('main');
  });

  test('container kind and deckKind are NOT variants: they index CONTAINER_META everywhere', () => {
    const raw = { id: 'd1', name: 'X', kind: 'shoebox', createdAt: 1, updatedAt: 2 };
    expect((sanitizeSyncedRow('decks', raw) as Deck).kind).toBe('deck');
    const ev = sanitizeSyncedRow('events', { id: 'ev1', ts: 1, updatedAt: 1, kind: 'deck.add', oracleId: 'o1', deckKind: 'shoebox' }) as UserEvent;
    expect(ev).not.toHaveProperty('deckKind');
  });

  test('a card behavior is stored whole on the sync path, grammar this build cannot read included', () => {
    const future = { v: CARD_BEHAVIOR_VERSION + 1, rules: [{ on: 'etb', steps: [{ op: 'teleport' }] }] };
    const row = { id: 'd1:o1', deckId: 'd1', oracleId: 'o1', behavior: future, updatedAt: 1 };
    const clean = sanitizeSyncedRow('deckBehaviors', row) as unknown as { behavior: unknown };
    expect(clean.behavior).toEqual(future);
    // The transfer path stays strict all the way down.
    expect(sanitizeDeckBehaviorRow(row)).toBeNull();
    // Something that is not a behavior at all is still refused on both paths.
    expect(sanitizeSyncedRow('deckBehaviors', { ...row, behavior: 'draw a card' })).toBeNull();
    expect(sanitizeSyncedRow('deckBehaviors', { ...row, behavior: { v: 1 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The whole-payload path (device transfer): dedup, merge, cross-table checks.
// ---------------------------------------------------------------------------

const emptyPayload = (): TransferPayload => ({
  version: PAYLOAD_VERSION,
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
});

describe('sanitizeTransferPayload', () => {
  test('rejects anything that is not a v1 envelope', () => {
    expect(sanitizeTransferPayload(null)).toBeNull();
    expect(sanitizeTransferPayload({ version: 2 })).toBeNull();
    expect(sanitizeTransferPayload(emptyPayload())).toEqual(emptyPayload());
  });

  test('collection: duplicate ids dropped, identical copies merged by full identity', () => {
    const p = {
      ...emptyPayload(),
      collection: [
        collectionRow({ id: 'a', quantity: 2, quantityForTrade: 1 }),
        collectionRow({ id: 'a', quantity: 50 }), // same id → dropped
        collectionRow({ id: 'b', quantity: 3, quantityForTrade: 2 }), // same identity → merged
        collectionRow({ id: 'c', finish: 'foil', quantity: 1 }), // different identity → own row
      ],
    };
    const clean = sanitizeTransferPayload(p)!;
    expect(clean.collection).toHaveLength(2);
    const merged = clean.collection.find((e) => e.id === 'a')!;
    expect(merged.quantity).toBe(5);
    expect(merged.quantityForTrade).toBe(3);
  });

  test('wishlist and sealed items merge quantities on their identity keys', () => {
    const wish = { id: 'w1', oracleId: 'o1', scryfallId: 's1', quantity: 1, createdAt: 1, updatedAt: 1 };
    const p = {
      ...emptyPayload(),
      wishlist: [wish, { ...wish, id: 'w2', quantity: 2 }],
      sealedItems: [
        { id: 'i1', productId: 'p1', name: 'Box', set: 'blb', quantity: 1, createdAt: 1, updatedAt: 1 },
        { id: 'i2', productId: 'p1', name: 'Box', set: 'blb', quantity: 2, createdAt: 1, updatedAt: 1 },
      ],
    };
    const clean = sanitizeTransferPayload(p)!;
    expect(clean.wishlist).toHaveLength(1);
    expect(clean.wishlist[0]!.quantity).toBe(3);
    expect(clean.sealedItems).toHaveLength(1);
    expect(clean.sealedItems[0]!.quantity).toBe(3);
  });

  test('cross-table: dangling folder refs cleared, orphan slots and behaviors dropped', () => {
    const behavior = {
      v: CARD_BEHAVIOR_VERSION,
      rules: [{ on: 'etb', steps: [{ op: 'draw', x: { kind: 'fixed', n: 1 } }] }],
    };
    const p = {
      ...emptyPayload(),
      deckFolders: [{ id: 'f1', name: 'Casual', createdAt: 1, updatedAt: 1 }],
      decks: [
        { id: 'd1', name: 'A', kind: 'deck', format: 'casual', folderId: 'f1', createdAt: 1, updatedAt: 1 },
        { id: 'd2', name: 'B', kind: 'deck', format: 'casual', folderId: 'gone', createdAt: 1, updatedAt: 1 },
      ],
      deckCards: [
        { id: 'c1', deckId: 'd1', oracleId: 'o1', quantity: 1, board: 'main', updatedAt: 1 },
        { id: 'c2', deckId: 'missing-deck', oracleId: 'o1', quantity: 1, board: 'main', updatedAt: 1 },
      ],
      deckBehaviors: [
        { id: 'd1:o1', deckId: 'd1', oracleId: 'o1', behavior, updatedAt: 1 },
        { id: 'dx:o1', deckId: 'dx', oracleId: 'o1', behavior, updatedAt: 1 },
      ],
    };
    const clean = sanitizeTransferPayload(p)!;
    expect(clean.decks.find((d) => d.id === 'd1')!.folderId).toBe('f1');
    expect(clean.decks.find((d) => d.id === 'd2')).not.toHaveProperty('folderId');
    expect(clean.deckCards.map((c) => c.id)).toEqual(['c1']);
    expect(clean.deckBehaviors.map((b) => b.id)).toEqual(['d1:o1']);
  });

  test('deck slots on the same (deck, card, board) merge quantities', () => {
    const p = {
      ...emptyPayload(),
      decks: [{ id: 'd1', name: 'A', kind: 'deck', format: 'casual', createdAt: 1, updatedAt: 1 }],
      deckCards: [
        { id: 'c1', deckId: 'd1', oracleId: 'o1', quantity: 2, board: 'main', updatedAt: 1 },
        { id: 'c2', deckId: 'd1', oracleId: 'o1', quantity: 2, board: 'main', updatedAt: 1 },
        { id: 'c3', deckId: 'd1', oracleId: 'o1', quantity: 1, board: 'side', updatedAt: 1 },
      ],
    };
    const clean = sanitizeTransferPayload(p)!;
    expect(clean.deckCards).toHaveLength(2);
    expect(clean.deckCards.find((c) => c.board === 'main')!.quantity).toBe(4);
  });

  test('price histories: arrays forced to equal length, values re-bounded', () => {
    const p = {
      ...emptyPayload(),
      priceHistories: [
        { scryfallId: 's1', startDay: '2026-01-01', eur: [100, 'junk', -5], usd: [50] },
        { scryfallId: 's2', startDay: 'January 1st', eur: [1], usd: [1] }, // bad day → dropped
        { scryfallId: 's3', startDay: '2026-01-01', eur: [], usd: [] }, // empty → dropped
      ],
    };
    const clean = sanitizeTransferPayload(p)!;
    expect(clean.priceHistories).toHaveLength(1);
    const h = clean.priceHistories[0]!;
    expect(h.eur).toEqual([100, null, 0]);
    expect(h.usd).toEqual([50, null, null]);
  });

  test('legacy row-per-day priceSnapshots fold into compact histories', () => {
    const p = {
      ...emptyPayload(),
      priceHistories: [],
      priceSnapshots: [
        { scryfallId: 's1', day: '2026-01-03', eur: 2.5, usd: null },
        { scryfallId: 's1', day: '2026-01-01', eur: 1.5, usd: 2.0 },
      ],
    };
    const clean = sanitizeTransferPayload(p as unknown)!;
    expect(clean.priceHistories).toHaveLength(1);
    const h = clean.priceHistories[0]!;
    expect(h.startDay).toBe('2026-01-01');
    expect(h.eur[0]).toBe(150);
    expect(h.eur[2]).toBe(250);
  });

  test('events: bad kinds and duplicate ids dropped', () => {
    const ev: UserEvent = { id: 'ev1', ts: 1, updatedAt: 1, kind: 'collection.add', oracleId: 'o1' };
    const p = { ...emptyPayload(), events: [ev, { ...ev }, { ...ev, id: 'ev2', kind: 'nope' }] };
    const clean = sanitizeTransferPayload(p)!;
    expect(clean.events.map((e) => e.id)).toEqual(['ev1']);
  });
});
