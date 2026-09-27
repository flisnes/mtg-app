import { useMemo, useState } from 'react';
import { DAY_MS, type ContainerKind, type OracleCard, type Priced, type UserEvent } from '@mtg/shared';
import { fmtMoney } from '../price/rates.js';
import {
  useCollectionValueSeries,
  useContainerValueSeries,
  type CollectionValueSeries,
} from '../price/collectionValue.js';
import { CONTAINER_META } from '../deck/containers.js';
import { groupEntries, type HistoryEntry } from '../history/useHistoryEntries.js';
import { batchCount, describeBatch, describeEvent, qtyBadge } from '../history/eventRegistry.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { fmtDate } from '../util/format.js';
import { CardList, StackedThumb, type CardItem } from './CardViews.js';
import { CardSheet } from './CardSheet.js';
import { EventSheet } from './EventSheet.js';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';
import { LinePlot, useValueChart, ZoomHint, type ChartPt } from './ValueLineChart.js';

// What a pile has been worth over time, opened from a header total. Two ways to
// read the same pile:
//
//  - Total: what everything you held that day was worth. A card contributes
//    nothing before you owned it, so the line steps up when you buy and down
//    when you sell — the shape of the collection, not of the market.
//  - Since acquisition: the same copies measured against what they cost you.
//    Buying costs nothing on this line (you paid what it was worth), so what's
//    left is whether the cards you keep are earning their place.
//
// Picking a day fills the list underneath with what came in or out that day,
// which is where the steps in the total line come from.
//
// The whole collection and one deck, binder or box draw the same chart from the
// same series builder — only the words and which event log it replays differ.

type Mode = 'total' | 'gain';

/** A day's moves, collapsed into one marker per direction. */
interface Marker {
  day: number;
  dir: 'in' | 'out';
}

/** Everything the chart says in words, which is all that differs between piles. */
interface Words {
  title: string;
  totalNote: string;
  gainNote: string;
  inLabel: string;
  outLabel: string;
  pickHint: string;
  quietDay: (date: string) => string;
}

/** The collection's value chart, opened from the collection header total. */
export function CollectionValueChartSheet({ onClose }: { onClose: () => void }) {
  const series = useCollectionValueSeries();
  return (
    <ValueChartSheet
      series={series}
      words={{
        title: 'Collection value',
        totalNote: 'What you held each day was worth',
        gainNote: 'What those cards have gained since you got them',
        inLabel: 'Cards in',
        outLabel: 'Cards out',
        pickHint: 'Pick a day on the chart to see what you added or removed.',
        quietDay: (d) => `Nothing came in or out on ${d}.`,
      }}
      onClose={onClose}
    />
  );
}

/** The same chart for one deck, binder or box, from its own filing log. */
export function ContainerValueChartSheet({
  deckId,
  name,
  kind,
  onClose,
}: {
  deckId: string;
  name: string;
  kind: ContainerKind;
  onClose: () => void;
}) {
  const series = useContainerValueSeries(deckId);
  const noun = CONTAINER_META[kind].noun;
  return (
    <ValueChartSheet
      series={series}
      words={{
        title: name,
        totalNote: `What this ${noun} held each day was worth`,
        gainNote: 'What those cards have gained since you got them',
        inLabel: 'Cards filed',
        outLabel: 'Cards pulled',
        pickHint: `Pick a day on the chart to see what came in or out of this ${noun}.`,
        quietDay: (d) => `Nothing came in or out on ${d}.`,
      }}
      onClose={onClose}
    />
  );
}

function ValueChartSheet({
  series,
  words,
  onClose,
}: {
  /** undefined while loading, null when there isn't enough history to draw. */
  series: CollectionValueSeries | null | undefined;
  words: Words;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('total');
  const [openEntry, setOpenEntry] = useState<HistoryEntry | null>(null);
  const [card, setCard] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);

  const origPts = series?.pts ?? [];
  const pts = useMemo<ChartPt[]>(
    () => (series?.pts ?? []).map((p) => ({ ts: p.ts, day: p.day, v: mode === 'total' ? p.total : p.gain })),
    [series, mode],
  );
  const unit = series?.unit ?? 'EUR';
  // Ticks land on values like -1e-17 once the axis is padded past zero, and
  // "-0,00 €" is not a number anybody wants to read.
  const money = (v: number) => fmtMoney(Math.abs(v) < 1e-6 ? 0 : v, unit);

  // One marker per direction per day, so a day you both bought and sold shows
  // both dots rather than whichever event happened to be first.
  const markers = useMemo(() => {
    if (!series) return [] as Marker[];
    const out: Marker[] = [];
    for (const [day, events] of series.eventsByDay) {
      for (const dir of ['in', 'out'] as const) {
        if (events.some((e) => (e.kind === series.addKind) === (dir === 'in'))) out.push({ day, dir });
      }
    }
    return out.sort((a, b) => a.day - b.day);
  }, [series]);

  // Both modes have a meaningful zero: an empty collection, or break-even.
  const chart = useValueChart({ pts, resetKey: series, anchorZero: true, areaBase: 'zero', toggleTap: true });
  const { geom, zoom, focus, latest, firstPt } = chart;

  const shown = focus ?? latest;
  const change = firstPt && latest ? latest.v - firstPt.v : 0;
  const origLatest = origPts[origPts.length - 1];
  // In gain mode the headline number *is* the change, so the line under it says
  // that one number as a share of what the pile cost. Quoting how far the gain
  // itself has travelled since the chart started is a second, unrelated figure
  // sharing one label, which is how the two used to disagree.
  const gainPct = origLatest && origLatest.basis > 0 ? (origLatest.gain / origLatest.basis) * 100 : null;
  const headline = mode === 'gain' ? (origLatest?.gain ?? 0) : change;
  const dir = headline > 0.005 ? 'up' : headline < -0.005 ? 'down' : 'flat';
  const pct = firstPt && firstPt.v > 0 ? (change / firstPt.v) * 100 : null;

  const focusOrig = focus && chart.cursor != null ? origPts[chart.cursor] : undefined;
  const readout = focusOrig ?? origLatest;
  const dayEvents = focus ? (series?.eventsByDay.get(focus.day) ?? []) : [];

  return (
    <Sheet onClose={onClose} className="price-chart-sheet" label={`${words.title} over time`}>
      <div className="edition-picker-head">
        <div className="price-chart-titles">
          <h2>{words.title}</h2>
          <div className="fine-print">{mode === 'total' ? words.totalNote : words.gainNote}</div>
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
              {mode === 'gain' && shown!.v > 0 ? '+' : ''}
              {money(shown!.v)}
            </div>
            {focus ? (
              <div className="price-change">
                <span className="fine-print">on {fmtDate(focus.ts)}</span>
              </div>
            ) : mode === 'gain' ? (
              <div className={`price-change price-${dir}`}>
                {gainPct != null ? (
                  <>
                    {gainPct >= 0 ? '+' : '−'}
                    {Math.abs(gainPct).toFixed(1)}%
                    <span className="fine-print"> on the {money(origLatest!.basis)} you paid</span>
                  </>
                ) : (
                  <span className="fine-print">No acquisition prices recorded, so there is nothing to measure against.</span>
                )}
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
            idPrefix="collection-chart"
            money={money}
            label={
              geom
                ? `${words.title} from ${fmtDate(geom.t0)} to ${fmtDate(geom.t1)}, ${money(firstPt!.v)} to ${money(latest.v)}`
                : `${words.title} over time`
            }
            overlay={(g) => (
              <>
                {/* Break-even, which in gain mode is the only number that
                    matters: above it the pile is up, below it it's down. */}
                {mode === 'gain' && (
                  <g>
                    <line className="pc-basis" x1={g.padL} y1={g.zeroY} x2={g.padL + g.plotW} y2={g.zeroY} />
                    <text className="pc-basis-label" x={g.padL + g.plotW} y={g.zeroY - 5} textAnchor="end">
                      break even
                    </text>
                  </g>
                )}

                {/* Days something came in or out — the days the list below
                    has something to say. */}
                {markers.map((m) => {
                  const p = pts.reduce((a, b) => (Math.abs(b.day - m.day) < Math.abs(a.day - m.day) ? b : a));
                  return (
                    <g
                      key={`${m.day}-${m.dir}`}
                      className={`pc-mark pc-mark-${m.dir}`}
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

          <div className="price-chart-readout">
            <div>
              <span className="fine-print">Cost</span>
              <strong>{money(readout!.basis)}</strong>
              <span className="fine-print">what you paid</span>
            </div>
            <div>
              <span className="fine-print">Worth</span>
              <strong>{money(readout!.total)}</strong>
              <span className="fine-print">market value</span>
            </div>
            <div>
              <span className="fine-print">{zoom.zoomed ? 'Shown' : 'Tracked'}</span>
              <strong>{(geom?.days ?? 0) + 1} days</strong>
              <span className="fine-print">{markers.length} move{markers.length === 1 ? '' : 's'}</span>
            </div>
          </div>

          <div className="price-chart-legend">
            <span>
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" fill="var(--ok)" />
              </svg>
              {words.inLabel}
            </span>
            <span>
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" fill="var(--danger)" />
              </svg>
              {words.outLabel}
            </span>
          </div>

          <DayEvents
            day={focus?.day}
            events={dayEvents}
            words={words}
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
    </Sheet>
  );
}

/** What went in and out on the picked day. Empty until a day is picked. */
function DayEvents({
  day,
  events,
  words,
  onOpenEntry,
}: {
  day: number | undefined;
  events: UserEvent[];
  words: Words;
  onOpenEntry: (entry: HistoryEntry) => void;
}) {
  // An import or a trade is one thing that happened, not forty — same grouping
  // the edit-history list uses.
  const entries = useMemo(() => groupEntries([...events].sort((a, b) => b.ts - a.ts)), [events]);
  const { printMap, oracleMap } = useCardMaps(events.map((e) => ({ scryfallId: e.scryfallId ?? '', oracleId: e.oracleId })));

  if (day == null) {
    return <p className="fine-print">{words.pickHint}</p>;
  }
  if (!entries.length) {
    return <p className="fine-print">{words.quietDay(fmtDate(day * DAY_MS))}</p>;
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
