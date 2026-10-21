import type { MonthlyReadings, PriceHistory } from '@mtg/shared';
import { accountsEnabled } from '../account/config.js';
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
  if (!accountsEnabled()) return null;
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

// Printings whose server row was already merged in today, as the merge itself
// (so a second sheet opening mid-request shares it). The server archive moves
// once a day, so a second look at the same card skips the round trip, and the
// write that would re-fire every live query over priceHistories.
const mergedToday = new Map<string, { day: string; settled: boolean; merged: Promise<PriceHistory | undefined> }>();

const sameLane = (a: (number | null)[] | undefined, b: (number | null)[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

/** True when `b` holds exactly the readings `a` does. */
function sameHistory(a: PriceHistory, b: PriceHistory): boolean {
  return (
    a.startDay === b.startDay &&
    (['eur', 'usd', 'eurFoil', 'usdFoil'] as const).every((k) => sameLane(a[k], b[k])) &&
    a.monthly?.startMonth === b.monthly?.startMonth &&
    (['eur', 'usd', 'eurFoil', 'usdFoil'] as const).every((k) => sameLane(a.monthly?.[k], b.monthly?.[k]))
  );
}

/**
 * Local + server history for a printing, merged (device readings win ties).
 * When server data adds anything, the merged row is cached back into Dexie for
 * offline use — for untracked cards the next tracking sweep drops it again,
 * which is fine: it re-fetches whenever the card is viewed online. Pass the
 * local row when the caller already read it.
 */
export async function getMergedPriceHistory(
  scryfallId: string,
  localRead?: Promise<PriceHistory | undefined>,
): Promise<PriceHistory | undefined> {
  const day = todayKey();
  const done = mergedToday.get(scryfallId);
  if (done?.day === day) {
    // Still in flight: share it. Settled: the merged row is in Dexie already.
    if (!done.settled) return done.merged;
    return localRead ?? db.priceHistories.get(scryfallId);
  }
  const localP = localRead ?? db.priceHistories.get(scryfallId);
  const entry = {
    day,
    settled: false,
    merged: mergeServerHistory(scryfallId, localP).catch(() => {
      mergedToday.delete(scryfallId);
      return localP;
    }),
  };
  mergedToday.set(scryfallId, entry);
  void entry.merged.then(() => (entry.settled = true));
  return entry.merged;
}

async function mergeServerHistory(
  scryfallId: string,
  localRead: Promise<PriceHistory | undefined>,
): Promise<PriceHistory | undefined> {
  const [local, server] = await Promise.all([localRead, fetchServerHistory(scryfallId)]);
  // Nothing from the server (offline, signed out): try again on the next look.
  if (!server) {
    mergedToday.delete(scryfallId);
    return local;
  }
  const merged = local ? mergeHistories(server, local) : server;
  if (!local || !sameHistory(local, merged)) await db.priceHistories.put(merged);
  return merged;
}
