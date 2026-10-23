import type { DatabaseSync } from 'node:sqlite';

/** Size of the database file proper, from SQLite's own page accounting (WAL not included). */
export function dbSizeBytes(db: DatabaseSync): number {
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const size = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return pages * size;
}
