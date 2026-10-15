import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  EMPTY_PROFILE,
  MAX_PASSWORD_CHARS,
  MAX_PROFILE_JSON_CHARS,
  MAX_PUBLIC_LINES,
  MIN_PASSWORD_CHARS,
  SYNC_MAX_PUSH,
  SYNC_MAX_ROW_BYTES,
  SYNC_MAX_ROW_ID,
  SYNC_TABLES,
  USERNAME_RE,
  clampStr,
  countsTowardDeck,
  sanitizeDeckLines,
  sanitizeProfile,
  sanitizeTradeLines,
  sanitizeWishLines,
  wishMatchesCopy,
  type ApiErrorBody,
  type AuthResponse,
  type MatchCard,
  type MatchEntry,
  type MatchesResponse,
  type MeResponse,
  type ProfilePutResponse,
  type ProfileResponse,
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
// user's rows as opaque JSON plus their published trade/wishlists; browsing
// endpoints require a signed-in user, so lists are only visible to other
// account holders — which is exactly what the signup disclaimer says.

/** Serialized-JSON cap per published list (~2 MB keeps rows renderable). */
const MAX_LIST_JSON_CHARS = 2_000_000;

/** Bounds for a whole published list (larger than a single live trade offer). */
const PUBLIC_LINE_LIMITS = { maxQty: 9999, maxLines: MAX_PUBLIC_LINES };

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

/** private + no-cache: the browser keeps a copy but asks every time (304 if unchanged). */
export const REVALIDATE = 'private, no-cache';

/**
 * Answer a GET through the browser's HTTP cache. With a stamp, the ETag comes
 * from it and `build` is skipped entirely on a match; without one, the body is
 * built and hashed (saves the transfer, not the work). Every tag includes what
 * makes the response differ per caller, since the cache key is just the URL.
 */
export function sendCached<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  cacheControl: string,
  stamp: string | null,
  build: () => T,
): T | FastifyReply {
  let body: T | undefined;
  if (stamp === null) {
    body = build();
    stamp = createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 22);
  }
  const etag = `W/"${stamp}"`;
  void reply.header('ETag', etag).header('Cache-Control', cacheControl);
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim() === etag)) return reply.status(304).send();
  return body ?? build();
}

/** The user's sanitized profile, or the empty one if they never saved it. */
function profileOf(store: AccountStore, userId: number): { profile: UserProfile; updatedAt: number } {
  const row = store.getProfile(userId);
  // No profile yet is a normal state, not an error.
  if (!row) return { profile: EMPTY_PROFILE, updatedAt: 0 };
  return { profile: sanitizeProfile(safeParse(row.data)), updatedAt: row.updatedAt };
}

// Server-side normalization of published lines (clients re-sanitize on
// display); shares the field/enum rules with the trade path via @mtg/shared.
function normalizeTradeLines(v: unknown): TradeLine[] {
  return sanitizeTradeLines(v, PUBLIC_LINE_LIMITS);
}

function normalizeWishLines(v: unknown): WishLine[] {
  return sanitizeWishLines(v, PUBLIC_LINE_LIMITS);
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
  app.options('/api/*', async (_req, reply) => {
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
    const user = await store.createUser(username, password);
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
    const user = username && password ? await store.authenticate(username, password) : null;
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
      sync: { seq: store.syncSeq(user.id), usage: store.syncUsage(user.id) },
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
    const clientId = clampStr(b.clientId, 64);
    const cursor = Math.max(0, Math.floor(Number(b.cursor)) || 0);
    const reseeding = b.reseeding === true;
    const rawChanges = Array.isArray(b.changes) ? b.changes : null;
    if (!clientId || !rawChanges || rawChanges.length > SYNC_MAX_PUSH) {
      return fail(reply, 400, { error: 'bad_request', message: 'Malformed sync request.' });
    }

    const changes: SyncChange[] = [];
    for (const raw of rawChanges) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const tbl = SYNC_TABLE_SET.has(r.tbl as string) ? (r.tbl as SyncTable) : null;
      const rowId = clampStr(r.rowId, SYNC_MAX_ROW_ID);
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
      if (Buffer.byteLength(JSON.stringify(r.row)) > SYNC_MAX_ROW_BYTES[tbl]) {
        return fail(reply, 413, { error: 'too_large', message: 'A synced row is too large.' });
      }
      changes.push({ tbl, rowId, updatedAt, row: r.row });
    }

    // Piggybacked public lists (the sync-era replacement for the snapshot
    // upload). Validate + prepare now, but write only after the push applies —
    // a rejected or capped push must not overwrite the published lists.
    let publish: { tradelistJson: string; tradelistCount: number; wishlistJson: string; wishlistCount: number } | null =
      null;
    if (b.publish && typeof b.publish === 'object') {
      const p = b.publish as Record<string, unknown>;
      const tradelist = normalizeTradeLines(p.tradelist);
      const wishlist = normalizeWishLines(p.wishlist);
      const tradelistJson = JSON.stringify(tradelist);
      const wishlistJson = JSON.stringify(wishlist);
      if (tradelistJson.length > MAX_LIST_JSON_CHARS || wishlistJson.length > MAX_LIST_JSON_CHARS) {
        return fail(reply, 413, { error: 'too_large', message: 'Published lists are too large.' });
      }
      publish = { tradelistJson, tradelistCount: tradelist.length, wishlistJson, wishlistCount: wishlist.length };
    }

    let result;
    try {
      result = store.syncApply(user.id, clientId, cursor, changes, Date.now(), reseeding);
    } catch (err) {
      if (err instanceof SyncCapError) {
        const what = err.kind === 'rows' ? 'number of items' : 'storage size';
        return fail(reply, 413, {
          error: 'too_large',
          message: `This account has hit its sync ${what} limit. Remove some cards, or delete old history.`,
        });
      }
      throw err;
    }
    // Publish only once the client is caught up (a capped pull re-sends), so the
    // published lists always reflect a fully-applied push.
    if (publish && !result.hasMore && !result.resync) {
      store.putPublicLists(user.id, publish.tradelistJson, publish.tradelistCount, publish.wishlistJson, publish.wishlistCount);
    }
    if (result.applied > 0) hub.notify(user.id, result.cursor, clientId);
    const res: SyncResponse = {
      cursor: result.cursor,
      changes: result.changes,
      ...(result.hasMore ? { hasMore: true as const } : {}),
      ...(result.resync ? { resync: true as const } : {}),
    };
    return res;
  });

  // --- Community: published trade/wishlists -----------------------------------

  app.get('/api/users', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    return sendCached(req, reply, REVALIDATE, null, (): UsersResponse => ({ users: store.listUsers() }));
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
    return sendCached(req, reply, REVALIDATE, null, (): ProfileResponse => {
      const { profile, updatedAt } = profileOf(store, target.id);
      refreshFavoriteDecks(store, target.id, profile);
      return { username: target.username, updatedAt, profile };
    });
  });

  // A favorited deck is browsable: serve its current list straight from the
  // owner's synced rows (see shared/profile.ts for the trust-model note).
  app.get('/api/users/:username/decks/:deckId', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { username, deckId } = req.params as { username: string; deckId: string };
    const target = store.getUserByUsername(username);
    if (!target) return fail(reply, 404, { error: 'not_found', message: 'No such user.' });
    const { profile } = profileOf(store, target.id);
    if (!profile.favoriteDecks.some((f) => f.deckId === deckId)) {
      return fail(reply, 404, { error: 'not_found', message: 'That deck isn’t shared.' });
    }
    const deckRow = store.getSyncRow(target.id, 'decks', deckId);
    if (!deckRow || !deckRow.row || typeof deckRow.row !== 'object') {
      return fail(reply, 404, { error: 'not_found', message: 'That deck isn’t synced to the server.' });
    }
    const d = deckRow.row as Record<string, unknown>;
    const description = clampStr(d.description, 1_000);
    const res: UserDeckResponse = {
      username: target.username,
      name: clampStr(d.name, 80) ?? '(unnamed deck)',
      format: clampStr(d.format, 20) ?? 'casual',
      ...(description ? { description } : {}),
      updatedAt: deckRow.updatedAt,
      lines: sanitizeDeckLines(store.deckCardRows(target.id, deckId)),
    };
    return res;
  });

  app.get('/api/users/:username/lists', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const { username } = req.params as { username: string };
    const stamp = store.userListsStamp(username);
    if (!stamp) return fail(reply, 404, { error: 'not_found', message: 'No such user (or nothing published yet).' });
    // The lists run to megabytes: tag them by publish time so a revisit is a
    // 304 without reading, parsing or sending them again.
    return sendCached(req, reply, REVALIDATE, `${stamp.userId}-${stamp.updatedAt}`, (): UserListsResponse => {
      const r = store.getUserLists(username)!; // the stamp just found it, and nothing awaits in between
      return {
        username: r.username,
        updatedAt: r.updatedAt,
        tradelist: safeLines(r.tradelist) as TradeLine[],
        wishlist: safeLines(r.wishlist) as WishLine[],
      };
    });
  });

  // --- Match notifications: users whose lists overlap mine (either way) -------
  app.get('/api/matches', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    // Matches only change when some published list does; the tag carries the
    // caller because the answer is theirs alone.
    const stamp = `${store.publicListsStamp()}-${user.id}`;
    return sendCached(req, reply, REVALIDATE, stamp, () => computeMatches(store, user.id));
  });
}

/** Users whose published lists overlap the caller's, either way. */
function computeMatches(store: AccountStore, userId: number): MatchesResponse {
  const lists = store.parsedPublicLists();
  const mine = lists.find((r) => r.userId === userId);
  if (!mine) return { matches: [] }; // nothing published yet

  // They want a card I have for trade / I want a card they have for trade.
  // wishMatchesCopy is the same rule the Community page paints its badges
  // with (printing pin included), so a notification never promises a match
  // the page then refuses to show. Wants are bucketed by card, so a have only
  // meets the wishes for that same card.
  const wanted = (wants: Map<string, WishLine[]>, h: TradeLine) =>
    wants.get(h.oracleId)?.some((w) => wishMatchesCopy(w, h)) ?? false;

  const matches: MatchEntry[] = [];
  for (const other of lists) {
    if (other.userId === userId) continue;
    const theyWant = dedupeMatches(mine.haves.filter((h) => wanted(other.wantsByOracle, h)));
    const iWant = dedupeMatches(other.haves.filter((h) => wanted(mine.wantsByOracle, h)));
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
  return { matches };
}

/**
 * Collapse matched have-lines to one MatchCard per oracleId (a tradelist can
 * hold several printings/conditions of the same card; the notification names it
 * once). First name wins, matching the old deduped-by-oracle behavior.
 */
function dedupeMatches(haves: { oracleId: string; name: string }[]): MatchCard[] {
  const seen = new Set<string>();
  const out: MatchCard[] = [];
  for (const h of haves) {
    if (seen.has(h.oracleId)) continue;
    seen.add(h.oracleId);
    out.push({ oracleId: h.oracleId, name: h.name });
  }
  return out;
}

/**
 * Overwrite favorite-deck summaries with the live synced deck where possible,
 * so a rename (or growing list) shows up on the profile without re-favoriting.
 * Colors stay as favorited — computing them needs a card DB the server lacks.
 */
function refreshFavoriteDecks(store: AccountStore, userId: number, profile: UserProfile): void {
  for (const fav of profile.favoriteDecks) {
    if (!fav.deckId) continue;
    const deckRow = store.getSyncRow(userId, 'decks', fav.deckId);
    if (!deckRow || !deckRow.row || typeof deckRow.row !== 'object') continue;
    const d = deckRow.row as Record<string, unknown>;
    fav.name = clampStr(d.name, 80) ?? fav.name;
    fav.format = clampStr(d.format, 20) ?? fav.format;
    fav.cards = deckMainCount(store, userId, fav.deckId);
  }
}

/** A deck's mainboard count (commander included, like the deck picker computes it). */
function deckMainCount(store: AccountStore, userId: number, deckId: string): number {
  let n = 0;
  for (const row of store.deckCardRows(userId, deckId)) {
    if (!row || typeof row !== 'object') continue;
    const c = row as Record<string, unknown>;
    if (!countsTowardDeck(c.board ?? 'main')) continue;
    const q = Math.floor(Number(c.quantity));
    if (Number.isFinite(q) && q > 0) n += q;
  }
  return n;
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
