import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PublicUser, SnapshotCounts, SnapshotMeta } from '@mtg/shared';

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

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AccountStore {
  private db: DatabaseSync;

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
      CREATE TABLE IF NOT EXISTS snapshots (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        counts TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS public_lists (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        tradelist TEXT NOT NULL,
        wishlist TEXT NOT NULL,
        tradelist_count INTEGER NOT NULL,
        wishlist_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** Returns the new user, or null if the username is taken. */
  createUser(username: string, password: string): AccountUser | null {
    try {
      const res = this.db
        .prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
        .run(username, hashPassword(password), Date.now());
      return { id: Number(res.lastInsertRowid), username };
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) return null;
      throw err;
    }
  }

  authenticate(username: string, password: string): AccountUser | null {
    const row = this.db
      .prepare('SELECT id, username, pass_hash FROM users WHERE username = ?')
      .get(username) as { id: number; username: string; pass_hash: string } | undefined;
    if (!row || !verifyPassword(password, row.pass_hash)) return null;
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
        'SELECT u.id, u.username FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?',
      )
      .get(hash) as { id: number; username: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE token_hash = ?').run(Date.now(), hash);
    return { id: row.id, username: row.username };
  }

  revokeToken(token: string): void {
    this.db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(tokenHash(token));
  }

  deleteUser(userId: number): void {
    // Child rows cascade (tokens, snapshots, public_lists).
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  snapshotMeta(userId: number): SnapshotMeta | null {
    const row = this.db
      .prepare('SELECT version, counts, updated_at FROM snapshots WHERE user_id = ?')
      .get(userId) as { version: number; counts: string | null; updated_at: number } | undefined;
    if (!row) return null;
    return { version: row.version, updatedAt: row.updated_at, counts: parseCounts(row.counts) };
  }

  getSnapshot(userId: number): { version: number; updatedAt: number; counts: SnapshotCounts | null; payload: string } | null {
    const row = this.db
      .prepare('SELECT version, counts, updated_at, payload FROM snapshots WHERE user_id = ?')
      .get(userId) as
      | { version: number; counts: string | null; updated_at: number; payload: string }
      | undefined;
    if (!row) return null;
    return { version: row.version, updatedAt: row.updated_at, counts: parseCounts(row.counts), payload: row.payload };
  }

  /**
   * Store a snapshot + published lists atomically. Returns the new meta, or
   * the current one with `conflict: true` when baseVersion doesn't match the
   * stored version (another device pushed in between).
   */
  putSnapshot(
    userId: number,
    baseVersion: number | null,
    payload: string,
    counts: SnapshotCounts,
    tradelistJson: string,
    tradelistCount: number,
    wishlistJson: string,
    wishlistCount: number,
  ): { version: number; updatedAt: number; conflict: boolean } {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT version, updated_at FROM snapshots WHERE user_id = ?')
        .get(userId) as { version: number; updated_at: number } | undefined;
      if (existing && existing.version !== baseVersion) {
        this.db.exec('ROLLBACK');
        return { version: existing.version, updatedAt: existing.updated_at, conflict: true };
      }
      const version = (existing?.version ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO snapshots (user_id, version, payload, counts, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             version = excluded.version, payload = excluded.payload,
             counts = excluded.counts, updated_at = excluded.updated_at`,
        )
        .run(userId, version, payload, JSON.stringify(counts), now);
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
      this.db.exec('COMMIT');
      return { version, updatedAt: now, conflict: false };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listUsers(): PublicUser[] {
    const rows = this.db
      .prepare(
        `SELECT u.username, p.updated_at, p.tradelist_count, p.wishlist_count
         FROM public_lists p JOIN users u ON u.id = p.user_id
         ORDER BY p.updated_at DESC`,
      )
      .all() as { username: string; updated_at: number; tradelist_count: number; wishlist_count: number }[];
    return rows.map((r) => ({
      username: r.username,
      updatedAt: r.updated_at,
      tradelistCount: r.tradelist_count,
      wishlistCount: r.wishlist_count,
    }));
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

  close(): void {
    this.db.close();
  }
}

function parseCounts(raw: string | null): SnapshotCounts | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SnapshotCounts;
  } catch {
    return null;
  }
}
