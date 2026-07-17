import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PriceMap, PricesResponse } from '@mtg/shared';

// Server price archive (sync plan Phase E): one row per printing holding its
// whole daily price history as two parallel blobs of little-endian Uint32
// cents — index i is the day `start_day + i` (UTC), 0xFFFFFFFF marks a day
// with no reading. ~4 bytes per currency per card-day keeps 3 years of every
// Scryfall printing around 300 MB/yr. Lives in its own SQLite file (prices.db)
// so the far smaller accounts.db stays easy to back up on its own.

/** No-reading sentinel inside the blobs (a real price of ~€42M is safely absurd). */
const NULL_CENTS = 0xffffffff;

/** Retention: 3 years of days; older leading days are trimmed as rows extend. */
const RETENTION_DAYS = 3 * 366;

/** Rows whose last reading is older than this get purged entirely. */
const PURGE_AFTER_DAYS = RETENTION_DAYS;

const DAY_MS = 86_400_000;

/** Whole days from `startDay` to `day` (both YYYY-MM-DD UTC); NaN-safe → -1. */
export function dayOffset(startDay: string, day: string): number {
  const d = (Date.parse(day) - Date.parse(startDay)) / DAY_MS;
  return Number.isFinite(d) ? Math.round(d) : -1;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Currency units (Scryfall floats) → integer cents, or the null sentinel. */
function toCells(v: number | null): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return NULL_CENTS;
  const cents = Math.round(v * 100);
  return cents >= NULL_CENTS ? NULL_CENTS : cents;
}

function cellsToArray(buf: Uint8Array): (number | null)[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: (number | null)[] = new Array(buf.byteLength >> 2);
  for (let i = 0; i < out.length; i++) {
    const v = view.getUint32(i * 4, true);
    out[i] = v === NULL_CENTS ? null : v;
  }
  return out;
}

/** A buffer of `days` null-sentinel cells with `value` written into the last one. */
function padTo(prev: Buffer, gapDays: number, value: number): Buffer {
  const tail = Buffer.alloc((gapDays + 1) * 4, 0xff);
  tail.writeUInt32LE(value, gapDays * 4);
  return Buffer.concat([prev, tail]);
}

interface PriceRow {
  start_day: string;
  eur: Uint8Array;
  usd: Uint8Array;
}

export class PriceStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'prices.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS price_history (
        scryfall_id TEXT PRIMARY KEY,
        start_day TEXT NOT NULL,
        last_day TEXT NOT NULL,
        eur BLOB NOT NULL,
        usd BLOB NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Last day successfully archived ('' = never). */
  lastDay(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'last_day'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? '';
  }

  /**
   * Append one day of readings for every priced printing. Idempotent per row
   * (a day at or before a row's tip is skipped). Runs in batches with an event
   * -loop yield in between so the nightly ~106k-row append doesn't stall the
   * relay; each batch is its own transaction, safe because re-appends no-op.
   */
  async appendDay(day: string, prices: PriceMap): Promise<{ appended: number }> {
    const ids = Object.keys(prices);
    const get = this.db.prepare(
      'SELECT start_day, eur, usd FROM price_history WHERE scryfall_id = ?',
    );
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO price_history (scryfall_id, start_day, last_day, eur, usd)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let appended = 0;
    const BATCH = 8_000;
    for (let from = 0; from < ids.length; from += BATCH) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of ids.slice(from, from + BATCH)) {
          const [eur, usd] = prices[id]!;
          const eurCell = toCells(eur);
          const usdCell = toCells(usd);
          if (eurCell === NULL_CENTS && usdCell === NULL_CENTS) continue;
          const row = get.get(id) as PriceRow | undefined;
          if (!row) {
            const one = (v: number) => padTo(Buffer.alloc(0), 0, v);
            put.run(id, day, day, one(eurCell), one(usdCell));
            appended++;
            continue;
          }
          const len = row.eur.byteLength >> 2;
          const idx = dayOffset(row.start_day, day);
          if (idx < len) continue; // that day (or a later one) is already recorded
          const gap = idx - len;
          let startDay = row.start_day;
          let eurBuf = padTo(Buffer.from(row.eur), gap, eurCell);
          let usdBuf = padTo(Buffer.from(row.usd), gap, usdCell);
          const days = idx + 1;
          if (days > RETENTION_DAYS) {
            const drop = days - RETENTION_DAYS;
            eurBuf = eurBuf.subarray(drop * 4);
            usdBuf = usdBuf.subarray(drop * 4);
            startDay = addDays(startDay, drop);
          }
          put.run(id, startDay, day, eurBuf, usdBuf);
          appended++;
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      await new Promise((r) => setImmediate(r));
    }

    // Printings that vanished from Scryfall stop extending; drop them once
    // their newest reading has aged out of the retention window anyway.
    this.db
      .prepare('DELETE FROM price_history WHERE last_day < ?')
      .run(addDays(day, -PURGE_AFTER_DAYS));
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_day', ?)`)
      .run(day);
    return { appended };
  }

  getHistory(scryfallId: string): PricesResponse | null {
    const row = this.db
      .prepare('SELECT start_day, eur, usd FROM price_history WHERE scryfall_id = ?')
      .get(scryfallId) as PriceRow | undefined;
    if (!row) return null;
    return {
      scryfallId,
      startDay: row.start_day,
      eur: cellsToArray(row.eur),
      usd: cellsToArray(row.usd),
    };
  }

  /** Row count + archive tip, for the healthz-style log line after each run. */
  stats(): { printings: number; lastDay: string } {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM price_history').get() as { n: number }).n;
    return { printings: n, lastDay: this.lastDay() };
  }

  close(): void {
    this.db.close();
  }
}
