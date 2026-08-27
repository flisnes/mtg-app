import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  CONDITIONS,
  FINISHES,
  SYNC_MAX_BYTES_PER_USER,
  SYNC_MAX_PULL,
  SYNC_MAX_ROWS_PER_USER,
  sanitizeAvatar,
  type Condition,
  type Finish,
  type ProfileAvatar,
  type PublicUser,
  type SyncChange,
  type SyncTable,
} from '@mtg/shared';
import { config } from './config.js';

// Account persistence: one SQLite file (node:sqlite, no native deps) holding
// users, bearer tokens, opaque snapshot blobs, and the published trade/wish
// lists. Everything else on this server stays in-memory; only the opt-in
// account feature touches disk.
//
// Passwords are scrypt-hashed (salt:hash hex). Tokens are 32 random bytes,
// handed to the client as hex and stored only as a SHA-256 hash, so a leaked
// database file doesn't yield usable sessions.

export interface AccountUser {
  id: number;
  username: string;
}

const SCRYPT_KEYLEN = 64;

// Async scrypt so a burst of logins/registrations can't pin the single-threaded
// event loop (each hash is ~50–100 ms of CPU) and stall every open websocket.
const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AccountStore {
  private db: DatabaseSync;
  /** Bumped on every public-list write; the parsed-lists cache keys off it. */
  private publicListsVersion = 0;
  private parsedCache: { version: number; lists: ParsedPublicList[] } | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'accounts.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS public_lists (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        tradelist TEXT NOT NULL,
        wishlist TEXT NOT NULL,
        tradelist_count INTEGER NOT NULL,
        wishlist_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_rows (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tbl TEXT NOT NULL,
        row_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        row TEXT,
        seq INTEGER NOT NULL,
        PRIMARY KEY (user_id, tbl, row_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_rows_seq ON sync_rows(user_id, seq);
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
      CREATE TABLE IF NOT EXISTS sync_seq (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        max_seq INTEGER NOT NULL
      );
      -- Running row/byte totals per user, so the storage caps cost one indexed
      -- lookup per push instead of a COUNT(*) over the user's rows. Maintained
      -- by delta in syncApply; backfilled lazily on first use (see usage()).
      CREATE TABLE IF NOT EXISTS sync_usage (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        rows INTEGER NOT NULL,
        bytes INTEGER NOT NULL
      );
      -- One row per device that has ever synced, with the cursor it last
      -- reached. Tombstone pruning needs to know the oldest cursor still in
      -- play; sync_prune records how far we pruned, so a device that fell
      -- behind that point can be told to reseed instead of silently keeping
      -- rows everyone else deleted.
      CREATE TABLE IF NOT EXISTS sync_devices (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (user_id, client_id)
      );
      -- pruned_below: tombstones up to and including this seq are gone, so a
      -- device must be at or past it to still have a complete picture.
      CREATE TABLE IF NOT EXISTS sync_prune (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        pruned_below INTEGER NOT NULL
      );
    `);
    this.dropLegacySnapshots();
    // Housekeeping at boot, then hourly: idle tokens (the table is otherwise
    // append-only apart from logout) and tombstones every device has seen.
    this.runMaintenance();
    this.pruneTimer = setInterval(() => this.runMaintenance(), 60 * 60 * 1000);
    this.pruneTimer.unref?.();
  }

  private pruneTimer: ReturnType<typeof setInterval>;

  private runMaintenance(): void {
    this.pruneStaleTokens();
    this.pruneTombstones();
  }

  private pruneStaleTokens(): void {
    this.db.prepare('DELETE FROM tokens WHERE last_used_at < ?').run(Date.now() - config.tokenTtlMs);
  }

  /**
   * Drop tombstones that every live device has already applied.
   *
   * A delete is stored as a row with `row = NULL` and kept forever, so a device
   * that syncs late still learns the row is gone. Once every device that has
   * synced recently sits at a cursor past a tombstone, nobody needs it again.
   *
   * The floor is the LOWEST cursor among devices seen within
   * `syncDeviceActiveMs`; a device idle longer than that stops holding the
   * account back and gets a reseed when it does return (see syncApply). Users
   * with no recorded device are skipped entirely rather than pruned to the
   * top — a single-device user on holiday must never come back to a reseed.
   * `syncTombstoneMinAgeMs` then keeps recent deletes regardless of cursors, so
   * an ordinary few-weeks-stale device is safe even if device tracking is wrong.
   */
  private pruneTombstones(): void {
    const now = Date.now();
    const activeSince = now - config.syncDeviceActiveMs;
    const floors = this.db
      .prepare(
        `SELECT user_id, MIN(cursor) AS floor FROM sync_devices
         WHERE last_seen >= ? GROUP BY user_id`,
      )
      .all(activeSince) as unknown as { user_id: number; floor: number }[];
    if (floors.length === 0) return;

    const del = this.db.prepare(
      // seq <= floor: a device reporting cursor C has applied everything through
      // seq C, so C's own tombstone is spent too.
      'DELETE FROM sync_rows WHERE user_id = ? AND deleted = 1 AND seq <= ? AND updated_at < ?',
    );
    const bump = this.db.prepare(
      `INSERT INTO sync_prune (user_id, pruned_below) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET pruned_below = MAX(pruned_below, excluded.pruned_below)`,
    );
    let removed = 0;
    for (const { user_id: userId, floor } of floors) {
      if (floor <= 0) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const res = del.run(userId, floor, now - config.syncTombstoneMinAgeMs);
        const n = Number(res.changes);
        if (n > 0) {
          // Tombstones carry no row bytes, so only the row count moves.
          this.db.prepare('UPDATE sync_usage SET rows = MAX(0, rows - ?) WHERE user_id = ?').run(n, userId);
          removed += n;
        }
        // Record the floor even when nothing was deleted: it is the point below
        // which a returning device can no longer be trusted to be complete.
        bump.run(userId, floor);
        this.db.exec('COMMIT');
      } catch {
        this.db.exec('ROLLBACK');
      }
    }
    if (removed > 0) this.prunedTombstones += removed;
  }

  /** Total tombstones this process has pruned (for logging/diagnostics). */
  prunedTombstones = 0;

  /** How far tombstones have been pruned for this user (0 = never pruned). */
  private prunedBelow(userId: number): number {
    const row = this.db.prepare('SELECT pruned_below FROM sync_prune WHERE user_id = ?').get(userId) as
      | { pruned_below: number }
      | undefined;
    return row?.pruned_below ?? 0;
  }

  /** Record where a device got to, so tombstone pruning knows the safe floor. */
  private touchDevice(userId: number, clientId: string, cursor: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO sync_devices (user_id, client_id, cursor, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, client_id) DO UPDATE SET
           cursor = MAX(cursor, excluded.cursor), last_seen = excluded.last_seen`,
      )
      .run(userId, clientId, cursor, now);
  }

  /**
   * The user's running row/byte totals, computed once and maintained by delta
   * thereafter. The old row cap ran a COUNT(*) over the user's rows on every
   * push that inserted anything; this is a single primary-key lookup.
   */
  private usage(userId: number): { rows: number; bytes: number } {
    const row = this.db.prepare('SELECT rows, bytes FROM sync_usage WHERE user_id = ?').get(userId) as
      | { rows: number; bytes: number }
      | undefined;
    if (row) return { rows: row.rows, bytes: row.bytes };
    // First push since this table existed: one scan, then never again. LENGTH of
    // a BLOB cast is UTF-8 bytes, matching Buffer.byteLength on the write side.
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(CAST(row AS BLOB))), 0) AS bytes
         FROM sync_rows WHERE user_id = ?`,
      )
      .get(userId) as { rows: number; bytes: number };
    this.db.prepare('INSERT INTO sync_usage (user_id, rows, bytes) VALUES (?, ?, ?)').run(userId, agg.rows, agg.bytes);
    return { rows: agg.rows, bytes: agg.bytes };
  }

  /** Current storage use for one user (the account screen / diagnostics). */
  syncUsage(userId: number): { rows: number; bytes: number } {
    return this.usage(userId);
  }

  /** Returns the new user, or null if the username is taken. */
  async createUser(username: string, password: string): Promise<AccountUser | null> {
    const passHash = await hashPassword(password);
    try {
      const res = this.db
        .prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
        .run(username, passHash, Date.now());
      return { id: Number(res.lastInsertRowid), username };
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) return null;
      throw err;
    }
  }

  async authenticate(username: string, password: string): Promise<AccountUser | null> {
    const row = this.db
      .prepare('SELECT id, username, pass_hash FROM users WHERE username = ?')
      .get(username) as { id: number; username: string; pass_hash: string } | undefined;
    if (!row || !(await verifyPassword(password, row.pass_hash))) return null;
    return { id: row.id, username: row.username };
  }

  /** Mint a bearer token for the user; the raw token is returned once. */
  issueToken(userId: number): string {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.db
      .prepare('INSERT INTO tokens (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash(token), userId, now, now);
    return token;
  }

  userForToken(token: string): AccountUser | null {
    const hash = tokenHash(token);
    const row = this.db
      .prepare(
        'SELECT u.id, u.username, t.last_used_at FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?',
      )
      .get(hash) as { id: number; username: string; last_used_at: number } | undefined;
    if (!row) return null;
    const now = Date.now();
    // Reject (and drop) a token idle past the TTL, in case the hourly prune
    // hasn't run yet — a stale token must never authenticate.
    if (row.last_used_at < now - config.tokenTtlMs) {
      this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(hash);
      return null;
    }
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?').run(now, hash);
    return { id: row.id, username: row.username };
  }

  revokeToken(token: string): void {
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(tokenHash(token));
  }

  deleteUser(userId: number): void {
    // Child rows cascade (tokens, snapshots, public_lists).
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  private upsertPublicLists(
    userId: number,
    tradelistJson: string,
    tradelistCount: number,
    wishlistJson: string,
    wishlistCount: number,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO public_lists (user_id, tradelist, wishlist, tradelist_count, wishlist_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           tradelist = excluded.tradelist, wishlist = excluded.wishlist,
           tradelist_count = excluded.tradelist_count, wishlist_count = excluded.wishlist_count,
           updated_at = excluded.updated_at`,
      )
      .run(userId, tradelistJson, wishlistJson, tradelistCount, wishlistCount, now);
    // Invalidate the parsed-lists cache used by /api/matches.
    this.publicListsVersion += 1;
  }

  /** Store the published lists on their own (the sync path — no snapshot involved). */
  putPublicLists(
    userId: number,
    tradelistJson: string,
    tradelistCount: number,
    wishlistJson: string,
    wishlistCount: number,
  ): void {
    this.upsertPublicLists(userId, tradelistJson, tradelistCount, wishlistJson, wishlistCount, Date.now());
  }

  // --- Row-level sync (sync plan, 2026-07-16) --------------------------------

  /** Current top of the user's change feed (0 = nothing synced yet). */
  syncSeq(userId: number): number {
    const row = this.db.prepare('SELECT max_seq FROM sync_seq WHERE user_id = ?').get(userId) as
      | { max_seq: number }
      | undefined;
    return row?.max_seq ?? 0;
  }

  /**
   * One atomic pull+push. Reads everything past `cursor` first (so accepted
   * pushes are never echoed), then applies the incoming changes last-write-wins
   * — a pushed change that loses to a stored row gets that winner appended to
   * the response instead. When the pull is capped (`hasMore`) the push is NOT
   * applied; the client catches up first and re-sends.
   */
  syncApply(
    userId: number,
    clientId: string,
    cursor: number,
    changes: SyncChange[],
    now: number,
    reseeding = false,
  ): { cursor: number; changes: SyncChange[]; hasMore: boolean; applied: number; resync: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let maxSeq = this.syncSeq(userId);
      // A cursor below the pruned floor means this device may have missed a
      // tombstone, so its copy can still hold rows deleted elsewhere. Apply its
      // push (nothing local is lost) but hand back no changes and ask it to
      // reseed. Cursor 0 is exempt: that IS a reseed, and answering it with
      // another reseed would loop forever. So is a device that says it is
      // already reseeding — every pass after the first of a capped reseed asks
      // from a cursor below the floor, and ordering a fresh wipe each time is
      // how a large account gets stuck wiping and refilling forever.
      const resync = !reseeding && cursor > 0 && cursor < this.prunedBelow(userId);

      const pulled = resync
        ? []
        : (this.db
            .prepare(
              `SELECT tbl, row_id, updated_at, deleted, row, seq FROM sync_rows
               WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
            )
            .all(userId, cursor, SYNC_MAX_PULL + 1) as unknown as SyncRowRecord[]);
      const hasMore = pulled.length > SYNC_MAX_PULL;
      const window = hasMore ? pulled.slice(0, SYNC_MAX_PULL) : pulled;
      const out = window.map(recordToChange);

      let applied = 0;
      let newCursor = hasMore ? window[window.length - 1]!.seq : maxSeq;

      if (!hasMore) {
        // A device clock far in the future would win LWW forever; clamp.
        const maxTs = now + 5 * 60 * 1000;
        const getStmt = this.db.prepare(
          'SELECT tbl, row_id, updated_at, deleted, row, seq FROM sync_rows WHERE user_id = ? AND tbl = ? AND row_id = ?',
        );
        const putStmt = this.db.prepare(
          `INSERT OR REPLACE INTO sync_rows (user_id, tbl, row_id, updated_at, deleted, row, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        // Running totals, read once per push and written back at the end. The
        // LWW lookup below already hands us the stored row, so the byte delta
        // is free — no scan needed to enforce either cap.
        const use = this.usage(userId);
        let { rows: totalRows, bytes: totalBytes } = use;

        for (const c of changes) {
          const existing = getStmt.get(userId, c.tbl, c.rowId) as SyncRowRecord | undefined;
          const incomingTs = Math.min(c.updatedAt, maxTs);
          if (existing && existing.updated_at >= incomingTs) {
            // The push lost (or is a replay of what's stored): hand back the winner.
            out.push(recordToChange(existing));
            continue;
          }
          const json = c.deleted ? null : JSON.stringify(c.row ?? null);
          const newBytes = json === null ? 0 : Buffer.byteLength(json);
          const oldBytes = existing && existing.row !== null ? Buffer.byteLength(existing.row) : 0;
          if (!existing && totalRows + 1 > SYNC_MAX_ROWS_PER_USER) throw new SyncCapError('rows');
          // Deletes and shrinking edits are always allowed through: a user at
          // the ceiling must still be able to clean up.
          if (newBytes > oldBytes && totalBytes - oldBytes + newBytes > SYNC_MAX_BYTES_PER_USER) {
            throw new SyncCapError('bytes');
          }
          if (!existing) totalRows += 1;
          totalBytes += newBytes - oldBytes;
          maxSeq += 1;
          putStmt.run(userId, c.tbl, c.rowId, incomingTs, c.deleted ? 1 : 0, json, maxSeq);
          applied += 1;
        }
        if (applied > 0) {
          this.db
            .prepare(
              `INSERT INTO sync_seq (user_id, max_seq) VALUES (?, ?)
               ON CONFLICT(user_id) DO UPDATE SET max_seq = excluded.max_seq`,
            )
            .run(userId, maxSeq);
          this.db
            .prepare('UPDATE sync_usage SET rows = ?, bytes = ? WHERE user_id = ?')
            .run(totalRows, Math.max(0, totalBytes), userId);
        }
        newCursor = maxSeq;
      }

      // The device's cursor after this call, for the tombstone-prune floor. On a
      // resync it is about to restart from 0, so record that instead of the top.
      this.touchDevice(userId, clientId, resync ? 0 : newCursor, now);
      this.db.exec('COMMIT');
      return { cursor: resync ? 0 : newCursor, changes: out, hasMore, applied, resync };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * One live synced row, parsed. Sync-row content is normally opaque to the
   * server; browsable favorite decks are the one deliberate exception (see
   * shared/profile.ts) — parsed rows are still untrusted client JSON.
   */
  getSyncRow(userId: number, tbl: SyncTable, rowId: string): { updatedAt: number; row: unknown } | null {
    const rec = this.db
      .prepare('SELECT updated_at, deleted, row FROM sync_rows WHERE user_id = ? AND tbl = ? AND row_id = ?')
      .get(userId, tbl, rowId) as { updated_at: number; deleted: number; row: string | null } | undefined;
    if (!rec || rec.deleted || rec.row === null) return null;
    try {
      return { updatedAt: rec.updated_at, row: JSON.parse(rec.row) };
    } catch {
      return null;
    }
  }

  /** All live synced rows of one table, parsed (same exception as getSyncRow). */
  listSyncRows(userId: number, tbl: SyncTable): unknown[] {
    const recs = this.db
      .prepare('SELECT row FROM sync_rows WHERE user_id = ? AND tbl = ? AND deleted = 0')
      .all(userId, tbl) as { row: string | null }[];
    const out: unknown[] = [];
    for (const rec of recs) {
      if (rec.row === null) continue;
      try {
        out.push(JSON.parse(rec.row));
      } catch {
        // skip unparseable rows (unreachable for rows this server wrote)
      }
    }
    return out;
  }

  listUsers(): PublicUser[] {
    const rows = this.db
      .prepare(
        `SELECT u.username, p.updated_at, p.tradelist_count, p.wishlist_count, pr.data AS profile
         FROM public_lists p JOIN users u ON u.id = p.user_id
         LEFT JOIN profiles pr ON pr.user_id = p.user_id
         ORDER BY p.updated_at DESC`,
      )
      .all() as {
      username: string;
      updated_at: number;
      tradelist_count: number;
      wishlist_count: number;
      profile: string | null;
    }[];
    return rows.map((r) => ({
      username: r.username,
      updatedAt: r.updated_at,
      tradelistCount: r.tradelist_count,
      wishlistCount: r.wishlist_count,
      avatar: avatarFromProfileJson(r.profile),
    }));
  }

  // --- Public profiles (favorites + profile picture) --------------------------

  /** Store the user's profile (pre-sanitized JSON); returns the write time. */
  putProfile(userId: number, dataJson: string): number {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(userId, dataJson, now);
    return now;
  }

  /** Canonical username lookup (usernames are case-insensitively unique). */
  getUserByUsername(username: string): AccountUser | null {
    const row = this.db.prepare('SELECT id, username FROM users WHERE username = ?').get(username) as
      | { id: number; username: string }
      | undefined;
    return row ?? null;
  }

  /** Raw profile JSON for one user; null = never saved one. */
  getProfile(userId: number): { data: string; updatedAt: number } | null {
    const row = this.db.prepare('SELECT data, updated_at FROM profiles WHERE user_id = ?').get(userId) as
      | { data: string; updated_at: number }
      | undefined;
    if (!row) return null;
    return { data: row.data, updatedAt: row.updated_at };
  }

  /** Raw published lists for every user, for on-demand match computation. */
  allPublicLists(): { userId: number; username: string; updatedAt: number; tradelist: string; wishlist: string }[] {
    const rows = this.db
      .prepare(
        `SELECT p.user_id, u.username, p.updated_at, p.tradelist, p.wishlist
         FROM public_lists p JOIN users u ON u.id = p.user_id`,
      )
      .all() as { user_id: number; username: string; updated_at: number; tradelist: string; wishlist: string }[];
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      updatedAt: r.updated_at,
      tradelist: r.tradelist,
      wishlist: r.wishlist,
    }));
  }

  /**
   * Parsed published lists for match computation, cached until the next publish.
   * Without this, /api/matches re-parsed every user's (up to 2 MB) lists on
   * every poll — O(N) JSON work per request; now it's O(N) only per change.
   */
  parsedPublicLists(): ParsedPublicList[] {
    if (this.parsedCache && this.parsedCache.version === this.publicListsVersion) {
      return this.parsedCache.lists;
    }
    const lists = this.allPublicLists().map((r) => ({
      userId: r.userId,
      username: r.username,
      updatedAt: r.updatedAt,
      haves: parseHaveLines(r.tradelist),
      wants: parseWantLines(r.wishlist),
    }));
    this.parsedCache = { version: this.publicListsVersion, lists };
    return lists;
  }

  /** Raw published-list JSON for one user (relayed verbatim to the browser). */
  getUserLists(username: string): { username: string; updatedAt: number; tradelist: string; wishlist: string } | null {
    const row = this.db
      .prepare(
        `SELECT u.username, p.tradelist, p.wishlist, p.updated_at
         FROM public_lists p JOIN users u ON u.id = p.user_id
         WHERE u.username = ?`,
      )
      .get(username) as
      | { username: string; tradelist: string; wishlist: string; updated_at: number }
      | undefined;
    if (!row) return null;
    return { username: row.username, updatedAt: row.updated_at, tradelist: row.tradelist, wishlist: row.wishlist };
  }

  /**
   * Drop the pre-sync `snapshots` table. Whole-account snapshot upload was
   * replaced by row-level sync in client 0.17.0 and no client has written one
   * since, but the rows sat there holding up to 30 MB of dead JSON each. VACUUM
   * is what actually returns the pages to the filesystem, so it runs once and
   * `user_version` records that it has.
   */
  private dropLegacySnapshots(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    if ((row?.user_version ?? 0) >= 1) return;
    this.db.exec('DROP TABLE IF EXISTS snapshots');
    this.db.exec('PRAGMA user_version = 1');
    this.db.exec('VACUUM');
    // In WAL mode VACUUM writes the rebuilt database to the log; without a
    // truncating checkpoint the main file keeps its old size and nothing is
    // actually handed back to the filesystem.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    clearInterval(this.pruneTimer);
    this.db.close();
  }
}

/** A concrete tradelist card, for matching against wishlist preferences. */
export interface HaveLine {
  oracleId: string;
  scryfallId: string | null;
  name: string;
  condition: Condition;
  finish: Finish;
  lang: string;
}

/** A wishlist card with its printing pin and (optional) finish/condition/language preferences. */
export interface WantLine {
  oracleId: string;
  /** null = any printing of the card. */
  scryfallId: string | null;
  condition?: Condition;
  finish?: Finish;
  lang?: string;
}

export interface ParsedPublicList {
  userId: number;
  username: string;
  updatedAt: number;
  /** Tradelist lines (concrete condition/finish/lang), for pref-aware matching. */
  haves: HaveLine[];
  /** Wishlist lines with their preferences. */
  wants: WantLine[];
}

const COND_SET = new Set<string>(CONDITIONS);
const FIN_SET = new Set<string>(FINISHES);

function parseLines(json: string): Record<string, unknown>[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function parseHaveLines(json: string): HaveLine[] {
  const out: HaveLine[] = [];
  for (const l of parseLines(json)) {
    if (typeof l.oracleId !== 'string') continue;
    out.push({
      oracleId: l.oracleId,
      scryfallId: typeof l.scryfallId === 'string' ? l.scryfallId : null,
      name: typeof l.name === 'string' ? l.name : '(unknown card)',
      // Stored lines are already sanitized concrete TradeLines; fall back defensively.
      condition: COND_SET.has(l.condition as string) ? (l.condition as Condition) : 'NM',
      finish: FIN_SET.has(l.finish as string) ? (l.finish as Finish) : 'nonfoil',
      lang: typeof l.lang === 'string' && l.lang ? l.lang : 'en',
    });
  }
  return out;
}

function parseWantLines(json: string): WantLine[] {
  const out: WantLine[] = [];
  for (const l of parseLines(json)) {
    if (typeof l.oracleId !== 'string') continue;
    out.push({
      oracleId: l.oracleId,
      scryfallId: typeof l.scryfallId === 'string' ? l.scryfallId : null,
      ...(COND_SET.has(l.condition as string) ? { condition: l.condition as Condition } : {}),
      ...(FIN_SET.has(l.finish as string) ? { finish: l.finish as Finish } : {}),
      ...(typeof l.lang === 'string' && l.lang ? { lang: l.lang } : {}),
    });
  }
  return out;
}

/** Pull just the avatar out of a stored profile blob (for the community list). */
function avatarFromProfileJson(raw: string | null): ProfileAvatar | null {
  if (!raw) return null;
  try {
    return sanitizeAvatar((JSON.parse(raw) as { avatar?: unknown }).avatar);
  } catch {
    return null;
  }
}

/** Thrown when a user hits a storage cap; the route maps it to 413. */
export class SyncCapError extends Error {
  constructor(readonly kind: 'rows' | 'bytes') {
    super(`sync ${kind} cap reached`);
  }
}

interface SyncRowRecord {
  tbl: string;
  row_id: string;
  updated_at: number;
  deleted: number;
  row: string | null;
  seq: number;
}

function recordToChange(r: SyncRowRecord): SyncChange {
  // `seq` rides along so a client can refuse to advance its cursor past a
  // change it doesn't understand (see SyncChange.seq).
  if (r.deleted) {
    return { tbl: r.tbl as SyncTable, rowId: r.row_id, updatedAt: r.updated_at, deleted: true, seq: r.seq };
  }
  let row: unknown = null;
  try {
    row = r.row === null ? null : JSON.parse(r.row);
  } catch {
    // unreachable for rows this server wrote; a null row is dropped client-side
  }
  return { tbl: r.tbl as SyncTable, rowId: r.row_id, updatedAt: r.updated_at, row, seq: r.seq };
}
