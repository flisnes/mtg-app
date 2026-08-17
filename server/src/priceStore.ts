import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dayOffset, type PriceMap, type PricesResponse } from '@mtg/shared';

// Server price archive (sync plan Phase E): one row per printing holding its
// whole daily price history as two parallel blobs of little-endian Uint32
// cents — index i is the day `start_day + i` (UTC), 0xFFFFFFFF marks a day
// with no reading. ~4 bytes per currency per card-day keeps 3 years of every
// Scryfall printing around 300 MB/yr. Lives in its own SQLite file (prices.db)
// so the far smaller accounts.db stays easy to back up on its own.
//
// Two writers: `appendDay` extends every row forward by a day (the hourly
// archiver), and `spliceHistory` fills days in and around what a row already
// holds, the only path that can move `start_day` earlier (the MTGJSON backfill).

/** No-reading sentinel inside the blobs (a real price of ~€42M is safely absurd). */
const NULL_CENTS = 0xffffffff;

/** Retention: 3 years of days; older leading days are trimmed as rows extend. */
const RETENTION_DAYS = 3 * 366;

/** Rows whose last reading is older than this get purged entirely. */
const PURGE_AFTER_DAYS = RETENTION_DAYS;

const DAY_MS = 86_400_000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
}

const minDay = (a: string, b: string) => (a < b ? a : b);
const maxDay = (a: string, b: string) => (a > b ? a : b);

/**
 * One historical reading for a printing: `[day, eur, usd]` in currency units
 * (Scryfall-style floats), null where that currency had no price that day.
 */
export type HistoricalReading = [day: string, eur: number | null, usd: number | null];

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

/**
 * Copy `src` cells into `dest` starting at cell `at`, dropping whatever falls
 * off either end (a leading `at < 0` means retention trimmed those days away).
 */
function copyClipped(dest: Buffer, src: Uint8Array, at: number): void {
  const skip = at < 0 ? -at : 0;
  const from = skip * 4;
  if (from >= src.byteLength) return;
  const room = dest.byteLength - Math.max(at, 0) * 4;
  const bytes = Math.min(src.byteLength - from, room);
  if (bytes > 0) dest.set(src.subarray(from, from + bytes), Math.max(at, 0) * 4);
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

  /** Read a `meta` row ('' = unset). */
  getMeta(key: string): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? '';
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /** Last day successfully archived ('' = never). */
  lastDay(): string {
    return this.getMeta('last_day');
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

  /**
   * Splice historical readings into one printing's row, growing the day window
   * in *either* direction — the daily appender only ever extends forward, so
   * this is the path a backfill takes to reach days older than `start_day`.
   *
   * Readings never overwrite a day that already holds a value: what the
   * archiver recorded from our own published shard is the authoritative series,
   * and a backfill only fills the holes around it (older days, plus any day the
   * archiver missed). Returns true if the row was written.
   */
  spliceHistory(scryfallId: string, readings: HistoricalReading[]): boolean {
    return this.spliceHistories([[scryfallId, readings]]) > 0;
  }

  /** `spliceHistory` for many printings inside one transaction. Returns rows written. */
  spliceHistories(entries: Iterable<[string, HistoricalReading[]]>): number {
    const get = this.db.prepare(
      'SELECT start_day, eur, usd FROM price_history WHERE scryfall_id = ?',
    );
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO price_history (scryfall_id, start_day, last_day, eur, usd)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [scryfallId, readings] of entries) {
        // Drop readings with nothing to say, so an all-null series can't widen
        // a row's window with empty days.
        const cells = readings
          .map(([day, eur, usd]) => [day, toCells(eur), toCells(usd)] as const)
          .filter(([, eur, usd]) => eur !== NULL_CENTS || usd !== NULL_CENTS)
          .sort(([a], [b]) => (a < b ? -1 : 1));
        if (cells.length === 0) continue;

        const row = get.get(scryfallId) as PriceRow | undefined;
        const haveLen = row ? row.eur.byteLength >> 2 : 0;
        const first = cells[0]![0];
        const newest = cells[cells.length - 1]![0];
        // Trust the blob length over last_day for where the row currently ends;
        // they agree by construction, and the blob is what we're editing.
        let start = row ? minDay(row.start_day, first) : first;
        let last = row ? maxDay(addDays(row.start_day, haveLen - 1), newest) : newest;
        let len = dayOffset(start, last) + 1;
        if (len > RETENTION_DAYS) {
          start = addDays(last, -(RETENTION_DAYS - 1));
          len = RETENTION_DAYS;
        }

        const eurBuf = Buffer.alloc(len * 4, 0xff);
        const usdBuf = Buffer.alloc(len * 4, 0xff);
        if (row) {
          // Where the existing window lands in the new one; negative only if a
          // retention trim cut into its leading days.
          const at = dayOffset(start, row.start_day);
          copyClipped(eurBuf, row.eur, at);
          copyClipped(usdBuf, row.usd, at);
        }
        let filled = 0;
        for (const [day, eur, usd] of cells) {
          const i = dayOffset(start, day);
          if (i < 0 || i >= len) continue; // trimmed out of the window
          if (eur !== NULL_CENTS && eurBuf.readUInt32LE(i * 4) === NULL_CENTS) {
            eurBuf.writeUInt32LE(eur, i * 4);
            filled++;
          }
          if (usd !== NULL_CENTS && usdBuf.readUInt32LE(i * 4) === NULL_CENTS) {
            usdBuf.writeUInt32LE(usd, i * 4);
            filled++;
          }
        }
        if (filled === 0) continue; // every reading was already covered
        put.run(scryfallId, start, last, eurBuf, usdBuf);
        written++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return written;
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
