import type { PriceHistory } from '@mtg/shared';

// Pure analysis over recorded PriceHistory rows: which cards moved
// substantially in a recent window, and which drift steadily over time.
// Kept free of db/UI imports like history.ts so it stays trivially testable.

/**
 * Every threshold the three detectors use, in one bag so the Price movers page
 * can hand the user a tuned copy (see price/moverTuning.ts). Defaults are
 * DEFAULT_TUNING; nothing here reads storage, so this module stays pure.
 *
 * Substantiality is a linear trade-off between absolute and relative change,
 * so both ends of the price range can qualify: a cheap card needs a big
 * percentage move, an expensive card only a big absolute one, and mid-range
 * cards can combine the two. A move is substantial when
 *
 *   |Δ| / absRef + |Δ%| / pctRef ≥ 1
 *
 * i.e. ±absRef alone qualifies, ±pctRef% alone qualifies, and e.g. half of
 * each together also qualifies. noiseFloor kills the penny cards whose ±100%
 * is a 10-cent blip. The same left-hand sum doubles as the ranking score.
 *
 * A trend is "steady" when the day-by-day readings correlate strongly with
 * time (Pearson r on day-index vs price), not just when the endpoints differ —
 * a spike-and-crash has the same endpoints as a slow climb but a low |r|.
 */
export interface MoverTuning {
  /** Absolute change that counts on its own, in the card's own currency. */
  absRef: number;
  /** Percentage change that counts on its own. */
  pctRef: number;
  /** |Δ| below this never qualifies, whatever the %. */
  noiseFloor: number;
  trendMinPoints: number;
  trendMinSpanDays: number;
  /** Minimum |Pearson r| for a drift to read as steady. */
  trendMinR: number;
  /** Ignore steady-but-flat drifts smaller than this, in percent. */
  trendMinPct: number;
  swingMinPoints: number;
  swingMinSpanDays: number;
  /** Fraction of the range's height that counts as "at the edge". */
  swingEdgeBand: number;
}

export const DEFAULT_TUNING: MoverTuning = {
  absRef: 5, // currency units (≈€5 counts by itself)
  pctRef: 25, // percent (±25% counts by itself)
  noiseFloor: 0.25,
  trendMinPoints: 5,
  trendMinSpanDays: 5,
  trendMinR: 0.8,
  trendMinPct: 5,
  swingMinPoints: 7,
  swingMinSpanDays: 10,
  swingEdgeBand: 0.2, // within 20% of the range's height from an edge
};

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

/**
 * A card "swings" when its full recorded history oscillates inside a range —
 * it must cross the range midline at least twice, so a one-way drift (which
 * crosses exactly once) never counts — and the range height passes the same
 * substantiality trade-off as window moves. It sits at a dip/spike when the
 * latest reading lands in the bottom/top band of that range.
 */
const SWING_MIN_CROSSINGS = 2; // structural, not a dial: fewer isn't a swing

export interface SwingStats {
  cur: 'eur' | 'usd';
  /** Latest recorded price, currency units. */
  current: number;
  /** Lowest / highest readings over the whole history. */
  low: number;
  high: number;
  kind: 'dip' | 'spike';
  /** Days between the first and latest readings. */
  spanDays: number;
  /** All non-null readings, chronological (sparkline input). */
  series: number[];
  /** Range height run through the substantiality formula — ranking score. */
  score: number;
}

/**
 * Dip/spike detection over the full recorded history. Null when the history
 * is too short, doesn't oscillate, the range is trivial, or the current price
 * sits in the middle of it.
 */
export function swingStats(h: PriceHistory, tuning: MoverTuning = DEFAULT_TUNING): SwingStats | null {
  const cur = pickCurrency(h);
  if (!cur) return null;
  const pts = points(h, cur);
  if (pts.length < tuning.swingMinPoints) return null;
  const [firstDay] = pts[0]!;
  const [curDay, current] = pts[pts.length - 1]!;
  if (curDay - firstDay < tuning.swingMinSpanDays) return null;

  let low = Infinity;
  let high = -Infinity;
  for (const [, v] of pts) {
    if (v < low) low = v;
    if (v > high) high = v;
  }
  const range = high - low;
  const rangePct = low > 0 ? (range / low) * 100 : null;
  const score = range / tuning.absRef + (rangePct != null ? rangePct / tuning.pctRef : 0);
  if (range < tuning.noiseFloor || score < 1) return null;

  const mid = (low + high) / 2;
  let side = 0; // -1 below the midline, 1 above
  let crossings = 0;
  for (const [, v] of pts) {
    const s = v > mid ? 1 : v < mid ? -1 : side;
    if (s !== 0 && side !== 0 && s !== side) crossings++;
    if (s !== 0) side = s;
  }
  if (crossings < SWING_MIN_CROSSINGS) return null;

  const band = range * tuning.swingEdgeBand;
  const kind: SwingStats['kind'] | null =
    current <= low + band ? 'dip' : current >= high - band ? 'spike' : null;
  if (!kind) return null;

  return {
    cur,
    current,
    low,
    high,
    kind,
    spanDays: curDay - firstDay,
    series: pts.map(([, v]) => v),
    score,
  };
}

/** Window used for the mover badges shown in card lists. */
export const BADGE_WINDOW_DAYS = 7;

/**
 * Direction for the corner badge in card lists: a substantial move within the
 * last BADGE_WINDOW_DAYS wins, else a steady long-term drift, else nothing.
 */
export function moverFlag(h: PriceHistory, tuning: MoverTuning = DEFAULT_TUNING): 'up' | 'down' | null {
  const s = moverStats(h, BADGE_WINDOW_DAYS, tuning);
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
export function moverStats(
  h: PriceHistory,
  windowDays: number,
  tuning: MoverTuning = DEFAULT_TUNING,
): MoverStats | null {
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
  const score = Math.abs(delta) / tuning.absRef + (pct != null ? Math.abs(pct) / tuning.pctRef : 0);
  const substantial = Math.abs(delta) >= tuning.noiseFloor && score >= 1;

  // Steady trend over everything recorded, not just the window.
  let trend: MoverStats['trend'] = null;
  let trendR: number | null = null;
  const [firstDay, first] = pts[0]!;
  const totalPct = first ? (Math.abs(current - first) / first) * 100 : Infinity;
  if (pts.length >= tuning.trendMinPoints && curDay - firstDay >= tuning.trendMinSpanDays) {
    const r = pearson(pts);
    if (r != null) {
      trendR = Math.abs(r);
      if (
        trendR >= tuning.trendMinR &&
        Math.abs(current - first) >= tuning.noiseFloor &&
        totalPct >= tuning.trendMinPct
      ) {
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
