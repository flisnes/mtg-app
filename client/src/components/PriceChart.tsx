import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { DAY_MS, type DayReadings, type UserEvent, type UserEventKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrefs, type BaseCurrency } from '../prefs.js';
import { convertToDisplay, fmtMoney } from '../price/rates.js';
import { describeEvent, qtyBadge } from '../history/eventRegistry.js';
import { fmtDate } from '../util/format.js';
import { Icon } from './icons.js';
import { useDismiss } from './useDismiss.js';

// The card sheet's sparkline, opened up: the recorded daily price of one
// printing on real axes, with what *you* did to the card marked on it. Money
// events (bought, sold, traded) get a dot on the line; everything else (deck
// slots, wishlist, tradelist) is a tick in the rug under the plot, so a busy
// deck-shuffling week never buries the two markers that matter.
//
// Everything is drawn in the display currency: readings are stored per day in
// EUR/USD cents (price/history.ts) and acquisition prices in EUR cents, so both
// go through convertToDisplay before they ever share an axis.
//
// Without a card (`oracleId` omitted) the same chart draws a bare price line —
// that's the sealed shelf's use, where a box has no oracleId, no event log and
// so nothing to mark on it.

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

export function PriceChartSheet({
  name,
  subtitle,
  oracleId,
  scryfallId,
  history,
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
    const empty = { markers: [] as Marker[], rug: [] as { day: number; ts: number; events: UserEvent[] }[], earlier: 0, costBasis: null as number | null };
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

    // What the copies on hand cost, per copy — the line to compare "now"
    // against. Acquisition prices are always EUR cents; without a EUR rate we
    // can't put them on a USD-quoted axis, so the line just doesn't draw.
    let paid = 0;
    let copies = 0;
    for (const e of scoped) {
      if (e.kind !== 'collection.add' || e.priceEurCents == null) continue;
      const qty = e.qty ?? 1;
      paid += (e.priceEurCents / 100) * qty;
      copies += qty;
    }
    const costBasis = copies > 0 && series.eurRate != null ? (paid / copies) * series.eurRate : null;

    return {
      markers: [...byMajor.values()].sort((a, b) => a.ts - b.ts),
      rug: [...byRug.values()].sort((a, b) => a.ts - b.ts),
      earlier,
      costBasis,
    };
  }, [series, events, scryfallId]);

  const money = (v: number) => fmtMoney(v, series?.unit ?? 'EUR');

  const geom = useMemo(() => {
    if (!series || !width) return null;
    const W = Math.max(MIN_W, width);
    const plotW = W - PAD.l - PAD.r;
    const { pts } = series;
    const t0 = pts[0]!.ts;
    const t1 = pts[pts.length - 1]!.ts;
    const span = t1 - t0 || DAY_MS;

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (marks.costBasis != null) {
      lo = Math.min(lo, marks.costBasis);
      hi = Math.max(hi, marks.costBasis);
    }
    // A flat line still needs a band to sit in; otherwise leave air above and
    // below so the extremes aren't glued to the frame.
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    const yMin = lo - pad;
    const yMax = hi + pad;

    const x = (ts: number) => PAD.l + ((ts - t0) / span) * plotW;
    const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * PLOT_H;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const area = `${line} L${x(t1).toFixed(1)},${(PAD.t + PLOT_H).toFixed(1)} L${x(t0).toFixed(1)},${(PAD.t + PLOT_H).toFixed(1)} Z`;

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

    return { W, x, y, line, area, t0, t1, span, plotW, yTicks: niceTicks(yMin, yMax, 4), xTicks, days };
  }, [series, width, marks.costBasis]);

  /** Nearest reading to a client x within the plot, for scrub and keyboard. */
  function pick(clientX: number, el: SVGSVGElement) {
    if (!series || !geom) return;
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

  const pts = series?.pts ?? [];
  const latest = pts[pts.length - 1];
  const firstPt = pts[0];
  const focus = cursor != null ? pts[cursor] : undefined;
  const lo = pts.length ? pts.reduce((a, p) => (p.v < a.v ? p : a)) : undefined;
  const hi = pts.length ? pts.reduce((a, p) => (p.v > a.v ? p : a)) : undefined;
  const change = firstPt && latest ? latest.v - firstPt.v : 0;
  const dir = change > 0.005 ? 'up' : change < -0.005 ? 'down' : 'flat';
  const pct = firstPt?.v ? (change / firstPt.v) * 100 : null;

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

        {latest && (
          <div className="price-chart-hero">
            <div className="price-chart-now">{money(latest.v)}</div>
            <div className={`price-change price-${dir}`}>
              {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {money(Math.abs(change))}
              {pct != null && ` (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`}
              <span className="fine-print"> since {fmtDate(firstPt!.ts)}</span>
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
              onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
              onPointerMove={(e) => {
                if (e.buttons || e.pointerType === 'mouse') pick(e.clientX, e.currentTarget);
              }}
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
              </defs>

              {geom.yTicks.map((v) => (
                <g key={v}>
                  <line className="pc-grid" x1={PAD.l} y1={geom.y(v)} x2={geom.W - PAD.r} y2={geom.y(v)} />
                  <text className="pc-tick" x={PAD.l - 8} y={geom.y(v)} textAnchor="end" dominantBaseline="middle">
                    {money(v)}
                  </text>
                </g>
              ))}

              <path className="pc-area" d={geom.area} fill="url(#price-chart-fill)" />
              <path className="pc-line" d={geom.line} />

              {/* What you paid per copy — the line the current price is worth
                  comparing against. Dashed so it never reads as a gridline. */}
              {marks.costBasis != null && (
                <g>
                  <line className="pc-basis" x1={PAD.l} y1={geom.y(marks.costBasis)} x2={geom.W - PAD.r} y2={geom.y(marks.costBasis)} />
                  <text className="pc-basis-label" x={geom.W - PAD.r} y={geom.y(marks.costBasis) - 5} textAnchor="end">
                    paid {money(marks.costBasis)}
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

              {/* Where the line stops is today's price — it needs an end, or
                  the stroke just runs out at the frame. */}
              <circle className="pc-end" cx={geom.x(latest!.ts)} cy={geom.y(latest!.v)} r={4} />

              {focus && (
                <g className="pc-cursor">
                  <line x1={geom.x(focus.ts)} y1={PAD.t} x2={geom.x(focus.ts)} y2={PAD.t + PLOT_H} />
                  <circle cx={geom.x(focus.ts)} cy={geom.y(focus.v)} r={4} />
                </g>
              )}

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
            </svg>
          ) : (
            <p className="fine-print">Not enough readings yet to draw a chart.</p>
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
              <span className="fine-print">Tracked</span>
              <strong>{(geom?.days ?? 0) + 1} days</strong>
              <span className="fine-print">{pts.length} readings</span>
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
