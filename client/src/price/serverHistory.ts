import type { MonthlyReadings, PriceHistory } from '@mtg/shared';
import { ACCOUNTS_ENABLED } from '../account/config.js';
import { getPrices } from '../account/api.js';
import { getAccountSession } from '../account/session.js';
import { db } from '../db/schema.js';
import { mergeHistories, todayKey } from './history.js';

// Server-backed price history (sync plan Phase E). Signed-in users get the
// server's daily archive — which covers every printing from the day the
// archive started, not just ones this device has seen — merged over the local
// per-device readings. The merged row is written back to `priceHistories` so
// charts keep the long window offline; local-only users keep plain device
// tracking. Failures (offline, signed out, old server without the endpoint,
// nothing archived yet) all just mean "local only".
//
// Since v0.198.0 the reply can also carry foil lanes and a monthly deep
// history; an older server simply leaves them out.

const clean = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

/** A lane off the wire, or undefined when it's missing or malformed. */
function lane(v: unknown, max: number): (number | null)[] | undefined {
  return Array.isArray(v) ? v.slice(0, max).map(clean) : undefined;
}

function cleanMonthly(v: unknown): MonthlyReadings | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.startMonth !== 'string' || !/^\d{4}-\d{2}$/.test(m.startMonth)) return undefined;
  const out: MonthlyReadings = { startMonth: m.startMonth };
  for (const key of ['eur', 'usd', 'eurFoil', 'usdFoil'] as const) {
    const cells = lane(m[key], 600);
    if (cells) out[key] = cells;
  }
  return out;
}

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
    const eur = res.eur.map(clean);
    // A printing the server only knows by the month has no daily window; anchor
    // it at today so local tracking doesn't pad years of empty days behind it.
    const startDay = eur.length ? res.startDay : todayKey();
    const h: PriceHistory = { scryfallId, startDay, eur, usd: res.usd.slice(0, eur.length).map(clean) };
    // Foil lanes never run past the nonfoil window.
    const eurFoil = lane(res.eurFoil, eur.length);
    const usdFoil = lane(res.usdFoil, eur.length);
    if (eurFoil) h.eurFoil = eurFoil;
    if (usdFoil) h.usdFoil = usdFoil;
    const monthly = cleanMonthly(res.monthly);
    if (monthly) h.monthly = monthly;
    return h;
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
