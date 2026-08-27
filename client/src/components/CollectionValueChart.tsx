import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DAY_MS, type OracleCard, type Priced, type UserEvent } from '@mtg/shared';
import { fmtMoney } from '../price/rates.js';
import { useCollectionValueSeries, type CollectionValuePoint } from '../price/collectionValue.js';
import { groupEntries, type HistoryEntry } from '../history/useHistoryEntries.js';
import { batchCount, describeBatch, describeEvent, qtyBadge } from '../history/eventRegistry.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { fmtDate } from '../util/format.js';
import { CardList, StackedThumb, type CardItem } from './CardViews.js';
import { CardSheet } from './CardSheet.js';
import { EventSheet } from './EventSheet.js';
import { Icon } from './icons.js';
import { niceTicks } from './PriceChart.js';
import { useDismiss } from './useDismiss.js';

// The collection's worth over time, opened from the header's total. Two ways to
// read the same pile:
//
//  - Total: what everything you held that day was worth. A card contributes
//    nothing before you owned it, so the line steps up when you buy and down
//    when you sell — the shape of the collection, not of the market.
//  - Since acquisition: the same copies measured against what they cost you.
//    Buying costs nothing on this line (you paid what it was worth), so what's
//    left is whether the cards you keep are earning their place.
//
// Picking a day fills the list underneath with what you added or removed that
// day, which is where the steps in the total line come from.

type Mode = 'total' | 'gain';

const PLOT_H = 210;
const PAD = { t: 14, r: 16, b: 54, l: 62 };
const H = PAD.t + PLOT_H + PAD.b;
const X_LABEL_Y = H - 12;
const MIN_W = 240;

/** A day's collection moves, collapsed into one marker per direction. */
interface Marker {
  day: number;
  dir: 'in' | 'out';
}

export function CollectionValueChartSheet({ onClose }: { onClose: () => void }) {
  useDismiss(onClose);
  const series = useCollectionValueSeries();
  const [mode, setMode] = useState<Mode>('total');
  const [cursor, setCursor] = useState<number | null>(null);
  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null);
  const [card, setCard] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The plot only exists once the series has loaded, so this has to re-run when
  // it arrives — on mount there is nothing to observe and the chart would sit
  // at zero width forever.
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
  // Ticks land on values like -1e-17 once the axis is padded past zero, and
  // "-0,00 €" is not a number anybody wants to read.
  const money = (v: number) => fmtMoney(Math.abs(v) < 1e-6 ? 0 : v, unit);
  const valueOf = (p: CollectionValuePoint) => (mode === 'total' ? p.total : p.gain);

  // One marker per direction per day, so a day you both bought and sold shows
  // both dots rather than whichever event happened to be first.
  const markers = useMemo(() => {
    if (!series) return [] as Marker[];
    const out: Marker[] = [];
    for (const [day, events] of series.eventsByDay) {
      for (const dir of ['in', 'out'] as const) {
        const kind = dir === 'in' ? 'collection.add' : 'collection.remove';
        if (events.some((e) => e.kind === kind)) out.push({ day, dir });
      }
    }
    return out.sort((a, b) => a.day - b.day);
  }, [series]);

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
      const v = valueOf(p);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Both modes have a meaningful zero: an empty collection, or break-even.
    // Anchoring to it stops a flat line from being drawn as dramatic noise.
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    const yMin = lo - pad;
    const yMax = hi + pad;

    const x = (ts: number) => PAD.l + ((ts - t0) / span) * plotW;
    const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * PLOT_H;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(valueOf(p)).toFixed(1)}`).join(' ');
    const zeroY = y(0);
    const area = `${line} L${x(t1).toFixed(1)},${zeroY.toFixed(1)} L${x(t0).toFixed(1)},${zeroY.toFixed(1)} Z`;

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

    return { W, x, y, line, area, zeroY, t0, t1, span, plotW, yTicks: niceTicks(yMin, yMax, 4), xTicks, days };
    // valueOf closes over `mode`, which is what actually changes the geometry.
  }, [pts, width, mode]);

  /**
   * Nearest day to a client x within the plot, for scrub and keyboard. Tapping
   * the day that's already picked lets go of it again — the list below is the
   * point of picking one, and there has to be a way back to an empty list.
   */
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
  const change = firstPt && latest ? valueOf(latest) - valueOf(firstPt) : 0;
  const dir = change > 0.005 ? 'up' : change < -0.005 ? 'down' : 'flat';
  // In gain mode the headline number is already a change, so the percentage
  // that means something is the return on what the pile cost, not on day one.
  const pct =
    mode === 'gain'
      ? latest && latest.basis > 0
        ? (latest.gain / latest.basis) * 100
        : null
      : firstPt && valueOf(firstPt) > 0
        ? (change / valueOf(firstPt)) * 100
        : null;

  const dayEvents = focus ? (series?.eventsByDay.get(focus.day) ?? []) : [];

  return createPortal(
    // Only a click on the backdrop itself closes. The event and card sheets
    // below portal to the body but stay children of this node in the React
    // tree, where events still bubble — without the target check, tapping a
    // card in the day list would close the chart under it.
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet price-chart-sheet" role="dialog" aria-label="Collection value over time" onClick={(e) => e.stopPropagation()}>
        <div className="edition-picker-head">
          <div className="price-chart-titles">
            <h2>Collection value</h2>
            <div className="fine-print">
              {mode === 'total' ? 'What you held each day was worth' : 'What those cards have gained since you got them'}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="seg-row sheet-tabs" role="tablist" aria-label="Chart mode">
          <button role="tab" aria-selected={mode === 'total'} className={mode === 'total' ? 'seg seg-active' : 'seg'} onClick={() => setMode('total')}>
            Total value
          </button>
          <button role="tab" aria-selected={mode === 'gain'} className={mode === 'gain' ? 'seg seg-active' : 'seg'} onClick={() => setMode('gain')}>
            Since acquisition
          </button>
        </div>

        {series === undefined ? (
          <p className="fine-print">Loading…</p>
        ) : !series || !latest ? (
          <p className="fine-print">
            Not enough price history yet. Prices are recorded once a day when you open the app, so come back tomorrow.
          </p>
        ) : (
          <>
            <div className="price-chart-hero">
              <div className="price-chart-now">
                {mode === 'gain' && valueOf(shown!) > 0 ? '+' : ''}
                {money(valueOf(shown!))}
              </div>
              {focus ? (
                <div className="price-change">
                  <span className="fine-print">on {fmtDate(focus.ts)}</span>
                </div>
              ) : (
                <div className={`price-change price-${dir}`}>
                  {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {money(Math.abs(change))}
                  {pct != null && ` (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`}
                  <span className="fine-print"> {mode === 'gain' ? 'of what it cost' : `since ${fmtDate(firstPt!.ts)}`}</span>
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
                  aria-label={`Collection ${mode === 'total' ? 'value' : 'gain'} from ${fmtDate(geom.t0)} to ${fmtDate(geom.t1)}, ${money(valueOf(firstPt!))} to ${money(valueOf(latest))}`}
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
                    <linearGradient id="collection-chart-fill" x1="0" y1="0" x2="0" y2="1">
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

                  <path className="pc-area" d={geom.area} fill="url(#collection-chart-fill)" />
                  <path className="pc-line" d={geom.line} />

                  {/* Break-even, which in gain mode is the only number that
                      matters: above it the pile is up, below it it's down. */}
                  {mode === 'gain' && (
                    <g>
                      <line className="pc-basis" x1={PAD.l} y1={geom.zeroY} x2={geom.W - PAD.r} y2={geom.zeroY} />
                      <text className="pc-basis-label" x={geom.W - PAD.r} y={geom.zeroY - 5} textAnchor="end">
                        break even
                      </text>
                    </g>
                  )}

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
                      <circle cx={geom.x(focus.ts)} cy={geom.y(valueOf(focus))} r={4} />
                    </g>
                  )}

                  {/* Days you bought or sold — the days the list below has
                      something to say. */}
                  {markers.map((m) => {
                    const p = pts.reduce((a, b) => (Math.abs(b.day - m.day) < Math.abs(a.day - m.day) ? b : a));
                    return (
                      <g
                        key={`${m.day}-${m.dir}`}
                        className={`pc-mark pc-mark-${m.dir}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setCursor(pts.indexOf(p));
                        }}
                      >
                        <title>{fmtDate(p.ts)}</title>
                        <circle className="pc-hit" cx={geom.x(p.ts)} cy={geom.y(valueOf(p))} r={14} />
                        <circle cx={geom.x(p.ts)} cy={geom.y(valueOf(p))} r={4} />
                      </g>
                    );
                  })}

                  {!focus && <circle className="pc-end" cx={geom.x(latest.ts)} cy={geom.y(valueOf(latest))} r={4} />}
                </svg>
              )}
            </div>

            <div className="price-chart-readout">
              <div>
                <span className="fine-print">Cost</span>
                <strong>{money((focus ?? latest).basis)}</strong>
                <span className="fine-print">what you paid</span>
              </div>
              <div>
                <span className="fine-print">Worth</span>
                <strong>{money((focus ?? latest).total)}</strong>
                <span className="fine-print">market value</span>
              </div>
              <div>
                <span className="fine-print">Tracked</span>
                <strong>{(geom?.days ?? 0) + 1} days</strong>
                <span className="fine-print">{markers.length} move{markers.length === 1 ? '' : 's'}</span>
              </div>
            </div>

            <div className="price-chart-legend">
              <span>
                <svg width="10" height="10" aria-hidden>
                  <circle cx="5" cy="5" r="4" fill="var(--ok)" />
                </svg>
                Cards in
              </span>
              <span>
                <svg width="10" height="10" aria-hidden>
                  <circle cx="5" cy="5" r="4" fill="var(--danger)" />
                </svg>
                Cards out
              </span>
            </div>

            <DayEvents
              day={focus?.day}
              events={dayEvents}
              onOpenEntry={setOpenEntry}
            />

            {series.unpriced > 0 && (
              <p className="fine-print">
                {series.unpriced} cop{series.unpriced === 1 ? 'y' : 'ies'} with no recorded price sit outside both lines.
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

      {openEntry && (
        <EventSheet
          entry={openEntry}
          onOpenCard={(oracle, scryfallId) => {
            setOpenEntry(null);
            setCard({ oracle, scryfallId });
          }}
          onClose={() => setOpenEntry(null)}
        />
      )}
      {/* Read-only, like every other drill-in from a chart or a timeline: you
          came here to see what a card did, not to file another copy of it. */}
      {card && <CardSheet mode="info" oracleCard={card.oracle} initialScryfallId={card.scryfallId} onClose={() => setCard(null)} />}
    </div>,
    document.body,
  );
}

/** What went in and out on the picked day. Empty until a day is picked. */
function DayEvents({
  day,
  events,
  onOpenEntry,
}: {
  day: number | undefined;
  events: UserEvent[];
  onOpenEntry: (entry: HistoryEntry) => void;
}) {
  // An import or a trade is one thing that happened, not forty — same grouping
  // the edit-history list uses.
  const entries = useMemo(() => groupEntries([...events].sort((a, b) => b.ts - a.ts)), [events]);
  const { printMap, oracleMap } = useCardMaps(events.map((e) => ({ scryfallId: e.scryfallId ?? '', oracleId: e.oracleId })));

  if (day == null) {
    return <p className="fine-print">Pick a day on the chart to see what you added or removed.</p>;
  }
  if (!entries.length) {
    return <p className="fine-print">Nothing came in or out on {fmtDate(day * DAY_MS)}.</p>;
  }

  const imgOf = (oracleId: string, scryfallId?: string | null): string | null =>
    (scryfallId ? printMap?.get(scryfallId)?.imageSmall : null) ?? oracleMap?.get(oracleId)?.imageSmall ?? null;

  const items = entries.map((entry): CardItem => {
    if (entry.kind === 'batch') {
      const display = describeBatch(entry.source, entry.label, entry.events);
      const count = batchCount(entry.events);
      const imgs: string[] = [];
      for (const e of entry.events) {
        const img = imgOf(e.oracleId, e.scryfallId);
        if (img && !imgs.includes(img)) imgs.push(img);
        if (imgs.length >= 3) break;
      }
      return {
        key: entry.id,
        name: display.verb,
        image: null,
        thumb: <StackedThumb images={imgs} />,
        badge: <Icon name={display.icon} size={14} />,
        badgeTitle: display.verb,
        sub: `${count} card${count === 1 ? '' : 's'}`,
        onClick: () => onOpenEntry(entry),
      };
    }
    const e = entry.event;
    const display = describeEvent(e);
    return {
      key: entry.id,
      name: oracleMap?.get(e.oracleId)?.name ?? '(unknown card)',
      image: imgOf(e.oracleId, e.scryfallId),
      foil: e.finish != null && e.finish !== 'nonfoil',
      badge: qtyBadge(e) ?? <Icon name={display.icon} size={14} />,
      sub: display.verb,
      onClick: () => onOpenEntry(entry),
    };
  });

  return (
    <div className="collection-chart-day">
      <h3>{fmtDate(day * DAY_MS)}</h3>
      <CardList items={items} />
    </div>
  );
}
