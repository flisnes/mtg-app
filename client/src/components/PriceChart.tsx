import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { DAY_MS, type DayReadings, type Finish, type UserEvent, type UserEventKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrefs, type BaseCurrency } from '../prefs.js';
import { costBasisOf } from '../price/costBasis.js';
import { convertToDisplay, fmtMoney } from '../price/rates.js';
import { describeEvent, qtyBadge } from '../history/eventRegistry.js';
import { fmtDate } from '../util/format.js';
import { Icon } from './icons.js';
import { useDismiss } from './useDismiss.js';
import { usePlotZoom } from './usePlotZoom.js';

// The card sheet's sparkline, opened up: the recorded daily price of one
// printing on real axes, with what *you* did to the card marked on it. Money
// events (bought, sold, traded) get a dot on the line; everything else (deck
// slots, wishlist, tradelist) is a tick in the rug under the plot, so a busy
// deck-shuffling week never buries the two markers that matter.
//
// The headline change is measured against what you paid whenever we know it —
// that's the number about your money. Only a card with no recorded acquisition
// price falls back to "since tracking began", which is a fact about our archive.
//
// The line itself is the *nonfoil* price: that's the only series we archive
// daily (see notes/foil-price-tracking.md). So for a foil the hero figure is
// the card's real current price, passed in by the sheet, while the line below
// it charts the plain version's movement — and a footnote says so, because a
// foil's line and a foil's price are two different things and passing one off
// as the other is how you end up trusting a number you shouldn't.
//
// Everything is drawn in the display currency: readings are stored per day in
// EUR/USD cents (price/history.ts) and acquisition prices in EUR cents, so both
// go through convertToDisplay before they ever share an axis.
//
// Without a card (`oracleId` omitted) the same chart draws a bare price line —
// that's the sealed shelf's use, where a box has no oracleId, no event log and
// so nothing to mark on it.

/** How a finish reads in a sentence. */
const FINISH_WORD: Record<Finish, string> = { nonfoil: 'nonfoil', foil: 'foil', etched: 'etched foil' };

/** Events that moved money, and so earn a marker on the line itself. */
const MAJOR: ReadonlySet<UserEventKind> = new Set<UserEventKind>(['collection.add', 'collection.remove']);

const PLOT_H = 210;
const PAD = { t: 14, r: 16, b: 54, l: 56 };
const H = PAD.t + PLOT_H + PAD.b;
const RUG_TOP = PAD.t + PLOT_H + 8;
const RUG_H = 8;
const X_LABEL_Y = H - 12;
const MIN_W = 240;

interface Pt {
  /** UTC midnight of the reading's day. */
  ts: number;
  /** Price that day, in display-currency units. */
  v: number;
  /** Whole UTC days since the epoch — the key events are matched on. */
  day: number;
}

/** A day's worth of money events, collapsed into one marker. */
interface Marker {
  day: number;
  ts: number;
  dir: 'in' | 'out';
  events: UserEvent[];
}

/** Round tick values covering [min, max] — at most `count`+1 of them. */
export function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const mag = Math.pow(10, Math.floor(Math.log10(span / count)));
  const norm = span / count / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(v);
  return out;
}

/** How to read a zoomable plot, said once under every one of them. */
export function ZoomHint() {
  return <p className="fine-print pc-hint">Scroll or pinch to zoom, drag to pan, double-tap to reset.</p>;
}

export function PriceChartSheet({
  name,
  subtitle,
  oracleId,
  scryfallId,
  history,
  finish,
  now,
  onEventClick,
  onClose,
}: {
  name: string;
  /** Which printing this is — set name, collector number, that sort of thing. */
  subtitle?: string;
  /** Omit for a line with no history to mark on it (a sealed product). */
  oracleId?: string;
  /** The shown printing; the timeline scopes to it plus printing-agnostic events. */
  scryfallId?: string;
  history: DayReadings;
  /** Finish on show, which decides which acquisitions the basis counts. */
  finish?: Finish;
  /**
   * What a copy of that finish is worth right now. The tracked line is nonfoil,
   * so this is what the headline change measures to; omit it (the sealed shelf)
   * and the line's last reading stands in.
   */
  now?: { amount: number; currency: BaseCurrency } | null;
  /** Tapping a marker opens that event (the card sheet's own event modal). */
  onEventClick?: (e: UserEvent) => void;
  onClose: () => void;
}) {
  useDismiss(onClose);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  /** Index into `pts` the crosshair is parked on; null when nothing is picked. */
  const [cursor, setCursor] = useState<number | null>(null);

  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (w && w !== prev ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const events = useLiveQuery(
    async () => (oracleId ? db.events.where('oracleId').equals(oracleId).toArray() : []),
    [oracleId],
  );

  // The series, in display-currency units. Whichever currency the *latest*
  // reading has wins the whole line (same rule as the sparkline's).
  const series = useMemo(() => {
    let cur: 'eur' | 'usd' | null = null;
    for (let i = history.eur.length - 1; i >= 0 && !cur; i--) {
      if (history.eur[i] != null) cur = 'eur';
      else if (history.usd[i] != null) cur = 'usd';
    }
    if (!cur) return null;
    const from: BaseCurrency = cur === 'eur' ? 'EUR' : 'USD';
    // One rate for the whole chart: null means we're offline of the rates, so
    // the axis stays in the currency the readings were quoted in.
    const rate = convertToDisplay(1, from);
    const unit = rate == null ? from : getPrefs().displayCurrency;
    const startMs = Date.parse(history.startDay);
    const readings = history[cur];
    const pts: Pt[] = [];
    for (let i = 0; i < readings.length; i++) {
      const cents = readings[i];
      if (cents == null) continue;
      const ts = startMs + i * DAY_MS;
      pts.push({ ts, v: (cents / 100) * (rate ?? 1), day: Math.round(ts / DAY_MS) });
    }
    if (pts.length < 2) return null;
    return { pts, unit, eurRate: rate == null ? null : convertToDisplay(1, 'EUR') };
  }, [history]);

  // What happened to this printing, split into line markers and rug ticks.
  const marks = useMemo(() => {
    const empty = {
      markers: [] as Marker[],
      rug: [] as { day: number; ts: number; events: UserEvent[] }[],
      earlier: 0,
      costBasis: null as number | null,
      basisLine: null as number | null,
      basisEstimated: false,
      basisCrossFinish: false,
    };
    if (!series || !events) return empty;
    const first = series.pts[0]!.day;
    const last = series.pts[series.pts.length - 1]!.day;
    // Printing-agnostic events (any-printing wishes, deck slots) carry no
    // edition, so they belong to every edition's chart.
    const scoped = events.filter((e) => !e.scryfallId || e.scryfallId === scryfallId);

    const byMajor = new Map<string, Marker>();
    const byRug = new Map<number, { day: number; ts: number; events: UserEvent[] }>();
    let earlier = 0;
    for (const e of scoped) {
      const day = Math.floor(e.ts / DAY_MS);
      if (day < first) {
        earlier++;
        continue;
      }
      // A reading is stamped at UTC midnight, so anything later today sits
      // just past the last point — pin it there rather than dropping it.
      const clamped = Math.min(day, last);
      const ts = clamped * DAY_MS;
      if (MAJOR.has(e.kind)) {
        const dir = e.kind === 'collection.add' ? 'in' : 'out';
        const key = `${clamped}:${dir}`;
        const hit = byMajor.get(key);
        if (hit) hit.events.push(e);
        else byMajor.set(key, { day: clamped, ts, dir, events: [e] });
      } else {
        const hit = byRug.get(clamped);
        if (hit) hit.events.push(e);
        else byRug.set(clamped, { day: clamped, ts, events: [e] });
      }
    }

    // What the copies on hand cost, per copy — the line the current price is
    // measured against. The history goes in so a copy with no recorded price is
    // valued from the reading nearest the day it went in, the same ladder the
    // sheet's figure climbs; otherwise the sheet could report a gain over a
    // basis this chart declined to draw. Acquisition prices are always EUR
    // cents; without a EUR rate we can't put them on a USD-quoted axis, so the
    // line just doesn't draw.
    const basis = costBasisOf(scoped, scryfallId, history, finish);
    const costBasis = basis && series.eurRate != null ? basis.perCopy * series.eurRate : null;

    return {
      markers: [...byMajor.values()].sort((a, b) => a.ts - b.ts),
      rug: [...byRug.values()].sort((a, b) => a.ts - b.ts),
      earlier,
      costBasis,
      // What you paid for a foil doesn't belong on a nonfoil axis: the gap
      // between the two is a difference of finish, not a gain, and drawing it
      // squashes the line it's supposed to be compared against. The figure
      // still leads the sheet, with the footnote to explain it.
      basisLine: !finish || finish === 'nonfoil' ? costBasis : null,
      basisEstimated: !!basis?.estimated,
      basisCrossFinish: !!basis?.crossFinish,
    };
  }, [series, events, scryfallId, history, finish]);

  const money = (v: number) => fmtMoney(v, series?.unit ?? 'EUR');
  const isFoil = !!finish && finish !== 'nonfoil';
  // A basis can read as cross-finish without a finish prop (the copies carry
  // their own), so "foil" is the honest default word for it.
  const finishWord = isFoil ? FINISH_WORD[finish!] : 'foil';

  const pts = series?.pts ?? [];
  const W = width ? Math.max(MIN_W, width) : 0;
  const zoom = usePlotZoom({
    points: pts.length,
    padL: PAD.l,
    padR: PAD.r,
    viewW: W,
    hoverScrub: true,
    onTap: (x) => pick(x),
    onHover: (x) => pick(x),
  });

  const geom = useMemo(() => {
    if (!series || !W) return null;
    const plotW = W - PAD.l - PAD.r;
    const all = series.pts;
    const tA = all[0]!.ts;
    const full = all[all.length - 1]!.ts - tA || DAY_MS;
    const t0 = tA + zoom.lo * full;
    const t1 = tA + zoom.hi * full;
    const span = t1 - t0 || DAY_MS;

    // The readings in view, plus the one just outside each edge so the line
    // enters and leaves the frame rather than stopping short of it.
    let from = 0;
    while (from < all.length - 1 && all[from + 1]!.ts <= t0) from++;
    let to = all.length - 1;
    while (to > from && all[to - 1]!.ts >= t1) to--;
    const vis = all.slice(from, to + 1);

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of vis) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    // The full view always makes room for the paid line — it's the comparison
    // the chart is for. Zoomed in, the detail wins and the line can fall off.
    if (marks.basisLine != null && !zoom.zoomed) {
      lo = Math.min(lo, marks.basisLine);
      hi = Math.max(hi, marks.basisLine);
    }
    // A flat line still needs a band to sit in; otherwise leave air above and
    // below so the extremes aren't glued to the frame.
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    const yMin = lo - pad;
    const yMax = hi + pad;

    const x = (ts: number) => PAD.l + ((ts - t0) / span) * plotW;
    const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * PLOT_H;

    const line = vis.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const base = (PAD.t + PLOT_H).toFixed(1);
    const area = `${line} L${x(vis[vis.length - 1]!.ts).toFixed(1)},${base} L${x(vis[0]!.ts).toFixed(1)},${base} Z`;

    const days = Math.round(span / DAY_MS);
    const dateFmt = new Intl.DateTimeFormat(undefined, days > 300 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
    const xTickCount = Math.max(2, Math.min(5, Math.floor(plotW / 78)));
    const xTicks: { ts: number; label: string }[] = [];
    for (let i = 0; i < xTickCount; i++) {
      const ts = t0 + (span * i) / (xTickCount - 1);
      const label = dateFmt.format(new Date(ts));
      if (xTicks.some((t) => t.label === label)) continue;
      xTicks.push({ ts, label });
    }

    return { W, x, y, line, area, t0, t1, span, plotW, yTicks: niceTicks(yMin, yMax, 4), xTicks, days, vis };
  }, [series, W, marks.basisLine, zoom.lo, zoom.hi, zoom.zoomed]);

  /** Nearest reading to a client x within the plot, for scrub and keyboard. */
  function pick(clientX: number) {
    if (!series || !geom) return;
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) * geom.W) / (rect.width || geom.W);
    const ts = geom.t0 + ((px - PAD.l) / geom.plotW) * geom.span;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < series.pts.length; i++) {
      const d = Math.abs(series.pts[i]!.ts - ts);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setCursor(best);
  }

  const latest = pts[pts.length - 1];
  const firstPt = pts[0];
  // Today's price for the finish on show, in the unit the axis is drawn in.
  // Null when the two can't be reconciled (a USD-quoted line, a EUR-quoted
  // foil and no rate to hand), and then the line's own last reading stands in.
  const nowV = useMemo(() => {
    if (!now || !series) return null;
    if (series.unit === getPrefs().displayCurrency) {
      const v = convertToDisplay(now.amount, now.currency);
      if (v != null) return v;
    }
    return series.unit === now.currency ? now.amount : null;
  }, [now, series]);
  const heroV = nowV ?? latest?.v ?? null;
  const picked = cursor != null ? pts[cursor] : undefined;
  // A zoom can leave the crosshair off-frame; it belongs to the view, not the
  // whole series.
  const focus = picked && geom && picked.ts >= geom.t0 && picked.ts <= geom.t1 ? picked : undefined;
  // The readout follows the window: zooming into August is asking what August did.
  const shown = geom?.vis ?? pts;
  const lo = shown.length ? shown.reduce((a, p) => (p.v < a.v ? p : a)) : undefined;
  const hi = shown.length ? shown.reduce((a, p) => (p.v > a.v ? p : a)) : undefined;
  // "Since tracking began" is only the headline when nothing was paid on record.
  const change = firstPt && latest ? latest.v - firstPt.v : 0;
  const gain =
    marks.costBasis != null && heroV != null
      ? { paid: marks.costBasis, delta: heroV - marks.costBasis, pct: marks.costBasis ? ((heroV - marks.costBasis) / marks.costBasis) * 100 : null }
      : null;
  const headline = gain ? gain.delta : change;
  const headlinePct = gain ? gain.pct : firstPt?.v ? (change / firstPt.v) * 100 : null;
  const dir = headline > 0.005 ? 'up' : headline < -0.005 ? 'down' : 'flat';

  /** Events sitting on the focused day, for the tooltip. */
  const focusEvents = useMemo(() => {
    if (!focus) return [];
    const rug = marks.rug.find((r) => r.day === focus.day)?.events ?? [];
    const major = marks.markers.filter((m) => m.day === focus.day).flatMap((m) => m.events);
    return [...major, ...rug];
  }, [focus, marks]);

  return createPortal(
    // Nested inside the card sheet's own backdrop, whose click handler would
    // otherwise close the sheet underneath this one too.
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="sheet price-chart-sheet" role="dialog" aria-label={`Price history of ${name}`} onClick={(e) => e.stopPropagation()}>
        <div className="edition-picker-head">
          <div className="price-chart-titles">
            <h2>{name}</h2>
            {subtitle && <div className="fine-print">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {latest && heroV != null && (
          <div className="price-chart-hero">
            <div className="price-chart-now">{money(heroV)}</div>
            <div className={`price-change price-${dir}`}>
              {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {money(Math.abs(headline))}
              {headlinePct != null && ` (${headlinePct >= 0 ? '+' : '−'}${Math.abs(headlinePct).toFixed(1)}%)`}
              <span className="fine-print">
                {' '}
                {gain
                  ? marks.basisEstimated || marks.basisCrossFinish
                    ? `over an estimated ${money(gain.paid)}`
                    : `on the ${money(gain.paid)} you paid`
                  : `since ${fmtDate(firstPt!.ts)}`}
              </span>
            </div>
          </div>
        )}

        <div className="price-chart-plot" ref={plotRef}>
          {series && geom ? (
            <svg
              className="price-chart-svg"
              width={geom.W}
              height={H}
              viewBox={`0 0 ${geom.W} ${H}`}
              tabIndex={0}
              role="img"
              aria-label={`Price from ${fmtDate(geom.t0)} to ${fmtDate(geom.t1)}, ${money(firstPt!.v)} to ${money(latest!.v)}`}
              {...zoom.bind}
              onPointerLeave={() => setCursor(null)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const step = e.key === 'ArrowRight' ? 1 : -1;
                setCursor((c) => Math.max(0, Math.min(pts.length - 1, (c ?? pts.length - 1) + step)));
              }}
            >
              <defs>
                <linearGradient id="price-chart-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
                </linearGradient>
                {/* Zoomed in, the line runs past both edges — this is what keeps
                    it (and its markers) from spilling over the axis labels. */}
                <clipPath id="price-chart-clip">
                  <rect x={PAD.l - 1} y={0} width={geom.plotW + 2} height={H} />
                </clipPath>
              </defs>

              {geom.yTicks.map((v) => (
                <g key={v}>
                  <line className="pc-grid" x1={PAD.l} y1={geom.y(v)} x2={geom.W - PAD.r} y2={geom.y(v)} />
                  <text className="pc-tick" x={PAD.l - 8} y={geom.y(v)} textAnchor="end" dominantBaseline="middle">
                    {money(v)}
                  </text>
                </g>
              ))}

              <g clipPath="url(#price-chart-clip)">
                <path className="pc-area" d={geom.area} fill="url(#price-chart-fill)" />
                <path className="pc-line" d={geom.line} />

                {/* What you paid per copy — the line the current price is worth
                    comparing against. Dashed so it never reads as a gridline. */}
                {marks.basisLine != null && (
                  <g>
                    <line className="pc-basis" x1={PAD.l} y1={geom.y(marks.basisLine)} x2={geom.W - PAD.r} y2={geom.y(marks.basisLine)} />
                    <text className="pc-basis-label" x={geom.W - PAD.r} y={geom.y(marks.basisLine) - 5} textAnchor="end">
                      paid {money(marks.basisLine)}
                    </text>
                  </g>
                )}

                {/* Deck, wishlist and tradelist activity: a tick each, under the
                    plot, where it can't compete with the money markers. */}
                {marks.rug.map((r) => (
                  <g key={`rug-${r.day}`} className="pc-rug" onPointerDown={(e) => e.stopPropagation()} onClick={() => onEventClick?.(r.events[0]!)}>
                    <title>{`${fmtDate(r.ts)}: ${r.events.map((e) => describeEvent(e).verb).join(', ')}`}</title>
                    <rect className="pc-hit" x={geom.x(r.ts) - 9} y={RUG_TOP - 6} width={18} height={RUG_H + 12} />
                    <line x1={geom.x(r.ts)} y1={RUG_TOP} x2={geom.x(r.ts)} y2={RUG_TOP + RUG_H} />
                  </g>
                ))}

                {focus && (
                  <g className="pc-cursor">
                    <line x1={geom.x(focus.ts)} y1={PAD.t} x2={geom.x(focus.ts)} y2={PAD.t + PLOT_H} />
                    <circle cx={geom.x(focus.ts)} cy={geom.y(focus.v)} r={4} />
                  </g>
                )}

                {/* Where the line stops is today's price — it needs an end, or
                    the stroke just runs out at the frame. */}
                <circle className="pc-end" cx={geom.x(latest!.ts)} cy={geom.y(latest!.v)} r={4} />

                {/* Bought, sold, traded: a dot on the line itself. */}
                {marks.markers.map((m) => {
                  const p = pts.reduce((a, b) => (Math.abs(b.day - m.day) < Math.abs(a.day - m.day) ? b : a));
                  return (
                    <g
                      key={`${m.day}-${m.dir}`}
                      className={`pc-mark pc-mark-${m.dir}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onEventClick?.(m.events[0]!)}
                    >
                      <title>{`${fmtDate(m.ts)}: ${m.events.map((e) => describeEvent(e).verb).join(', ')}`}</title>
                      <circle className="pc-hit" cx={geom.x(m.ts)} cy={geom.y(p.v)} r={14} />
                      <circle cx={geom.x(m.ts)} cy={geom.y(p.v)} r={5} />
                    </g>
                  );
                })}
              </g>

              <line className="pc-grid" x1={PAD.l} y1={PAD.t + PLOT_H} x2={geom.W - PAD.r} y2={PAD.t + PLOT_H} />

              {geom.xTicks.map((t) => (
                <text
                  key={t.label}
                  className="pc-tick"
                  x={Math.min(Math.max(geom.x(t.ts), PAD.l + 14), geom.W - PAD.r - 14)}
                  y={X_LABEL_Y}
                  textAnchor="middle"
                >
                  {t.label}
                </text>
              ))}
            </svg>
          ) : (
            <p className="fine-print">Not enough readings yet to draw a chart.</p>
          )}

          {zoom.zoomed && (
            <button type="button" className="pc-reset" onClick={zoom.reset}>
              Reset zoom
            </button>
          )}

          {focus && geom && (
            <div
              className="pc-tooltip"
              style={{
                left: Math.min(Math.max(geom.x(focus.ts) - 70, 4), Math.max(4, geom.W - 148)),
                // Park the card opposite the point so it never covers it.
                top: geom.y(focus.v) > PAD.t + PLOT_H / 2 ? PAD.t : PAD.t + PLOT_H - 84,
              }}
            >
              <div className="pc-tooltip-price">{money(focus.v)}</div>
              <div className="fine-print">{fmtDate(focus.ts)}</div>
              {focusEvents.slice(0, 3).map((e) => (
                <div key={e.id} className="pc-tooltip-event">
                  <Icon name={describeEvent(e).icon} size={12} />
                  <span>{describeEvent(e).verb}</span>
                  {qtyBadge(e) && <span className="fine-print">{qtyBadge(e)}</span>}
                </div>
              ))}
              {focusEvents.length > 3 && <div className="fine-print">+{focusEvents.length - 3} more</div>}
            </div>
          )}
        </div>

        {series && <ZoomHint />}

        {/* The values you'd otherwise have to hunt for with the crosshair —
            a tooltip should add to a chart, never be the only way to read it. */}
        {lo && hi && (
          <div className="price-chart-readout">
            <div>
              <span className="fine-print">High</span>
              <strong>{money(hi.v)}</strong>
              <span className="fine-print">{fmtDate(hi.ts)}</span>
            </div>
            <div>
              <span className="fine-print">Low</span>
              <strong>{money(lo.v)}</strong>
              <span className="fine-print">{fmtDate(lo.ts)}</span>
            </div>
            <div>
              <span className="fine-print">{zoom.zoomed ? 'Shown' : 'Tracked'}</span>
              <strong>{(geom?.days ?? 0) + 1} days</strong>
              <span className="fine-print">{shown.length} readings</span>
            </div>
          </div>
        )}

        {/* Nothing to explain when there are no marks: a sealed product has no
            event log, so the line is the whole chart. */}
        {oracleId && (
          <div className="price-chart-legend">
            <span>
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" fill="var(--ok)" />
              </svg>
              Acquired
            </span>
            <span>
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" fill="var(--danger)" />
              </svg>
              Sold or traded
            </span>
            <span>
              <svg width="10" height="10" aria-hidden>
                <rect x="4" y="0" width="2" height="10" fill="var(--text-dim)" />
              </svg>
              Decks, wishlist, tradelist
            </span>
          </div>
        )}

        {marks.earlier > 0 && (
          <p className="fine-print">
            {marks.earlier} earlier event{marks.earlier === 1 ? '' : 's'} happened before price tracking began — the History tab has them.
          </p>
        )}

        {/* Say which price the line is. A foil owner reading a nonfoil line as
            their card's history is the whole reason this footnote exists. */}
        {isFoil && (
          <p className="fine-print">
            The line is the nonfoil price. We don't record {finishWord} prices day by day yet, so the figure above the
            chart is today's {finishWord} price and the line shows how the plain version has moved.
          </p>
        )}
        {gain && (marks.basisCrossFinish || marks.basisEstimated) && (
          <p className="fine-print">
            {marks.basisCrossFinish
              ? `The change is measured against an estimated ${money(marks.costBasis!)} per copy, taken from the nonfoil price: we have no ${finishWord} price on record for the day you got it.`
              : `The change is measured against an estimated ${money(marks.costBasis!)} per copy. No price was recorded when you got it, so the reading nearest that day stands in.`}
          </p>
        )}

        <div className="sheet-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
