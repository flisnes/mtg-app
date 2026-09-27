import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { DAY_MS } from '@mtg/shared';
import { usePlotZoom } from './usePlotZoom.js';

// The one price/value line chart, extracted from what used to be three forks of
// the same plot (PriceChart, CollectionValueChart, SealedValueChart). The frame
// — width measuring, zoom/pan, day picking, axes, gradient fill, crosshair —
// lives here once; each chart keeps only its own markers, reference lines and
// readouts, drawn into the plot through `overlay`.
//
// Split as a hook + a component because the callers need the geometry outside
// the SVG too: the readout row ("Tracked N days"), the day list under the
// chart, and the tooltip all follow the zoom window and the picked day.

export interface ChartPt {
  /** UTC midnight of the reading's day. */
  ts: number;
  /** Whole UTC days since the epoch — what events are matched on. */
  day: number;
  /** The value that day, in display-currency units. */
  v: number;
}

export const PLOT_H = 210;
export const CHART_H = 14 + PLOT_H + 54; // PAD.t + plot + PAD.b
const PAD_T = 14;
const PAD_R = 16;
const X_LABEL_Y = CHART_H - 12;
const MIN_W = 240;

export interface LineGeom {
  W: number;
  x: (ts: number) => number;
  y: (v: number) => number;
  line: string;
  area: string;
  zeroY: number;
  t0: number;
  t1: number;
  span: number;
  plotW: number;
  padL: number;
  yTicks: number[];
  xTicks: { ts: number; label: string }[];
  days: number;
  /** The points inside the zoom window (plus one past each edge). */
  vis: ChartPt[];
}

/**
 * Width of the plot container, via ResizeObserver. `resetKey` makes the
 * observer re-attach — pass the series for a plot that only exists once its
 * data has loaded, or on mount there is nothing to observe and the chart
 * would sit at zero width forever.
 */
export function useChartWidth(resetKey?: unknown): { plotRef: RefObject<HTMLDivElement | null>; width: number } {
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (w && w !== prev ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [resetKey]);
  return { plotRef, width };
}

export interface ValueChart {
  plotRef: RefObject<HTMLDivElement | null>;
  geom: LineGeom | null;
  zoom: ReturnType<typeof usePlotZoom>;
  cursor: number | null;
  setCursor: (fn: (c: number | null) => number | null) => void;
  /** The picked point, but only while it sits inside the zoom window. */
  focus: ChartPt | undefined;
  latest: ChartPt | undefined;
  firstPt: ChartPt | undefined;
  pts: ChartPt[];
}

export function useValueChart({
  pts,
  resetKey,
  anchorZero = false,
  includeY = null,
  areaBase = 'bottom',
  padL = 62,
  hoverScrub = false,
  toggleTap = false,
}: {
  pts: ChartPt[];
  /** Re-attach the width observer when this changes (see useChartWidth). */
  resetKey?: unknown;
  /** Keep zero in the unzoomed y-range (a meaningful empty/break-even). */
  anchorZero?: boolean;
  /** Extra value kept in the unzoomed y-range (a cost-basis line). */
  includeY?: number | null;
  /** Where the gradient fill closes: the zero line, or the plot bottom. */
  areaBase?: 'zero' | 'bottom';
  padL?: number;
  hoverScrub?: boolean;
  /** Tapping the already-picked day lets go of it again. */
  toggleTap?: boolean;
}): ValueChart {
  const { plotRef, width } = useChartWidth(resetKey);
  const [cursor, setCursor] = useState<number | null>(null);
  const W = width ? Math.max(MIN_W, width) : 0;

  const zoom = usePlotZoom({
    points: pts.length,
    padL,
    padR: PAD_R,
    viewW: W,
    hoverScrub,
    onTap: (x) => pick(x, toggleTap),
    onHover: (x) => pick(x),
  });

  const geom = useMemo<LineGeom | null>(() => {
    if (!pts.length || !W) return null;
    const plotW = W - padL - PAD_R;
    const tA = pts[0]!.ts;
    const full = pts[pts.length - 1]!.ts - tA || DAY_MS;
    const t0 = tA + zoom.lo * full;
    const t1 = tA + zoom.hi * full;
    const span = t1 - t0 || DAY_MS;

    // The days in view, plus the one just outside each edge so the line enters
    // and leaves the frame rather than stopping short of it.
    let from = 0;
    while (from < pts.length - 1 && pts[from + 1]!.ts <= t0) from++;
    let to = pts.length - 1;
    while (to > from && pts[to - 1]!.ts >= t1) to--;
    const vis = pts.slice(from, to + 1);

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of vis) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    // The full view makes room for the chart's reference values — zero when it
    // means something (an empty pile, break-even), the paid line when there is
    // one. Zoomed in, the detail is the point and either can fall off the axis.
    if (!zoom.zoomed) {
      if (anchorZero) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
      }
      if (includeY != null) {
        lo = Math.min(lo, includeY);
        hi = Math.max(hi, includeY);
      }
    }
    // A flat line still needs a band to sit in; otherwise leave air above and
    // below so the extremes aren't glued to the frame.
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    const yMin = lo - pad;
    const yMax = hi + pad;

    const x = (ts: number) => padL + ((ts - t0) / span) * plotW;
    const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin)) * PLOT_H;

    const line = vis.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const zeroY = y(0);
    const base = (areaBase === 'zero' ? Math.min(Math.max(zeroY, PAD_T), PAD_T + PLOT_H) : PAD_T + PLOT_H).toFixed(1);
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

    return { W, x, y, line, area, zeroY, t0, t1, span, plotW, padL, yTicks: niceTicks(yMin, yMax, 4), xTicks, days, vis };
  }, [pts, W, padL, anchorZero, includeY, areaBase, zoom.lo, zoom.hi, zoom.zoomed]);

  // Ref so zoom's stable callbacks always pick against the current geometry.
  const geomRef = useRef(geom);
  geomRef.current = geom;

  /** Nearest day to a client x within the plot, for scrub and keyboard. */
  function pick(clientX: number, toggle = false) {
    const g = geomRef.current;
    const el = plotRef.current;
    if (!g || !el) return;
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) * g.W) / (rect.width || g.W);
    const ts = g.t0 + ((px - g.padL) / g.plotW) * g.span;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i]!.ts - ts);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setCursor((c) => (toggle && c === best ? null : best));
  }

  const latest = pts[pts.length - 1];
  const firstPt = pts[0];
  const picked = cursor != null ? pts[cursor] : undefined;
  // A zoom can leave the crosshair off-frame; it belongs to the view.
  const focus = picked && geom && picked.ts >= geom.t0 && picked.ts <= geom.t1 ? picked : undefined;

  return { plotRef, geom, zoom, cursor, setCursor, focus, latest, firstPt, pts };
}

/**
 * The plot itself: axes, gradient area, the line, the crosshair and the reset
 * button, inside the `.price-chart-plot` container the hook's ref measures.
 * Chart-specific layers (markers, reference lines) render through `overlay`,
 * clipped to the plot; anything positioned over the plot (a tooltip) through
 * `above`.
 */
export function LinePlot({
  chart,
  idPrefix,
  label,
  money,
  endDotAlways = false,
  clearCursorOnLeave = false,
  overlay,
  above,
}: {
  chart: ValueChart;
  /** Unique per chart — SVG defs are looked up by document-wide id. */
  idPrefix: string;
  label: string;
  money: (v: number) => string;
  /** Keep the line's end dot while a day is picked (the single-card chart). */
  endDotAlways?: boolean;
  clearCursorOnLeave?: boolean;
  overlay?: (geom: LineGeom) => ReactNode;
  above?: (geom: LineGeom) => ReactNode;
}) {
  const { plotRef, geom, zoom, setCursor, focus, latest, pts } = chart;
  return (
    <div className="price-chart-plot" ref={plotRef}>
      {geom && latest && (
        <svg
          className="price-chart-svg"
          width={geom.W}
          height={CHART_H}
          viewBox={`0 0 ${geom.W} ${CHART_H}`}
          tabIndex={0}
          role="img"
          aria-label={label}
          {...zoom.bind}
          onPointerLeave={clearCursorOnLeave ? () => setCursor(() => null) : undefined}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const step = e.key === 'ArrowRight' ? 1 : -1;
            setCursor((c) => Math.max(0, Math.min(pts.length - 1, (c ?? pts.length - 1) + step)));
          }}
        >
          <defs>
            <linearGradient id={`${idPrefix}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            {/* Zoomed in, the line runs past both edges — this is what keeps
                it (and its markers) off the axis labels. */}
            <clipPath id={`${idPrefix}-clip`}>
              <rect x={geom.padL - 1} y={0} width={geom.plotW + 2} height={CHART_H} />
            </clipPath>
          </defs>

          {geom.yTicks.map((v) => (
            <g key={v}>
              <line className="pc-grid" x1={geom.padL} y1={geom.y(v)} x2={geom.W - PAD_R} y2={geom.y(v)} />
              <text className="pc-tick" x={geom.padL - 8} y={geom.y(v)} textAnchor="end" dominantBaseline="middle">
                {money(v)}
              </text>
            </g>
          ))}

          <g clipPath={`url(#${idPrefix}-clip)`}>
            <path className="pc-area" d={geom.area} fill={`url(#${idPrefix}-fill)`} />
            <path className="pc-line" d={geom.line} />

            {overlay?.(geom)}

            {focus && (
              <g className="pc-cursor">
                <line x1={geom.x(focus.ts)} y1={PAD_T} x2={geom.x(focus.ts)} y2={PAD_T + PLOT_H} />
                <circle cx={geom.x(focus.ts)} cy={geom.y(focus.v)} r={4} />
              </g>
            )}

            {/* Where the line stops is today's value — it needs an end, or the
                stroke just runs out at the frame. */}
            {(endDotAlways || !focus) && <circle className="pc-end" cx={geom.x(latest.ts)} cy={geom.y(latest.v)} r={4} />}
          </g>

          <line className="pc-grid" x1={geom.padL} y1={PAD_T + PLOT_H} x2={geom.W - PAD_R} y2={PAD_T + PLOT_H} />

          {geom.xTicks.map((t) => (
            <text
              key={t.label}
              className="pc-tick"
              x={Math.min(Math.max(geom.x(t.ts), geom.padL + 14), geom.W - PAD_R - 14)}
              y={X_LABEL_Y}
              textAnchor="middle"
            >
              {t.label}
            </text>
          ))}
        </svg>
      )}

      {zoom.zoomed && (
        <button type="button" className="pc-reset" onClick={zoom.reset}>
          Reset zoom
        </button>
      )}

      {geom && above?.(geom)}
    </div>
  );
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
