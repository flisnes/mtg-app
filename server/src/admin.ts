import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  USERNAME_RE,
  type AdminJobName,
  type AdminJobRunResponse,
  type AdminOverviewResponse,
} from '@mtg/shared';
import { authUser, fail } from './accounts.js';
import type { AccountStore, AccountUser } from './accountStore.js';
import { config, isAdminUsername } from './config.js';
import type { PeriodicJob } from './jobs.js';
import { BACKFILL_ATTEMPTS_KEY, BACKFILL_DONE_KEY } from './priceBackfill.js';
import { MONTHLY_META_KEY } from './priceMonthly.js';
import type { PriceStore } from './priceStore.js';
import { relayStats } from './relay.js';
import type { SyncHub } from './syncHub.js';

// The operator's view of the server (the "Admin panel for server" card).
// Signed-in users whose username is in ADMIN_USERNAMES get metadata: counts,
// sizes, timestamps, job outcomes, and a few levers (run a job now, sign a
// user out everywhere, delete an account). Synced rows stay opaque here as
// everywhere else on the server; nothing in this module reads them.
//
// Lives under /api/admin/* so Caddy's existing /api/* proxy and the accounts
// CORS hook cover it without VM-side changes.

const DAY_MS = 24 * 60 * 60 * 1000;
const startedAt = Date.now();

export interface AdminJobs {
  archive: PeriodicJob;
  monthly: PeriodicJob;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  store: AccountStore,
  prices: PriceStore,
  hub: SyncHub,
  jobs: AdminJobs,
): void {
  /** Resolve the bearer token to an admin, or 401/403. */
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): AccountUser | null => {
    const user = authUser(store, req, reply);
    if (!user) return null;
    if (!isAdminUsername(user.username)) {
      fail(reply, 403, { error: 'forbidden', message: 'This account is not an admin.' });
      return null;
    }
    return user;
  };

  /** The :username param, looked up; 404 when unknown. */
  const targetUser = (req: FastifyRequest, reply: FastifyReply): AccountUser | null => {
    const { username } = req.params as { username: string };
    const target = USERNAME_RE.test(username) ? store.getUserByUsername(username) : null;
    if (!target) {
      fail(reply, 404, { error: 'not_found', message: 'No such user.' });
      return null;
    }
    return target;
  };

  app.get('/api/admin/overview', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const now = Date.now();
    const users = store.adminUsers();
    const mem = process.memoryUsage();
    const relay = relayStats();
    const archive = prices.stats();
    const res: AdminOverviewResponse = {
      server: {
        now,
        startedAt,
        nodeVersion: process.version,
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        accountsDbBytes: store.dbSizeBytes(),
        pricesDbBytes: prices.dbSizeBytes(),
        registrationOpen: config.inviteCode !== '',
        admins: config.adminUsernames,
      },
      accounts: {
        total: users.length,
        newLast7d: users.filter((u) => u.createdAt >= now - 7 * DAY_MS).length,
        newLast30d: users.filter((u) => u.createdAt >= now - 30 * DAY_MS).length,
        activeLast7d: users.filter((u) => (u.lastSeen ?? 0) >= now - 7 * DAY_MS).length,
        users,
      },
      live: {
        sessions: relay.sessions,
        transfers: relay.transfers,
        syncSubscribers: hub.stats(),
        counters: relay.counters,
      },
      archive: {
        lastDay: archive.lastDay,
        printings: archive.printings,
        job: jobs.archive.status(),
        monthly: {
          printings: prices.monthlyCount(),
          imported: prices.getMeta(MONTHLY_META_KEY),
          job: jobs.monthly.status(),
        },
        backfill: {
          done: prices.getMeta(BACKFILL_DONE_KEY),
          attempts: Number(prices.getMeta(BACKFILL_ATTEMPTS_KEY) || '0'),
        },
      },
    };
    void reply.header('Cache-Control', 'no-store');
    return res;
  });

  app.post('/api/admin/jobs/:job/run', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const { job } = req.params as { job: string };
    if (job !== 'archive' && job !== 'monthly') {
      return fail(reply, 404, { error: 'not_found', message: 'No such job.' });
    }
    const name: AdminJobName = job;
    try {
      const result = await jobs[name].runNow();
      app.log.info({ job: name, result, by: admin.username }, 'admin ran job');
      return { job: name, result } satisfies AdminJobRunResponse;
    } catch (err) {
      return fail(reply, 502, { error: 'job_failed', message: (err as Error).message });
    }
  });

  app.post('/api/admin/users/:username/revoke-tokens', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const target = targetUser(req, reply);
    if (!target) return;
    const revoked = store.revokeUserTokens(target.id);
    app.log.info({ username: target.username, revoked, by: admin.username }, 'admin revoked tokens');
    return { ok: true, revoked };
  });

  app.delete('/api/admin/users/:username', async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return;
    const target = targetUser(req, reply);
    if (!target) return;
    // Your own account goes through Settings like everyone else's, so a slip
    // here can't lock the operator out.
    if (target.id === admin.id) {
      return fail(reply, 400, { error: 'bad_request', message: 'Delete your own account from Settings.' });
    }
    store.deleteUser(target.id);
    app.log.info({ username: target.username, by: admin.username }, 'admin deleted account');
    return { ok: true };
  });
}
