import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DAY_MS, type DayReadings, type Finish, type UserEvent, type UserEventKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getPrefs, type BaseCurrency } from '../prefs.js';
import { costBasisOf } from '../price/costBasis.js';
import { convertToDisplay, fmtMoney } from '../price/rates.js';
import { describeEvent, qtyBadge } from '../history/eventRegistry.js';
import { fmtDate } from '../util/format.js';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';
import { LinePlot, PLOT_H, useValueChart, ZoomHint, type ChartPt } from './ValueLineChart.js';

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

const PAD_T = 14;
const RUG_TOP = PAD_T + PLOT_H + 8;
const RUG_H = 8;

/** A day's worth of money events, collapsed into one marker. */
interface Marker {
  day: number;
  ts: number;
  dir: 'in' | 'out';
  events: UserEvent[];
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
    const pts: ChartPt[] = [];
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
  const chart = useValueChart({
    pts,
    // The full view always makes room for the paid line — it's the comparison
    // the chart is for. Zoomed in, the detail wins and the line can fall off.
    includeY: marks.basisLine,
    padL: 56,
    hoverScrub: true,
  });
  const { geom, zoom, focus, latest, firstPt } = chart;
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

  return (
    <Sheet onClose={onClose} className="price-chart-sheet" label={`Price history of ${name}`}>
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

        {series ? (
          <LinePlot
            chart={chart}
            idPrefix="price-chart"
            money={money}
            endDotAlways
            clearCursorOnLeave
            label={
              geom
                ? `Price from ${fmtDate(geom.t0)} to ${fmtDate(geom.t1)}, ${money(firstPt!.v)} to ${money(latest!.v)}`
                : `Price history of ${name}`
            }
            overlay={(g) => (
              <>
                {/* What you paid per copy — the line the current price is worth
                    comparing against. Dashed so it never reads as a gridline. */}
                {marks.basisLine != null && (
                  <g>
                    <line className="pc-basis" x1={g.padL} y1={g.y(marks.basisLine)} x2={g.padL + g.plotW} y2={g.y(marks.basisLine)} />
                    <text className="pc-basis-label" x={g.padL + g.plotW} y={g.y(marks.basisLine) - 5} textAnchor="end">
                      paid {money(marks.basisLine)}
                    </text>
                  </g>
                )}

                {/* Deck, wishlist and tradelist activity: a tick each, under the
                    plot, where it can't compete with the money markers. */}
                {marks.rug.map((r) => (
                  <g key={`rug-${r.day}`} className="pc-rug" onPointerDown={(e) => e.stopPropagation()} onClick={() => onEventClick?.(r.events[0]!)}>
                    <title>{`${fmtDate(r.ts)}: ${r.events.map((e) => describeEvent(e).verb).join(', ')}`}</title>
                    <rect className="pc-hit" x={g.x(r.ts) - 9} y={RUG_TOP - 6} width={18} height={RUG_H + 12} />
                    <line x1={g.x(r.ts)} y1={RUG_TOP} x2={g.x(r.ts)} y2={RUG_TOP + RUG_H} />
                  </g>
                ))}

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
                      <circle className="pc-hit" cx={g.x(m.ts)} cy={g.y(p.v)} r={14} />
                      <circle cx={g.x(m.ts)} cy={g.y(p.v)} r={5} />
                    </g>
                  );
                })}
              </>
            )}
            above={(g) =>
              focus && (
                <div
                  className="pc-tooltip"
                  style={{
                    left: Math.min(Math.max(g.x(focus.ts) - 70, 4), Math.max(4, g.W - 148)),
                    // Park the card opposite the point so it never covers it.
                    top: g.y(focus.v) > PAD_T + PLOT_H / 2 ? PAD_T : PAD_T + PLOT_H - 84,
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
              )
            }
          />
        ) : (
          <p className="fine-print">Not enough readings yet to draw a chart.</p>
        )}

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
    </Sheet>
  );
}
