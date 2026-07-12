import type { PriceHistory } from '@mtg/shared';

// Pure analysis over recorded PriceHistory rows: which cards moved
// substantially in a recent window, and which drift steadily over time.
// Kept free of db/UI imports like history.ts so it stays trivially testable.

/**
 * Substantiality is a linear trade-off between absolute and relative change,
 * so both ends of the price range can qualify: a cheap card needs a big
 * percentage move, an expensive card only a big absolute one, and mid-range
 * cards can combine the two. A move is substantial when
 *
 *   |Δ| / ABS_REF + |Δ%| / PCT_REF ≥ 1
 *
 * i.e. ±ABS_REF alone qualifies, ±PCT_REF% alone qualifies, and e.g. half of
 * each together also qualifies. NOISE_FLOOR kills the penny cards whose ±100%
 * is a 10-cent blip. The same left-hand sum doubles as the ranking score.
 */
const ABS_REF = 5; // currency units (≈€5 counts by itself)
const PCT_REF = 25; // percent (±25% counts by itself)
const NOISE_FLOOR = 0.25; // |Δ| below this never qualifies, whatever the %

// A trend is "steady" when the day-by-day readings correlate strongly with
// time (Pearson r on day-index vs price), not just when the endpoints differ —
// a spike-and-crash has the same endpoints as a slow climb but a low |r|.
const TREND_MIN_POINTS = 5;
const TREND_MIN_SPAN_DAYS = 5;
const TREND_MIN_R = 0.8;
const TREND_MIN_PCT = 5; // ignore steady-but-flat drifts of under ±5% total

export interface MoverStats {
  cur: 'eur' | 'usd';
  /** Latest recorded price, currency units. */
  current: number;
  /** The reading the window change is measured against. */
  baseline: number;
  /** current − baseline. */
  delta: number;
  /** Percent vs baseline; null when baseline was 0. */
  pct: number | null;
  /** Actual days between the baseline and latest readings. */
  spanDays: number;
  /** Non-null readings inside the window, chronological (sparkline input). */
  series: number[];
  /** |Δ|/ABS_REF + |Δ%|/PCT_REF — ranking score; ≥ 1 means substantial. */
  score: number;
  substantial: boolean;
  /** Steady drift over the whole recorded history, when there is one. */
  trend: 'rising' | 'falling' | null;
  /** |Pearson r| of the trend fit; null without enough data. */
  trendR: number | null;
}

/** Window used for the mover badges shown in card lists. */
export const BADGE_WINDOW_DAYS = 7;

/**
 * Direction for the corner badge in card lists: a substantial move within the
 * last BADGE_WINDOW_DAYS wins, else a steady long-term drift, else nothing.
 */
export function moverFlag(h: PriceHistory): 'up' | 'down' | null {
  const s = moverStats(h, BADGE_WINDOW_DAYS);
  if (!s) return null;
  if (s.substantial) return s.delta > 0 ? 'up' : 'down';
  if (s.trend) return s.trend === 'rising' ? 'up' : 'down';
  return null;
}

/** (dayIndex, price) pairs of one currency's non-null readings. */
function points(h: PriceHistory, cur: 'eur' | 'usd'): [number, number][] {
  const out: [number, number][] = [];
  h[cur].forEach((v, i) => {
    if (v != null) out.push([i, v / 100]);
  });
  return out;
}

/** The currency of the latest reading, EUR preferred (matches historyChange). */
function pickCurrency(h: PriceHistory): 'eur' | 'usd' | null {
  for (let i = h.eur.length - 1; i >= 0; i--) {
    if (h.eur[i] != null) return 'eur';
    if (h.usd[i] != null) return 'usd';
  }
  return null;
}

/** Pearson correlation of day-index vs price; null when degenerate. */
function pearson(pts: [number, number][]): number | null {
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null; // vertical / perfectly flat
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Movement stats for one history: change over the last `windowDays` days
 * (baseline = the closest reading at or before the window start, so gaps
 * don't hide a move; falls back to the first reading when the history is
 * younger than the window) plus a steady-trend fit over the full history.
 * `windowDays` = Infinity measures since tracking began. Null when fewer
 * than two readings exist — no movement can be read off one point.
 */
export function moverStats(h: PriceHistory, windowDays: number): MoverStats | null {
  const cur = pickCurrency(h);
  if (!cur) return null;
  const pts = points(h, cur);
  if (pts.length < 2) return null;

  const [curDay, current] = pts[pts.length - 1]!;
  const windowStart = Number.isFinite(windowDays) ? curDay - windowDays : 0;
  let base = pts[0]!;
  for (const p of pts) {
    if (p[0] > windowStart) break;
    base = p;
  }
  const [baseDay, baseline] = base;
  if (baseDay === curDay) return null;

  const delta = current - baseline;
  const pct = baseline ? (delta / baseline) * 100 : null;
  const score = Math.abs(delta) / ABS_REF + (pct != null ? Math.abs(pct) / PCT_REF : 0);
  const substantial = Math.abs(delta) >= NOISE_FLOOR && score >= 1;

  // Steady trend over everything recorded, not just the window.
  let trend: MoverStats['trend'] = null;
  let trendR: number | null = null;
  const [firstDay, first] = pts[0]!;
  const totalPct = first ? (Math.abs(current - first) / first) * 100 : Infinity;
  if (pts.length >= TREND_MIN_POINTS && curDay - firstDay >= TREND_MIN_SPAN_DAYS) {
    const r = pearson(pts);
    if (r != null) {
      trendR = Math.abs(r);
      if (trendR >= TREND_MIN_R && Math.abs(current - first) >= NOISE_FLOOR && totalPct >= TREND_MIN_PCT) {
        trend = r > 0 ? 'rising' : 'falling';
      }
    }
  }

  return {
    cur,
    current,
    baseline,
    delta,
    pct,
    spanDays: curDay - baseDay,
    series: pts.filter(([d]) => d >= baseDay).map(([, v]) => v),
    score,
    substantial,
    trend,
    trendR,
  };
}
