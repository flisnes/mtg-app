import { useMemo } from 'react';
import { DAY_MS, type SealedItem } from '@mtg/shared';
import { fmtMoney } from '../price/rates.js';
import { useSealedValueSeries } from '../price/sealedValue.js';
import { fmtDate } from '../util/format.js';
import { Icon } from '../components/icons.js';
import { Sheet } from '../components/Sheet.js';
import { LinePlot, useValueChart, ZoomHint, type ChartPt } from '../components/ValueLineChart.js';
import { SealedImage } from './SealedImage.js';
import { itemImage } from './product.js';

// What the shelf has been worth, opened from the sealed page's total. One line,
// because a box has no acquisition price to compare against: the app knows what
// a booster box is quoted at, not what you paid the local store for it. The dots
// are the days products landed on the shelf, which is where the steps come from.

export function SealedValueChartSheet({ onClose }: { onClose: () => void }) {
  const series = useSealedValueSeries();

  const pts = useMemo<ChartPt[]>(() => (series?.pts ?? []).map((p) => ({ ts: p.ts, day: p.day, v: p.total })), [series]);
  const unit = series?.unit ?? 'EUR';
  const money = (v: number) => fmtMoney(Math.abs(v) < 1e-6 ? 0 : v, unit);

  // An empty shelf is a meaningful zero, so the unzoomed view anchors to it
  // rather than drawing a flat line as dramatic noise.
  const chart = useValueChart({ pts, resetKey: series, anchorZero: true, areaBase: 'zero', toggleTap: true });
  const { geom, zoom, focus, latest, firstPt } = chart;

  const shown = focus ?? latest;
  const change = firstPt && latest ? latest.v - firstPt.v : 0;
  const dir = change > 0.005 ? 'up' : change < -0.005 ? 'down' : 'flat';
  const pct = firstPt && firstPt.v > 0 ? (change / firstPt.v) * 100 : null;
  const lo = pts.length ? pts.reduce((a, p) => (p.v < a.v ? p : a)) : undefined;
  const hi = pts.length ? pts.reduce((a, p) => (p.v > a.v ? p : a)) : undefined;
  const adds = useMemo(() => [...(series?.addsByDay.keys() ?? [])].sort((a, b) => a - b), [series]);
  const dayAdds = focus ? (series?.addsByDay.get(focus.day) ?? []) : [];

  return (
    <Sheet onClose={onClose} className="price-chart-sheet" label="Sealed value over time">
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
            <div className="price-chart-now">{money(shown!.v)}</div>
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

          <LinePlot
            chart={chart}
            idPrefix="sealed-chart"
            money={money}
            label={
              geom
                ? `Sealed value from ${fmtDate(geom.t0)} to ${fmtDate(geom.t1)}, ${money(firstPt!.v)} to ${money(latest.v)}`
                : 'Sealed value over time'
            }
            overlay={(g) => (
              <>
                {/* Days a product landed on the shelf — the steps in the line. */}
                {adds.map((day) => {
                  const p = pts.reduce((a, b) => (Math.abs(b.day - day) < Math.abs(a.day - day) ? b : a));
                  return (
                    <g
                      key={day}
                      className="pc-mark pc-mark-in"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        chart.setCursor(() => pts.indexOf(p));
                      }}
                    >
                      <title>{fmtDate(p.ts)}</title>
                      <circle className="pc-hit" cx={g.x(p.ts)} cy={g.y(p.v)} r={14} />
                      <circle cx={g.x(p.ts)} cy={g.y(p.v)} r={4} />
                    </g>
                  );
                })}
              </>
            )}
          />

          <ZoomHint />

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
    </Sheet>
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
