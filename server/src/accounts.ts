import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  EMPTY_PROFILE,
  MAX_PASSWORD_CHARS,
  MAX_PROFILE_JSON_CHARS,
  MAX_PUBLIC_LINES,
  MAX_SNAPSHOT_CHARS,
  MIN_PASSWORD_CHARS,
  SYNC_MAX_PUSH,
  SYNC_MAX_ROW_CHARS,
  SYNC_TABLES,
  USERNAME_RE,
  sanitizeDeckLines,
  sanitizeProfile,
  type ApiErrorBody,
  type AuthResponse,
  type MatchCard,
  type MatchEntry,
  type MatchesResponse,
  type MeResponse,
  type ProfilePutResponse,
  type ProfileResponse,
  type SnapshotCounts,
  type SnapshotGetResponse,
  type SnapshotPutResponse,
  type SyncChange,
  type SyncResponse,
  type SyncTable,
  type TradeLine,
  type UserDeckResponse,
  type UserListsResponse,
  type UserProfile,
  type UsersResponse,
  type WishLine,
} from '@mtg/shared';
import { config } from './config.js';
import { SyncCapError, type AccountStore, type AccountUser } from './accountStore.js';
import type { SyncHub } from './syncHub.js';

// Opt-in accounts (HTTP /api/*, alongside the WS relay). The server stores the
// user's snapshot as an opaque blob plus their published trade/wishlists;
// browsing endpoints require a signed-in user, so lists are only visible to
// other account holders — which is exactly what the signup disclaimer says.

/** Serialized-JSON cap per published list (~2 MB keeps rows renderable). */
const MAX_LIST_JSON_CHARS = 2_000_000;
/** Request-body cap for snapshot uploads: payload cap + lists + slack. */
const SNAPSHOT_BODY_LIMIT = 36 * 1024 * 1024;

const CONDS = new Set(['NM', 'LP', 'MP', 'HP', 'DMG']);
const FINS = new Set(['nonfoil', 'foil', 'etched']);

export function fail(reply: FastifyReply, status: number, body: ApiErrorBody): void {
  void reply.status(status).send(body);
}

/** Resolve the request's bearer token to a user, or 401 (shared by /api routes). */
export function authUser(store: AccountStore, req: FastifyRequest, reply: FastifyReply): AccountUser | null {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  const user = token ? store.userForToken(token) : null;
  if (!user) {
    fail(reply, 401, { error: 'unauthorized', message: 'Sign in first.' });
    return null;
  }
  return user;
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

function posInt(v: unknown, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
}

/** Light server-side normalization of published lines (clients re-sanitize on display). */
function normalizeTradeLines(v: unknown): TradeLine[] {
  if (!Array.isArray(v)) return [];
  const out: TradeLine[] = [];
  for (const raw of v.slice(0, MAX_PUBLIC_LINES)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const oracleId = str(r.oracleId, 64);
    const scryfallId = str(r.scryfallId, 64);
    const quantity = posInt(r.quantity, 9999);
    if (!oracleId || !scryfallId || quantity < 1) continue;
    out.push({
      oracleId,
      scryfallId,
      name: str(r.name, 200) ?? '(unknown card)',
      quantity,
      condition: (CONDS.has(r.condition as string) ? r.condition : 'NM') as TradeLine['condition'],
      finish: (FINS.has(r.finish as string) ? r.finish : 'nonfoil') as TradeLine['finish'],
      lang: str(r.lang, 10) ?? 'en',
    });
  }
  return out;
}

function normalizeWishLines(v: unknown): WishLine[] {
  if (!Array.isArray(v)) return [];
  const out: WishLine[] = [];
  for (const raw of v.slice(0, MAX_PUBLIC_LINES)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const oracleId = str(r.oracleId, 64);
    const quantity = posInt(r.quantity, 9999);
    if (!oracleId || quantity < 1) continue;
    out.push({
      oracleId,
      scryfallId: str(r.scryfallId, 64),
      name: str(r.name, 200) ?? '(unknown card)',
      quantity,
    });
  }
  return out;
}

function normalizeCounts(v: unknown): SnapshotCounts {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    cards: posInt(r.cards, 10_000_000),
    collectionEntries: posInt(r.collectionEntries, 10_000_000),
    wishlist: posInt(r.wishlist, 10_000_000),
    decks: posInt(r.decks, 10_000_000),
    trades: posInt(r.trades, 10_000_000),
  };
}

export function registerAccountRoutes(app: FastifyInstance, store: AccountStore, hub: SyncHub): void {
  // --- CORS (the PWA is served from GitHub Pages, a different origin) -------
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    const origin = req.headers.origin;
    if (!origin) return;
    if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) return;
    void reply.header('Access-Control-Allow-Origin', origin);
    void reply.header('Vary', 'Origin');
  });
  app.options('/api/*', async (req, reply) => {
    void reply
      .header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
      .header('Access-Control-Allow-Headers', 'content-type,authorization')
      .header('Access-Control-Max-Age', '86400');
    return reply.status(204).send();
  });

  // --- Per-IP throttle on credential endpoints -------------------------------
  const attempts = new Map<string, { count: number; resetAt: number }>();
  function throttled(ip: string): boolean {
    const now = Date.now();
    const slot = attempts.get(ip);
    if (!slot || slot.resetAt <= now) {
      attempts.set(ip, { count: 1, resetAt: now + config.authWindowMs });
      return false;
    }
    slot.count += 1;
    return slot.count > config.authAttemptsPerWindow;
  }
  // The map only grows on credential attempts; sweep expired slots hourly.
  const sweep = setInterval(() => {
    const now = Date.now();
    attempts.forEach((slot, ip) => {
      if (slot.resetAt <= now) attempts.delete(ip);
    });
  }, 60 * 60 * 1000);
  sweep.unref();

  const requireUser = (req: FastifyRequest, reply: FastifyReply) => authUser(store, req, reply);

  // --- Auth -----------------------------------------------------------------

  app.post('/api/register', async (req, reply) => {
    if (throttled(req.ip)) return fail(reply, 429, { error: 'rate_limited', message: 'Too many attempts. Try again later.' });
    if (!config.inviteCode) {
      return fail(reply, 403, { error: 'registration_closed', message: 'Registration is closed right now.' });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const invite = typeof b.inviteCode === 'string' ? b.inviteCode.trim() : '';
    if (!USERNAME_RE.test(username)) {
      return fail(reply, 400, { error: 'bad_request', message: 'Username must be 3–20 letters, digits or underscores.' });
    }
    if (password.length < MIN_PASSWORD_CHARS || password.length > MAX_PASSWORD_CHARS) {
      return fail(reply, 400, { error: 'bad_request', message: `Password must be at least ${MIN_PASSWORD_CHARS} characters.` });
    }
    if (invite !== config.inviteCode) {
      return fail(reply, 403, { error: 'invalid_invite', message: 'That invite code is not valid.' });
    }
    const user = store.createUser(username, password);
    if (!user) return fail(reply, 409, { error: 'username_taken', message: 'That username is already taken.' });
    app.log.info({ username }, 'account created');
    const res: AuthResponse = { token: store.issueToken(user.id), username: user.username };
    return reply.status(201).send(res);
  });

  app.post('/api/login', async (req, reply) => {
    if (throttled(req.ip)) return fail(reply, 429, { error: 'rate_limited', message: 'Too many attempts. Try again later.' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const user = username && password ? store.authenticate(username, password) : null;
    if (!user) return fail(reply, 401, { error: 'invalid_credentials', message: 'Wrong username or password.' });
    const res: AuthResponse = { token: store.issueToken(user.id), username: user.username };
    return res;
  });

  app.post('/api/logout', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const auth = req.headers.authorization!;
    store.revokeToken(auth.slice('Bearer '.length));
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res: MeResponse = {
      username: user.username,
      snapshot: store.snapshotMeta(user.id),
      sync: { seq: store.syncSeq(user.id) },
    };
    return res;
  });

  app.delete('/api/account', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    store.deleteUser(user.id);
    app.log.info({ username: user.username }, 'account deleted');
    return { ok: true };
  });

  // --- Snapshot backup/restore ------------------------------------------------

  app.put('/api/snapshot', { bodyLimit: SNAPSHOT_BODY_LIMIT }, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const payload = typeof b.payload === 'string' ? b.payload : null;
    const baseVersion =
      b.baseVersion === null || b.baseVersion === undefined ? null : Math.floor(Number(b.baseVersion));
    if (!payload || (baseVersion !== null && !Number.isFinite(baseVersion))) {
      return fail(reply, 400, { error: 'bad_request', message: 'Malformed snapshot upload.' });
    }
    if (payload.length > MAX_SNAPSHOT_CHARS) {
      return fail(reply, 413, { error: 'too_large', message: 'Your data is too large to back up.' });
    }
    const tradelist = normalizeTradeLines(b.tradelist);
    const wishlist = normalizeWishLines(b.wishlist);
    const tradelistJson = JSON.stringify(tradelist);
    const wishlistJson = JSON.stringify(wishlist);
    if (tradelistJson.length > MAX_LIST_JSON_CHARS || wishlistJson.length > MAX_LIST_JSON_CHARS) {
      return fail(reply, 413, { error: 'too_large', message: 'Published lists are too large.' });
    }
    const result = store.putSnapshot(
      user.id,
      baseVersion,
      payload,
      normalizeCounts(b.counts),
      tradelistJson,
      tradelist.length,
      wishlistJson,
      wishlist.length,
    );
    if (result.conflict) {
      return fail(reply, 409, {
        error: 'version_conflict',
        message: 'A newer backup exists (from another device?).',
        version: result.version,
        updatedAt: result.updatedAt,
      });
    }
    const res: SnapshotPutResponse = { version: result.version, updatedAt: result.updatedAt };
    return res;
  });

  app.get('/api/snapshot', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const snap = store.getSnapshot(user.id);
    if (!snap) return fail(reply, 404, { error: 'not_found', message: 'No backup stored yet.' });
    const res: SnapshotGetResponse = snap;
    return res;
  });

  // --- Row-level sync (sync plan, 2026-07-16) ----------------------------------
  //
  // One atomic pull+push per call. Row CONTENT is opaque to the server (same
  // trust model as the snapshot blob) — only the envelope is validated here;
  // clients sanitize rows on apply exactly like device-transfer rows.

  const SYNC_TABLE_SET = new Set<string>(SYNC_TABLES);

  app.post('/api/sync', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const clientId = str(b.clientId, 64);
    const cursor = Math.max(0, Math.floor(Number(b.cursor)) || 0);
    const rawChanges = Array.isArray(b.changes) ? b.changes : null;
    if (!clientId || !rawChanges || rawChanges.length > SYNC_MAX_PUSH) {
      return fail(reply, 400, { error: 'bad_request', message: 'Malformed sync request.' });
    }

    const changes: SyncChange[] = [];
    for (const raw of rawChanges) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const tbl = SYNC_TABLE_SET.has(r.tbl as string) ? (r.tbl as SyncTable) : null;
      const rowId = str(r.rowId, 64);
      const updatedAt = Number(r.updatedAt);
      if (!tbl || !rowId || !Number.isFinite(updatedAt)) {
        return fail(reply, 400, { error: 'bad_request', message: 'Malformed sync change.' });
      }
      if (r.deleted === true) {
        changes.push({ tbl, rowId, updatedAt, deleted: true });
        continue;
      }
      if (r.row === undefined || r.row === null) {
        return fail(reply, 400, { error: 'bad_request', message: 'Sync change is missing its row.' });
      }
      if (JSON.stringify(r.row).length > SYNC_MAX_ROW_CHARS) {
        return fail(reply, 413, { error: 'too_large', message: 'A synced row is too large.' });
      }
      changes.push({ tbl, rowId, updatedAt, row: r.row });
    }

    // Piggybacked public lists (the sync-era replacement for the snapshot upload).
    if (b.publish && typeof b.publish === 'object') {
      const p = b.publish as Record<string, unknown>;
      const tradelist = normalizeTradeLines(p.tradelist);
      const wishlist = normalizeWishLines(p.wishlist);
      const tradelistJson = JSON.stringify(tradelist);
      const wishlistJson = JSON.stringify(wishlist);
      if (tradelistJson.length > MAX_LIST_JSON_CHARS || wishlistJson.length > MAX_LIST_JSON_CHARS) {
        return fail(reply, 413, { error: 'too_large', message: 'Published lists are too large.' });
      }
      store.putPublicLists(user.id, tradelistJson, tradelist.length, wishlistJson, wishlist.length);
    }

    let result;
    try {
      result = store.syncApply(user.id, cursor, changes, Date.now());
    } catch (err) {
      if (err instanceof SyncCapError) {
        return fail(reply, 413, { error: 'too_large', message: 'This account has hit its sync storage limit.' });
      }
      throw err;
    }
    if (result.applied > 0) hub.notify(user.id, result.cursor, clientId);
    const res: SyncResponse = {
      cursor: result.cursor,
      changes: result.changes,
      ...(result.hasMore ? { hasMore: true as const } : {}),
    };
    return res;
  });

  // --- Community: published trade/wishlists -----------------------------------

  app.get('/api/users', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res: UsersResponse = { users: store.listUsers() };
    return res;
  });

  // --- Public profiles: favorites + profile picture ----------------------------

  app.put('/api/profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const profile = sanitizeProfile(b.profile);
    const json = JSON.stringify(profile);
    if (json.length > MAX_PROFILE_JSON_CHARS) {
      return fail(reply, 413, { error: 'too_large', message: 'Profile is too large.' });
    }
    const res: ProfilePutResponse = { updatedAt: store.putProfile(user.id, json) };
    return res;
  });

  app.get('/api/users/:username/profile', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { username } = req.params as { username: string };
    const target = store.getUserByUsername(username);
    if (!target) return fail(reply, 404, { error: 'not_found', message: 'No such user.' });
    const row = store.getProfile(target.id);
    // No profile yet is a normal state, not an error — hand back an empty one.
    const profile = row ? sanitizeProfile(safeParse(row.data)) : EMPTY_PROFILE;
    refreshFavoriteDecks(store, target.id, profile);
    const res: ProfileResponse = {
      username: target.username,
      updatedAt: row?.updatedAt ?? 0,
      profile,
    };
    return res;
  });

  // A favorited deck is browsable: serve its current list straight from the
  // owner's synced rows (see shared/profile.ts for the trust-model note).
  app.get('/api/users/:username/decks/:deckId', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { username, deckId } = req.params as { username: string; deckId: string };
    const target = store.getUserByUsername(username);
    if (!target) return fail(reply, 404, { error: 'not_found', message: 'No such user.' });
    const profRow = store.getProfile(target.id);
    const profile = profRow ? sanitizeProfile(safeParse(profRow.data)) : EMPTY_PROFILE;
    if (!profile.favoriteDecks.some((f) => f.deckId === deckId)) {
      return fail(reply, 404, { error: 'not_found', message: 'That deck isn’t shared.' });
    }
    const deckRow = store.getSyncRow(target.id, 'decks', deckId);
    if (!deckRow || !deckRow.row || typeof deckRow.row !== 'object') {
      return fail(reply, 404, { error: 'not_found', message: 'That deck isn’t synced to the server.' });
    }
    const d = deckRow.row as Record<string, unknown>;
    const description = str(d.description, 1_000);
    const res: UserDeckResponse = {
      username: target.username,
      name: str(d.name, 80) ?? '(unnamed deck)',
      format: str(d.format, 20) ?? 'casual',
      ...(description ? { description } : {}),
      updatedAt: deckRow.updatedAt,
      lines: sanitizeDeckLines(deckCardRows(store, target.id, deckId)),
    };
    return res;
  });

  app.get('/api/users/:username/lists', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { username } = req.params as { username: string };
    const row = store.getUserLists(username);
    if (!row) return fail(reply, 404, { error: 'not_found', message: 'No such user (or nothing published yet).' });
    const res: UserListsResponse = {
      username: row.username,
      updatedAt: row.updatedAt,
      tradelist: safeLines(row.tradelist) as TradeLine[],
      wishlist: safeLines(row.wishlist) as WishLine[],
    };
    return res;
  });

  // --- Match notifications: users whose lists overlap mine (either way) -------
  app.get('/api/matches', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const rows = store.allPublicLists();
    const mine = rows.find((r) => r.userId === user.id);
    if (!mine) return { matches: [] } satisfies MatchesResponse; // nothing published yet

    // My haves (oracleId → a display name) and my wants (oracleId set).
    const myHaves = oracleNames(safeLines(mine.tradelist) as TradeLine[]);
    const myWants = new Set((safeLines(mine.wishlist) as WishLine[]).map((l) => l.oracleId));

    const matches: MatchEntry[] = [];
    for (const other of rows) {
      if (other.userId === user.id) continue;
      const theirHaves = oracleNames(safeLines(other.tradelist) as TradeLine[]);
      const theirWants = new Set((safeLines(other.wishlist) as WishLine[]).map((l) => l.oracleId));

      // They want a card I have for trade / I want a card they have for trade.
      const theyWant: MatchCard[] = [];
      for (const [oracleId, name] of myHaves) if (theirWants.has(oracleId)) theyWant.push({ oracleId, name });
      const iWant: MatchCard[] = [];
      for (const [oracleId, name] of theirHaves) if (myWants.has(oracleId)) iWant.push({ oracleId, name });

      if (theyWant.length === 0 && iWant.length === 0) continue;
      matches.push({
        username: other.username,
        updatedAt: other.updatedAt,
        theyWant,
        iWant,
        signature: matchSignature(theyWant, iWant),
      });
    }
    matches.sort((a, b) => b.updatedAt - a.updatedAt);
    return { matches } satisfies MatchesResponse;
  });
}

/** The owner's synced deckCards rows for one deck (raw, pre-sanitize). */
function deckCardRows(store: AccountStore, userId: number, deckId: string): unknown[] {
  return store
    .listSyncRows(userId, 'deckCards')
    .filter((row) => !!row && typeof row === 'object' && (row as Record<string, unknown>).deckId === deckId);
}

/**
 * Overwrite favorite-deck summaries with the live synced deck where possible,
 * so a rename (or growing list) shows up on the profile without re-favoriting.
 * Colors stay as favorited — computing them needs a card DB the server lacks.
 */
function refreshFavoriteDecks(store: AccountStore, userId: number, profile: UserProfile): void {
  let counts: Map<string, number> | null = null;
  for (const fav of profile.favoriteDecks) {
    if (!fav.deckId) continue;
    const deckRow = store.getSyncRow(userId, 'decks', fav.deckId);
    if (!deckRow || !deckRow.row || typeof deckRow.row !== 'object') continue;
    const d = deckRow.row as Record<string, unknown>;
    fav.name = str(d.name, 80) ?? fav.name;
    fav.format = str(d.format, 20) ?? fav.format;
    if (!counts) counts = deckMainCounts(store, userId);
    fav.cards = counts.get(fav.deckId) ?? fav.cards;
  }
}

/** deckId → mainboard count (commander included, like the deck picker computes it). */
function deckMainCounts(store: AccountStore, userId: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of store.listSyncRows(userId, 'deckCards')) {
    if (!row || typeof row !== 'object') continue;
    const c = row as Record<string, unknown>;
    if (typeof c.deckId !== 'string' || c.board === 'side') continue;
    const q = Math.floor(Number(c.quantity));
    if (Number.isFinite(q) && q > 0) map.set(c.deckId, (map.get(c.deckId) ?? 0) + q);
  }
  return map;
}

/** oracleId → display name, deduped (first name wins), for a published list. */
function oracleNames(lines: { oracleId: string; name: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) if (!out.has(l.oracleId)) out.set(l.oracleId, l.name);
  return out;
}

/** Order-independent hash of a match's oracleIds, so the client can spot changes. */
function matchSignature(theyWant: MatchCard[], iWant: MatchCard[]): string {
  const parts = [
    ...theyWant.map((c) => `w:${c.oracleId}`),
    ...iWant.map((c) => `h:${c.oracleId}`),
  ].sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function safeLines(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
