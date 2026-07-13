import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAX_PASSWORD_CHARS,
  MAX_PUBLIC_LINES,
  MAX_SNAPSHOT_CHARS,
  MIN_PASSWORD_CHARS,
  USERNAME_RE,
  type ApiErrorBody,
  type AuthResponse,
  type MeResponse,
  type SnapshotCounts,
  type SnapshotGetResponse,
  type SnapshotPutResponse,
  type TradeLine,
  type UserListsResponse,
  type UsersResponse,
  type WishLine,
} from '@mtg/shared';
import { config } from './config.js';
import { AccountStore, type AccountUser } from './accountStore.js';

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

function fail(reply: FastifyReply, status: number, body: ApiErrorBody): void {
  void reply.status(status).send(body);
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

export function registerAccountRoutes(app: FastifyInstance): void {
  const store = new AccountStore(config.dataDir);
  app.addHook('onClose', () => store.close());

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

  function requireUser(req: FastifyRequest, reply: FastifyReply): AccountUser | null {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    const user = token ? store.userForToken(token) : null;
    if (!user) {
      fail(reply, 401, { error: 'unauthorized', message: 'Sign in first.' });
      return null;
    }
    return user;
  }

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
    const res: MeResponse = { username: user.username, snapshot: store.snapshotMeta(user.id) };
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

  // --- Community: published trade/wishlists -----------------------------------

  app.get('/api/users', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const res: UsersResponse = { users: store.listUsers() };
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
}

function safeLines(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
