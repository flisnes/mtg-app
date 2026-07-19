import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { moverStats, swingStats, type MoverStats, type SwingStats } from '../price/movers.js';
import { CardList, type CardItem } from '../components/CardViews.js';
import { CardSheet } from '../components/CardSheet.js';
import { Sparkline } from '../components/Sparkline.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { Icon } from '../components/icons.js';

// Price movers: which collection cards recently moved substantially (combined
// absolute + percentage test, see price/movers.ts), which drift steadily, and
// which sit at a dip or spike of a price range they swing within.

const WINDOWS: [number, string][] = [
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [Infinity, 'Since tracking began'],
];

interface Mover {
  scryfallId: string;
  stats: MoverStats | null;
  swing: SwingStats | null;
  printing?: Priced<Printing>;
  oracle?: Priced<OracleCard>;
  onTradelist: boolean;
  onWishlist: boolean;
}

export function PriceMovers() {
  const [windowDays, setWindowDays] = useState(7);
  const [info, setInfo] = useState<Mover | null>(null);

  const data = useLiveQuery(async () => {
    const [histories, entries, wishes] = await Promise.all([
      db.priceHistories.toArray(),
      db.collection.toArray(),
      db.wishlist.toArray(),
    ]);
    const movers: { scryfallId: string; stats: MoverStats | null; swing: SwingStats | null }[] = [];
    for (const h of histories) {
      const stats = moverStats(h, windowDays);
      const swing = swingStats(h);
      if (stats || swing) movers.push({ scryfallId: h.scryfallId, stats, swing });
    }
    const printMap = await getPrintingsByIds(movers.map((m) => m.scryfallId));
    const oracleMap = await getOracleCardsByIds([...printMap.values()].map((p) => p.oracleId));
    const forTrade = new Set(entries.filter((e) => e.quantityForTrade > 0).map((e) => e.scryfallId));
    const wishedIds = new Set(wishes.map((w) => w.scryfallId).filter((id): id is string => id !== null));
    // An "any printing" wish covers every printing of its oracle (wishMatcher rule).
    const wishedOracles = new Set(wishes.filter((w) => !w.scryfallId).map((w) => w.oracleId));
    return {
      tracked: histories.length,
      movers: movers.map((m): Mover => {
        const printing = printMap.get(m.scryfallId);
        return {
          ...m,
          printing,
          oracle: printing && oracleMap.get(printing.oracleId),
          onTradelist: forTrade.has(m.scryfallId),
          onWishlist: wishedIds.has(m.scryfallId) || (!!printing && wishedOracles.has(printing.oracleId)),
        };
      }),
    };
  }, [windowDays]);

  const { risers, fallers, steady, swings } = useMemo(() => {
    const all = data?.movers ?? [];
    const big = all
      .filter((m) => m.stats?.substantial)
      .sort((a, b) => (b.stats?.score ?? 0) - (a.stats?.score ?? 0));
    return {
      risers: big.filter((m) => (m.stats?.delta ?? 0) > 0),
      fallers: big.filter((m) => (m.stats?.delta ?? 0) < 0),
      steady: all.filter((m) => m.stats?.trend).sort((a, b) => (b.stats?.trendR ?? 0) - (a.stats?.trendR ?? 0)),
      swings: all.filter((m) => m.swing).sort((a, b) => (b.swing?.score ?? 0) - (a.swing?.score ?? 0)),
    };
  }, [data]);

  return (
    <Page title="Price movers" subtitle="Notable price changes among the cards you own or wish for.">
      {data === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : data.movers.length === 0 ? (
        <EmptyState hint="A reading is recorded each day you open the app, so movements show up after a few days.">
          {data.tracked === 0 ? 'No prices tracked yet. Add cards to your collection first.' : 'Not enough price history yet.'}
        </EmptyState>
      ) : (
        <>
          <div className="filter-row">
            <select
              value={String(windowDays)}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              aria-label="Time window"
            >
              {WINDOWS.map(([days, label]) => (
                <option key={label} value={String(days)}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <MoverSection title="Risers" movers={risers} onOpen={setInfo} empty="No big risers in this window." />
          <MoverSection title="Fallers" movers={fallers} onOpen={setInfo} empty="No big fallers in this window." />
          <MoverSection
            title="Steady trends"
            subtitle="Cards moving consistently in one direction since tracking began, even in small steps."
            movers={steady}
            onOpen={setInfo}
            empty="No consistent trends yet. These need at least five readings."
          />
          <MoverSection
            title="Dips and spikes"
            subtitle="Cards whose price swings within a range and currently sits near the low or high end of it."
            movers={swings}
            onOpen={setInfo}
            empty="No cards at a dip or spike right now. These need a week or more of readings."
            swing
          />
        </>
      )}

      {info?.oracle && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}

function MoverSection({
  title,
  subtitle,
  movers,
  onOpen,
  empty,
  swing,
}: {
  title: string;
  subtitle?: string;
  movers: Mover[];
  onOpen: (m: Mover) => void;
  empty: string;
  /** Render the dip/spike sub-line instead of the window-change one. */
  swing?: boolean;
}) {
  return (
    <section className="mover-section">
      <h3>{title}</h3>
      {subtitle && <p className="fine-print">{subtitle}</p>}
      {movers.length === 0 ? (
        <p className="search-meta">{empty}</p>
      ) : (
        <CardList
          items={movers.map(
            (m): CardItem => ({
              key: m.scryfallId,
              name: m.oracle?.name ?? '(unknown card)',
              image: m.printing?.imageSmall ?? m.oracle?.imageSmall ?? null,
              badge:
                m.onTradelist || m.onWishlist ? (
                  <>
                    {m.onTradelist && (
                      <span className="list-glyph glyph-trade" title="On your tradelist">
                        <Icon name="tradelist" size={11} />
                      </span>
                    )}
                    {m.onWishlist && (
                      <span className="list-glyph glyph-wish" title="On your wishlist">
                        <Icon name="wishlist" size={11} />
                      </span>
                    )}
                  </>
                ) : undefined,
              sub: swing ? <SwingSub m={m} /> : <MoverSub m={m} />,
              price: swing
                ? formatMoney(m.swing!.cur, m.swing!.current)
                : formatMoney(m.stats!.cur, m.stats!.current),
              onClick: m.oracle ? () => onOpen(m) : undefined,
            }),
          )}
        />
      )}
    </section>
  );
}

function MoverSub({ m }: { m: Mover }) {
  const s = m.stats!;
  const dir = s.delta > 0 ? 'up' : s.delta < 0 ? 'down' : 'flat';
  return (
    <span className="mover-sub">
      {m.printing && (
        <>
          <SetSymbol set={m.printing.set} className="sub-set-symbol" title={m.printing.setName} />
          {`${m.printing.setName} · `}
        </>
      )}
      <span className={`price-${dir}`}>
        {dir === 'up' ? '▲' : '▼'} {formatMoney(s.cur, Math.abs(s.delta))}
        {s.pct != null && ` (${s.pct >= 0 ? '+' : '−'}${Math.abs(s.pct).toFixed(1)}%)`}
      </span>{' '}
      in {s.spanDays} day{s.spanDays === 1 ? '' : 's'}
      {s.trend && <span className="badge">{s.trend === 'rising' ? '↗ steady' : '↘ steady'}</span>}
      <Sparkline values={s.series} width={64} height={18} />
    </span>
  );
}

function SwingSub({ m }: { m: Mover }) {
  const s = m.swing!;
  return (
    <span className="mover-sub">
      {m.printing && (
        <>
          <SetSymbol set={m.printing.set} className="sub-set-symbol" title={m.printing.setName} />
          {`${m.printing.setName} · `}
        </>
      )}
      <span className={s.kind === 'dip' ? 'price-down' : 'price-up'}>
        {s.kind === 'dip' ? '▼ At a dip' : '▲ At a spike'}
      </span>{' '}
      · swings {formatMoney(s.cur, s.low)}–{formatMoney(s.cur, s.high)} over {s.spanDays} days
      <Sparkline values={s.series} width={64} height={18} />
    </span>
  );
}

function formatMoney(cur: 'eur' | 'usd', v: number): string {
  return `${cur === 'eur' ? '€' : '$'}${v.toFixed(2)}`;
}
