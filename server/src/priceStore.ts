import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dayOffset, type MonthlyReadings, type PriceMap, type PricesResponse } from '@mtg/shared';
import { dbSizeBytes } from './sqlite.js';

// Server price archive (sync plan Phase E): one row per printing holding its
// whole daily price history as parallel blobs of little-endian Uint32 cents —
// index i is the day `start_day + i` (UTC), 0xFFFFFFFF marks a day with no
// reading. ~4 bytes per lane per card-day keeps 3 years of every Scryfall
// printing around 300 MB/yr for the nonfoil pair. Lives in its own SQLite file
// (prices.db) so the far smaller accounts.db stays easy to back up on its own.
//
// Four lanes: nonfoil EUR/USD (always present) and foil EUR/USD (v0.198.0).
// A foil lane is NULL until the printing gets its first foil reading, and once
// it exists it is kept the same length as the nonfoil ones, so the ~40% of
// printings with no foil cost nothing extra.
//
// Two writers: `appendDay` extends every row forward by a day (the hourly
// archiver), and `spliceHistories` fills days in and around what a row already
// holds, the only path that can move `start_day` earlier (the backfills).
//
// Older history at monthly resolution lives in its own table (`price_monthly`,
// see the bottom of this file): one cell per month, so it can reach back years
// for a fraction of what daily cells would cost.

/** No-reading sentinel inside the blobs (a real price of ~€42M is safely absurd). */
const NULL_CENTS = 0xffffffff;

/** Retention: 3 years of days; older leading days are trimmed as rows extend. */
const RETENTION_DAYS = 3 * 366;

/** Rows whose last reading is older than this get purged entirely. */
const PURGE_AFTER_DAYS = RETENTION_DAYS;

const DAY_MS = 86_400_000;

/** Lane columns, in HistoricalReading / PriceMap tuple order. */
const LANES = ['eur', 'usd', 'eur_foil', 'usd_foil'] as const;
type Lane = (typeof LANES)[number];
/** LANES before this index always exist; the rest are NULL until first used. */
const FOIL_LANES = 2;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
}

const minDay = (a: string, b: string) => (a < b ? a : b);
const maxDay = (a: string, b: string) => (a > b ? a : b);

/**
 * One historical reading for a printing: `[day, eur, usd, eurFoil, usdFoil]`
 * in currency units (Scryfall-style floats), null where that lane had no price
 * that day. The foil slots may be left off.
 */
export type HistoricalReading = [
  day: string,
  eur: number | null,
  usd: number | null,
  eurFoil?: number | null,
  usdFoil?: number | null,
];

/** Currency units (Scryfall floats) → integer cents, or the null sentinel. */
function toCells(v: number | null | undefined): number {
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

/** `prev` followed by `gapDays` null-sentinel cells and then `value`. */
function padTo(prev: Uint8Array, gapDays: number, value: number): Buffer {
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

/** One printing's deep history: id, first month, and cents per month for each of LANES. */
export type MonthlyRow = [scryfallId: string, startMonth: string, lanes: ((number | null)[] | null)[]];

type PriceRow = { start_day: string; eur: Uint8Array; usd: Uint8Array } & Partial<
  Record<Lane, Uint8Array | null>
>;

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
      CREATE TABLE IF NOT EXISTS price_monthly (
        scryfall_id TEXT PRIMARY KEY,
        start_month TEXT NOT NULL,
        eur BLOB,
        usd BLOB,
        eur_foil BLOB,
        usd_foil BLOB
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // v0.198.0: foil lanes. ADD COLUMN is metadata-only in SQLite, so this is
    // instant even on a full archive, and old rows simply read NULL.
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(price_history)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const lane of LANES.slice(FOIL_LANES)) {
      if (!cols.has(lane)) this.db.exec(`ALTER TABLE price_history ADD COLUMN ${lane} BLOB`);
    }
  }

  private selectRow() {
    return this.db.prepare(`SELECT start_day, ${LANES.join(', ')} FROM price_history WHERE scryfall_id = ?`);
  }

  private upsertRow() {
    return this.db.prepare(
      `INSERT OR REPLACE INTO price_history (scryfall_id, start_day, last_day, ${LANES.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
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
    const get = this.selectRow();
    const put = this.upsertRow();
    let appended = 0;
    const BATCH = 8_000;
    for (let from = 0; from < ids.length; from += BATCH) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const id of ids.slice(from, from + BATCH)) {
          // The shard tuple is [eur, usd, eurFoil, usdFoil, usdEtched]; its
          // first four slots line up with LANES. Etched isn't archived.
          const tuple = prices[id]!;
          const cells = LANES.map((_, i) => toCells(tuple[i]));
          if (cells.every((c) => c === NULL_CENTS)) continue;
          const row = get.get(id) as PriceRow | undefined;
          if (!row) {
            const lanes = cells.map((c, i) =>
              i >= FOIL_LANES && c === NULL_CENTS ? null : padTo(Buffer.alloc(0), 0, c),
            );
            put.run(id, day, day, ...lanes);
            appended++;
            continue;
          }
          const len = row.eur.byteLength >> 2;
          const idx = dayOffset(row.start_day, day);
          if (idx < len) continue; // that day (or a later one) is already recorded
          const gap = idx - len;
          let startDay = row.start_day;
          let lanes = LANES.map((lane, i) => {
            const prev = row[lane];
            if (prev) return padTo(prev, gap, cells[i]!);
            // A foil lane is born on its first reading, padded back to the row's start.
            return cells[i] === NULL_CENTS ? null : padTo(Buffer.alloc(len * 4, 0xff), gap, cells[i]!);
          });
          const days = idx + 1;
          if (days > RETENTION_DAYS) {
            const drop = days - RETENTION_DAYS;
            lanes = lanes.map((b) => b && b.subarray(drop * 4));
            startDay = addDays(startDay, drop);
          }
          put.run(id, startDay, day, ...lanes);
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
   * Readings never overwrite a day that already holds a value, lane by lane:
   * what the archiver recorded from our own published shard is the
   * authoritative series, and a backfill only fills the holes around it (older
   * days, plus any day the archiver missed). Returns true if the row was written.
   */
  spliceHistory(scryfallId: string, readings: HistoricalReading[]): boolean {
    return this.spliceHistories([[scryfallId, readings]]) > 0;
  }

  /** `spliceHistory` for many printings inside one transaction. Returns rows written. */
  spliceHistories(entries: Iterable<[string, HistoricalReading[]]>): number {
    const get = this.selectRow();
    const put = this.upsertRow();
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [scryfallId, readings] of entries) {
        // Drop readings with nothing to say, so an all-null series can't widen
        // a row's window with empty days.
        const cells = readings
          .map(([day, ...v]) => [day, LANES.map((_, i) => toCells(v[i]))] as const)
          .filter(([, c]) => c.some((x) => x !== NULL_CENTS))
          .sort(([a], [b]) => (a < b ? -1 : 1));
        if (cells.length === 0) continue;

        const row = get.get(scryfallId) as PriceRow | undefined;
        const haveLen = row ? row.eur.byteLength >> 2 : 0;
        const first = cells[0]![0];
        const newest = cells[cells.length - 1]![0];
        // Trust the blob length over last_day for where the row currently ends;
        // they agree by construction, and the blob is what we're editing.
        let start = row ? minDay(row.start_day, first) : first;
        const last = row ? maxDay(addDays(row.start_day, haveLen - 1), newest) : newest;
        let len = dayOffset(start, last) + 1;
        if (len > RETENTION_DAYS) {
          start = addDays(last, -(RETENTION_DAYS - 1));
          len = RETENTION_DAYS;
        }

        // A foil lane gets a buffer if the row already has one or a reading
        // brings one; otherwise it stays NULL.
        const bufs = LANES.map((lane, i) =>
          i < FOIL_LANES || row?.[lane] || cells.some(([, c]) => c[i] !== NULL_CENTS)
            ? Buffer.alloc(len * 4, 0xff)
            : null,
        );
        if (row) {
          // Where the existing window lands in the new one; negative only if a
          // retention trim cut into its leading days.
          const at = dayOffset(start, row.start_day);
          LANES.forEach((lane, i) => {
            const src = row[lane];
            if (src && bufs[i]) copyClipped(bufs[i]!, src, at);
          });
        }
        let filled = 0;
        for (const [day, c] of cells) {
          const at = dayOffset(start, day);
          if (at < 0 || at >= len) continue; // trimmed out of the window
          c.forEach((v, i) => {
            const buf = bufs[i];
            if (v === NULL_CENTS || !buf || buf.readUInt32LE(at * 4) !== NULL_CENTS) return;
            buf.writeUInt32LE(v, at * 4);
            filled++;
          });
        }
        if (filled === 0) continue; // every reading was already covered
        put.run(scryfallId, start, last, ...bufs);
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
    const row = this.selectRow().get(scryfallId) as PriceRow | undefined;
    const monthly = this.getMonthly(scryfallId);
    if (!row && !monthly) return null;
    // A printing with only deep history still answers, with an empty daily window.
    const out: PricesResponse = row
      ? { scryfallId, startDay: row.start_day, eur: cellsToArray(row.eur), usd: cellsToArray(row.usd) }
      : { scryfallId, startDay: `${monthly!.startMonth}-01`, eur: [], usd: [] };
    if (row?.eur_foil) out.eurFoil = cellsToArray(row.eur_foil);
    if (row?.usd_foil) out.usdFoil = cellsToArray(row.usd_foil);
    if (monthly) out.monthly = monthly;
    return out;
  }

  // -------------------------------------------------------------------------
  // Monthly deep history. One cell per calendar month (index i = start_month
  // + i months), same cents/sentinel encoding and the same four lanes as the
  // daily blobs, each NULL when it has no reading at all.
  // -------------------------------------------------------------------------

  /**
   * Store monthly rows for many printings in one transaction, replacing what
   * each had: the deep history arrives as one prebuilt file covering every
   * month (see priceMonthly.ts), so the newest file is the whole truth.
   * Cents in, null = no reading. Returns rows written.
   */
  putMonthly(rows: Iterable<MonthlyRow>): number {
    const put = this.db.prepare(
      `INSERT OR REPLACE INTO price_monthly (scryfall_id, start_month, ${LANES.join(', ')}) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const pack = (cells: (number | null)[] | null | undefined) => {
      if (!cells || !cells.some((c) => c != null)) return null;
      const buf = Buffer.alloc(cells.length * 4, 0xff);
      cells.forEach((c, i) => {
        if (c != null && Number.isInteger(c) && c >= 0 && c < NULL_CENTS) buf.writeUInt32LE(c, i * 4);
      });
      return buf;
    };
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [id, startMonth, lanes] of rows) {
        const bufs = LANES.map((_, i) => pack(lanes[i]));
        if (bufs.every((b) => !b)) continue;
        put.run(id, startMonth, ...bufs);
        written++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return written;
  }

  getMonthly(scryfallId: string): MonthlyReadings | null {
    const row = this.db
      .prepare(`SELECT start_month, ${LANES.join(', ')} FROM price_monthly WHERE scryfall_id = ?`)
      .get(scryfallId) as ({ start_month: string } & Record<Lane, Uint8Array | null>) | undefined;
    if (!row) return null;
    const out: MonthlyReadings = { startMonth: row.start_month };
    const keys = { eur: 'eur', usd: 'usd', eur_foil: 'eurFoil', usd_foil: 'usdFoil' } as const;
    for (const lane of LANES) {
      const buf = row[lane];
      if (buf) out[keys[lane]] = cellsToArray(buf);
    }
    return out;
  }

  /** Row count + archive tip, for the healthz-style log line after each run. */
  stats(): { printings: number; lastDay: string } {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM price_history').get() as { n: number }).n;
    return { printings: n, lastDay: this.lastDay() };
  }

  /** Printings with deep monthly history (the admin panel). */
  monthlyCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM price_monthly').get() as { n: number }).n;
  }

  /** Size of the database file proper (WAL not included). */
  dbSizeBytes(): number {
    return dbSizeBytes(this.db);
  }

  close(): void {
    this.db.close();
  }
}

