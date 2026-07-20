import type { SyncTable } from '@mtg/shared';
import { db } from '../db/schema.js';

// Sync outbox staging. Every dataAccess mutation stages the latest state of
// each touched row here, inside the same Dexie transaction (db.outbox must be
// in the transaction scope). The sync engine drains the outbox when signed in;
// signed out it is cheap bookkeeping that a later first-login seed ignores
// (seeding reads the full tables, not the outbox).
//
// One entry per (tbl, rowId) — a newer local change replaces the pending one,
// which is exactly last-write-wins from the server's point of view.
//
// Applying changes RECEIVED from the server must bypass dataAccess entirely
// (write tables directly), so remote rows are never re-staged.

/** Rows carry their own LWW timestamp under one of these names. */
type StampedRow = { id: string } & (
  | { updatedAt: number }
  | { completedAt: number }
);

function stampOf(row: StampedRow): number {
  return 'updatedAt' in row ? row.updatedAt : row.completedAt;
}

/** Stage an upsert: the row's current full state. */
export async function stagePut(tbl: SyncTable, row: StampedRow): Promise<void> {
  await db.outbox.put({ tbl, rowId: row.id, updatedAt: stampOf(row), row });
}

/** Stage many upserts in one write (bulk imports/seeds). */
export async function stagePutMany(tbl: SyncTable, rows: StampedRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.outbox.bulkPut(rows.map((row) => ({ tbl, rowId: row.id, updatedAt: stampOf(row), row })));
}

/** Stage a delete (tombstone). */
export async function stageDelete(tbl: SyncTable, rowId: string): Promise<void> {
  await db.outbox.put({ tbl, rowId, updatedAt: Date.now(), deleted: true });
}
