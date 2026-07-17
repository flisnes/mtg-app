import type { PriceHistory } from '@mtg/shared';
import { ACCOUNTS_ENABLED } from '../account/config.js';
import { getPrices } from '../account/api.js';
import { getAccountSession } from '../account/session.js';
import { db } from '../db/schema.js';
import { mergeHistories } from './history.js';

// Server-backed price history (sync plan Phase E). Signed-in users get the
// server's daily archive — which covers every printing from the day the
// archive started, not just ones this device has seen — merged over the local
// per-device readings. The merged row is written back to `priceHistories` so
// charts keep the long window offline; local-only users keep plain device
// tracking. Failures (offline, signed out, old server without the endpoint,
// nothing archived yet) all just mean "local only".

/** The server's history for one printing, or null when unavailable. */
async function fetchServerHistory(scryfallId: string): Promise<PriceHistory | null> {
  if (!ACCOUNTS_ENABLED) return null;
  const session = await getAccountSession();
  if (!session) return null;
  try {
    const res = await getPrices(session.token, scryfallId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(res.startDay) || !Array.isArray(res.eur) || !Array.isArray(res.usd)) {
      return null;
    }
    const clean = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
    return {
      scryfallId,
      startDay: res.startDay,
      eur: res.eur.map(clean),
      usd: res.usd.map(clean),
    };
  } catch {
    return null;
  }
}

/**
 * Local + server history for a printing, merged (device readings win ties).
 * When server data arrives, the merged row is cached back into Dexie for
 * offline use — for untracked cards the next tracking sweep drops it again,
 * which is fine: it re-fetches whenever the card is viewed online.
 */
export async function getMergedPriceHistory(scryfallId: string): Promise<PriceHistory | undefined> {
  const [local, server] = await Promise.all([db.priceHistories.get(scryfallId), fetchServerHistory(scryfallId)]);
  if (!server) return local;
  const merged = local ? mergeHistories(server, local) : server;
  await db.priceHistories.put(merged);
  return merged;
}
