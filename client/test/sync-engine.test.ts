import { beforeEach, describe, expect, test } from 'vitest';
import type { SyncChange, SyncTable, CollectionEntry } from '@mtg/shared';
import { db } from '../src/db/schema.js';
import { applyServerChanges, ackOutbox } from '../src/sync/engine.js';

// applyServerChanges against a real (fake-indexeddb) Dexie instance: the LWW
// rules, the outbox interplay, and the unknown-table cursor stop — the exact
// behaviors whose absence cost the four repair releases.

const entry = (over: Partial<CollectionEntry> = {}): CollectionEntry => ({
  id: 'e1',
  oracleId: 'o1',
  scryfallId: 's1',
  condition: 'NM',
  finish: 'nonfoil',
  lang: 'en',
  quantity: 1,
  quantityForTrade: 0,
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

const change = (over: Partial<SyncChange> = {}): SyncChange => ({
  tbl: 'collection',
  rowId: 'e1',
  updatedAt: 1000,
  row: entry(),
  seq: 1,
  ...over,
});

beforeEach(async () => {
  await Promise.all([db.collection.clear(), db.decks.clear(), db.trades.clear(), db.outbox.clear()]);
});

describe('applyServerChanges', () => {
  test('applies puts and deletes, returns null when everything landed', async () => {
    const blocked = await applyServerChanges([
      change(),
      change({ rowId: 'e2', row: entry({ id: 'e2' }), seq: 2 }),
    ]);
    expect(blocked).toBeNull();
    expect(await db.collection.count()).toBe(2);

    await applyServerChanges([change({ rowId: 'e2', updatedAt: 2000, deleted: true, row: undefined, seq: 3 })]);
    expect(await db.collection.get('e2')).toBeUndefined();
    expect(await db.collection.get('e1')).toBeDefined();
  });

  test('LWW: an older incoming change never clobbers a newer local row', async () => {
    await db.collection.put(entry({ quantity: 7, updatedAt: 5000 }));
    await applyServerChanges([change({ updatedAt: 4000, row: entry({ quantity: 1, updatedAt: 4000 }) })]);
    expect((await db.collection.get('e1'))!.quantity).toBe(7);

    // …including an older tombstone.
    await applyServerChanges([change({ updatedAt: 4500, deleted: true, row: undefined })]);
    expect(await db.collection.get('e1')).toBeDefined();

    // A newer incoming change wins.
    await applyServerChanges([change({ updatedAt: 6000, row: entry({ quantity: 2, updatedAt: 6000 }) })]);
    expect((await db.collection.get('e1'))!.quantity).toBe(2);
  });

  test('LWW for trades falls back to completedAt (immutable rows)', async () => {
    await db.trades.put({ id: 't1', completedAt: 5000, partner: null, given: [], received: [] });
    await applyServerChanges([
      { tbl: 'trades', rowId: 't1', updatedAt: 4000, row: { id: 't1', completedAt: 4000, partner: 'someone_else', given: [], received: [] } },
    ]);
    expect((await db.trades.get('t1'))!.partner).toBeNull();
  });

  test('a newer pending local change beats the incoming row and stays in the outbox', async () => {
    await db.collection.put(entry({ quantity: 3, updatedAt: 9000 }));
    await db.outbox.put({ tbl: 'collection', rowId: 'e1', updatedAt: 9000, row: entry({ quantity: 3, updatedAt: 9000 }) });

    await applyServerChanges([change({ updatedAt: 8000, row: entry({ quantity: 1, updatedAt: 8000 }) })]);
    expect((await db.collection.get('e1'))!.quantity).toBe(3);
    expect(await db.outbox.get(['collection', 'e1'])).toBeDefined();
  });

  test('an applied incoming row supersedes and drops the older pending change', async () => {
    await db.collection.put(entry({ quantity: 3, updatedAt: 1000 }));
    await db.outbox.put({ tbl: 'collection', rowId: 'e1', updatedAt: 1000, row: entry({ quantity: 3 }) });

    await applyServerChanges([change({ updatedAt: 2000, row: entry({ quantity: 5, updatedAt: 2000 }) })]);
    expect((await db.collection.get('e1'))!.quantity).toBe(5);
    expect(await db.outbox.get(['collection', 'e1'])).toBeUndefined();
  });

  test('an unknown table blocks the cursor at its first seq; known changes still apply', async () => {
    const blocked = await applyServerChanges([
      change({ seq: 10 }),
      { tbl: 'linenBinders' as SyncTable, rowId: 'x1', updatedAt: 1, row: {}, seq: 11 },
      change({ rowId: 'e2', row: entry({ id: 'e2' }), seq: 12 }),
      { tbl: 'linenBinders' as SyncTable, rowId: 'x2', updatedAt: 1, row: {}, seq: 13 },
    ]);
    expect(blocked).toBe(11);
    expect(await db.collection.count()).toBe(2);
  });

  test('a seq-less unknown table (old server) reports 0: do not advance at all', async () => {
    const blocked = await applyServerChanges([{ tbl: 'linenBinders' as SyncTable, rowId: 'x1', updatedAt: 1, row: {} }]);
    expect(blocked).toBe(0);
  });

  test('a corrupt row is skipped without dropping the pending local change it would beat', async () => {
    await db.outbox.put({ tbl: 'collection', rowId: 'e1', updatedAt: 1000, row: entry() });

    // Missing oracleId → sanitizer rejects; id ≠ rowId → mismatch rejects.
    await applyServerChanges([
      change({ updatedAt: 2000, row: { id: 'e1', scryfallId: 's1', quantity: 1, updatedAt: 2000 } }),
      change({ updatedAt: 2000, row: entry({ id: 'other-id', updatedAt: 2000 }) }),
    ]);
    expect(await db.collection.get('e1')).toBeUndefined();
    expect(await db.outbox.get(['collection', 'e1'])).toBeDefined();
  });

  test('a field this build does not know survives the trip into Dexie', async () => {
    const row = { ...entry(), fieldFromTheFuture: 'keep me' };
    await applyServerChanges([change({ row })]);
    expect(((await db.collection.get('e1')) as unknown as Record<string, unknown>).fieldFromTheFuture).toBe('keep me');
  });
});

describe('ackOutbox', () => {
  test('drops acked entries but keeps ones replaced mid-flight', async () => {
    const pushed: SyncChange[] = [
      { tbl: 'collection', rowId: 'e1', updatedAt: 1000, row: entry() },
      { tbl: 'collection', rowId: 'e2', updatedAt: 1000, row: entry({ id: 'e2' }) },
      { tbl: 'collection', rowId: 'e3', updatedAt: 1000, deleted: true },
    ];
    // e1 as pushed; e2 replaced by a newer local edit; e3 tombstone as pushed.
    await db.outbox.bulkPut([
      { tbl: 'collection', rowId: 'e1', updatedAt: 1000, row: entry() },
      { tbl: 'collection', rowId: 'e2', updatedAt: 2000, row: entry({ id: 'e2', quantity: 4 }) },
      { tbl: 'collection', rowId: 'e3', updatedAt: 1000, deleted: true },
    ]);

    await ackOutbox(pushed);
    expect(await db.outbox.get(['collection', 'e1'])).toBeUndefined();
    expect(await db.outbox.get(['collection', 'e2'])).toBeDefined();
    expect(await db.outbox.get(['collection', 'e3'])).toBeUndefined();
  });

  test('a pushed put does not ack a tombstone staged at the same stamp', async () => {
    await db.outbox.put({ tbl: 'collection', rowId: 'e1', updatedAt: 1000, deleted: true });
    await ackOutbox([{ tbl: 'collection', rowId: 'e1', updatedAt: 1000, row: entry() }]);
    expect(await db.outbox.get(['collection', 'e1'])).toBeDefined();
  });
});
