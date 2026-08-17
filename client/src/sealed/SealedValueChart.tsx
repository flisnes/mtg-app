import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DAY_MS, type SealedItem } from '@mtg/shared';
import { fmtMoney } from '../price/rates.js';
import { useSealedValueSeries } from '../price/sealedValue.js';
import { fmtDate } from '../util/format.js';
import { Icon } from '../components/icons.js';
import { niceTicks } from '../components/PriceChart.js';
import { useDismiss } from '../components/useDismiss.js';
import { SealedImage } from './SealedImage.js';
import { itemImage } from './product.js';

// What the shelf has been worth, opened from the sealed page's total. One line,
// because a box has no acquisition price to compare against: the app knows what
// a booster box is quoted at, not what you paid the local store for it. The dots
// are the days products landed on the shelf, which is where the steps come from.

const PLOT_H = 210;
const PAD = { t: 14, r: 16, b: 54, l: 62 };
const H = PAD.t + PLOT_H + PAD.b;
const X_LABEL_Y = H - 12;
const MIN_W = 240;

export function SealedValueChartSheet({ onClose }: { onClose: () => void }) {
  useDismiss(onClose);
  const series = useSealedValueSeries();
  const [cursor, setCursor] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The plot only exists once the series has loaded, so this has to re-run when
  // it arrives — on mount there is nothing to observe.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (w && w !== prev ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [series]);

  const pts = series?.pts ?? [];
  const unit = series?.unit ?? 'EUR';
  const money = (v: number) => fmtMoney(Math.abs(v) < 1e-6 ? 0 : v, unit);

  const geom = useMemo(() => {
    if (!pts.length || !width) return null;
    const W = Math.max(MIN_W, width);
    const plotW = W - PAD.l - PAD.r;
    const t0 = pts[0]!.ts;
    const t1 = pts[pts.length - 1]!.ts;
    const span = t1 - t0 || DAY_MS;

    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.total < lo) lo = p.total;
      if (p.total > hi) hi = p.total;
    }
    // An empty shelf is a meaningful zero, so anchor to it rather than drawing a
    // flat line as dramatic noise.
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    const yMin = lo - pad;
    const yMax = hi + pad;

    const x = (ts: number) => PAD.l + ((ts - t0) / span) * plotW;
    const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * PLOT_H;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ');
    const zeroY = y(0);
    const area = `${line} L${x(t1).toFixed(1)},${zeroY.toFixed(1)} L${x(t0).toFixed(1)},${zeroY.toFixed(1)} Z`;

    const days = Math.round(span / DAY_MS);
    const dateFmt = new Intl.DateTimeFormat(
      undefined,
      days > 300 ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' },
    );
    const xTickCount = Math.max(2, Math.min(5, Math.floor(plotW / 78)));
    const xTicks: { ts: number; label: string }[] = [];
    for (let i = 0; i < xTickCount; i++) {
      const ts = t0 + (span * i) / (xTickCount - 1);
      const label = dateFmt.format(new Date(ts));
      if (xTicks.some((t) => t.label === label)) continue;
      xTicks.push({ ts, label });
    }

    return { W, x, y, line, area, t0, t1, span, plotW, yTicks: niceTicks(yMin, yMax, 4), xTicks, days };
  }, [pts, width]);

  /** Nearest day to a client x within the plot; tapping the picked day lets go. */
  function pick(clientX: number, el: SVGSVGElement, toggle = false) {
    if (!geom) return;
    const rect = el.getBoundingClientRect();
    const px = ((clientX - rect.left) * geom.W) / (rect.width || geom.W);
    const ts = geom.t0 + ((px - PAD.l) / geom.plotW) * geom.span;
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
  const focus = cursor != null ? pts[cursor] : undefined;
  const shown = focus ?? latest;
  const change = firstPt && latest ? latest.total - firstPt.total : 0;
  const dir = change > 0.005 ? 'up' : change < -0.005 ? 'down' : 'flat';
  const pct = firstPt && firstPt.total > 0 ? (change / firstPt.total) * 100 : null;
  const lo = pts.length ? pts.reduce((a, p) => (p.total < a.total ? p : a)) : undefined;
  const hi = pts.length ? pts.reduce((a, p) => (p.total > a.total ? p : a)) : undefined;
  const adds = useMemo(() => [...(series?.addsByDay.keys() ?? [])].sort((a, b) => a - b), [series]);
  const dayAdds = focus ? (series?.addsByDay.get(focus.day) ?? []) : [];

  return createPortal(
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet price-chart-sheet" role="dialog" aria-label="Sealed value over time" onClick={(e) => e.stopPropagation()}>
        <div className="edition-picker-head">
          <div className="price-chart-titles">
            <h2>Sealed value</h2>
            <div className="fine-print">What the unopened products on your shelf were worth</div>
          </div>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {series === undefined ? (
          <p className="fine-print">Loading…</p>
        ) : !series || !latest ? (
          <p className="fine-print">
            Not enough price history yet. Sealed prices are recorded once a day when you open the app, so come back tomorrow.
          </p>
        ) : (
          <>
            <div className="price-chart-hero">
              <div className="price-chart-now">{money(shown!.total)}</div>
              {focus ? (
                <div className="price-change">
                  <span className="fine-print">on {fmtDate(focus.ts)}</span>
                </div>
              ) : (
                <div className={`price-change price-${dir}`}>
                  {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {money(Math.abs(change))}
                  {pct != null && ` (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`}
                  <span className="fine-print"> since {fmtDate(firstPt!.ts)}</span>
                </div>
              )}
            </div>

            <div className="price-chart-plot" ref={plotRef}>
              {geom && (
                <svg
                  className="price-chart-svg"
                  width={geom.W}
                  height={H}
                  viewBox={`0 0 ${geom.W} ${H}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`Sealed value from ${fmtDate(geom.t0)} to ${fmtDate(geom.t1)}, ${money(firstPt!.total)} to ${money(latest.total)}`}
                  onPointerDown={(e) => pick(e.clientX, e.currentTarget, true)}
                  onPointerMove={(e) => {
                    if (e.buttons) pick(e.clientX, e.currentTarget);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    e.preventDefault();
                    const step = e.key === 'ArrowRight' ? 1 : -1;
                    setCursor((c) => Math.max(0, Math.min(pts.length - 1, (c ?? pts.length - 1) + step)));
                  }}
                >
                  <defs>
                    <linearGradient id="sealed-chart-fill" x1="0" y1="0" x2="0" y2="1">
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

                  <path className="pc-area" d={geom.area} fill="url(#sealed-chart-fill)" />
                  <path className="pc-line" d={geom.line} />

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

                  {focus && (
                    <g className="pc-cursor">
                      <line x1={geom.x(focus.ts)} y1={PAD.t} x2={geom.x(focus.ts)} y2={PAD.t + PLOT_H} />
                      <circle cx={geom.x(focus.ts)} cy={geom.y(focus.total)} r={4} />
                    </g>
                  )}

                  {/* Days a product landed on the shelf — the steps in the line. */}
                  {adds.map((day) => {
                    const p = pts.reduce((a, b) => (Math.abs(b.day - day) < Math.abs(a.day - day) ? b : a));
                    return (
                      <g
                        key={day}
                        className="pc-mark pc-mark-in"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setCursor(pts.indexOf(p));
                        }}
                      >
                        <title>{fmtDate(p.ts)}</title>
                        <circle className="pc-hit" cx={geom.x(p.ts)} cy={geom.y(p.total)} r={14} />
                        <circle cx={geom.x(p.ts)} cy={geom.y(p.total)} r={4} />
                      </g>
                    );
                  })}

                  {!focus && <circle className="pc-end" cx={geom.x(latest.ts)} cy={geom.y(latest.total)} r={4} />}
                </svg>
              )}
            </div>

            {lo && hi && (
              <div className="price-chart-readout">
                <div>
                  <span className="fine-print">High</span>
                  <strong>{money(hi.total)}</strong>
                  <span className="fine-print">{fmtDate(hi.ts)}</span>
                </div>
                <div>
                  <span className="fine-print">Low</span>
                  <strong>{money(lo.total)}</strong>
                  <span className="fine-print">{fmtDate(lo.ts)}</span>
                </div>
                <div>
                  <span className="fine-print">Tracked</span>
                  <strong>{(geom?.days ?? 0) + 1} days</strong>
                  <span className="fine-print">
                    {adds.length} arrival{adds.length === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            )}

            <DayArrivals day={focus?.day} items={dayAdds} />

            {series.unpriced > 0 && (
              <p className="fine-print">
                {series.unpriced === 1
                  ? '1 copy with no recorded price sits outside the line.'
                  : `${series.unpriced} copies with no recorded price sit outside the line.`}
              </p>
            )}
          </>
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

/** What arrived on the picked day. Empty until a day is picked. */
function DayArrivals({ day, items }: { day: number | undefined; items: SealedItem[] }) {
  if (day == null) return <p className="fine-print">Pick a day on the chart to see what arrived that day.</p>;
  if (!items.length) return <p className="fine-print">Nothing arrived on {fmtDate(day * DAY_MS)}.</p>;
  return (
    <div className="collection-chart-day">
      <h3>{fmtDate(day * DAY_MS)}</h3>
      <ul className="sealed-results">
        {items.map((item) => (
          <li key={item.id}>
            <div className="sealed-result sealed-result-static">
              <SealedImage url={itemImage(item, 'thumb')} alt="" className="sealed-shot-sm" />
              <span className="sealed-result-text">
                <span className="sealed-result-name">{item.name}</span>
                <span className="sealed-result-sub">
                  {item.setName ?? item.set.toUpperCase()} · {item.quantity} on the shelf
                </span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
