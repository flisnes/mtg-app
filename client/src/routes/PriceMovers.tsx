import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { moverStats, swingStats, type MoverStats, type SwingStats } from '../price/movers.js';
import { convertToDisplay, currencySymbol, fmtPriceIn } from '../price/rates.js';
import { getPrefs } from '../prefs.js';
import { CardList, type CardItem } from '../components/CardViews.js';
import { CardSheet } from '../components/CardSheet.js';
import { ListSortControls, compareNullable, useListSort, type ListSortPrefs } from '../components/CardSorting.js';
import { useListFilter } from '../components/GlobalSearch.js';
import { useEntryMatcher } from '../db/useEntryMatcher.js';
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

/** Which of your lists a mover has to be on to show up. */
type ListFilter = 'all' | 'collection' | 'tradelist' | 'wishlist';
const LIST_OPTIONS: [ListFilter, string][] = [
  ['all', 'List: Any'],
  ['collection', 'List: In collection'],
  ['tradelist', 'List: On tradelist'],
  ['wishlist', 'List: On wishlist'],
];

type SectionKey = 'risers' | 'fallers' | 'steady' | 'swings';
const SECTION_OPTIONS: [SectionKey | 'all', string][] = [
  ['all', 'Show: Everything'],
  ['risers', 'Show: Risers'],
  ['fallers', 'Show: Fallers'],
  ['steady', 'Show: Steady trends'],
  ['swings', 'Show: Dips and spikes'],
];

// A 30% move on a bulk rare is still pocket change; this is the "only tell me
// about cards worth watching" dial.
const MIN_PRICES = [0, 1, 5, 20, 50];

type MoverSort = 'notable' | 'change' | 'changePct' | 'price' | 'name';
const SORT_OPTIONS: [MoverSort, string][] = [
  ['notable', 'Sort: Most notable'],
  ['change', 'Sort: Change'],
  ['changePct', 'Sort: Change %'],
  ['price', 'Sort: Price'],
  ['name', 'Sort: Name'],
];

interface Mover {
  scryfallId: string;
  stats: MoverStats | null;
  swing: SwingStats | null;
  printing?: Priced<Printing>;
  oracle?: Priced<OracleCard>;
  inCollection: boolean;
  onTradelist: boolean;
  onWishlist: boolean;
}

export function PriceMovers() {
  const [windowDays, setWindowDays] = useState(7);
  const [info, setInfo] = useState<Mover | null>(null);
  // Filters aren't persisted, for the same reason the collection's aren't: a
  // filter that hides rows shouldn't outlive the visit that set it.
  const [listFilter, setListFilter] = useState<ListFilter>('all');
  const [section, setSection] = useState<SectionKey | 'all'>('all');
  const [minPrice, setMinPrice] = useState(0);
  const [sort, setSort] = useListSort<MoverSort>('movers', { key: 'notable', dir: 'desc' });
  // Header search scoped to this page narrows the sections in place.
  const query = useListFilter('movers');

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
    const owned = new Set(entries.map((e) => e.scryfallId));
    const forTrade = new Set(entries.filter((e) => e.quantityForTrade > 0).map((e) => e.scryfallId));
    const wishedIds = new Set(wishes.map((w) => w.scryfallId).filter((id): id is string => id !== null));
    // An "any printing" wish covers every printing of its oracle (wishMatcher rule).
    const wishedOracles = new Set(wishes.filter((w) => !w.scryfallId).map((w) => w.oracleId));
    // Histories outlive ownership — a printing you once held keeps its recorded
    // days so the collection value chart can still draw them. This page is about
    // cards you hold or want, though: a mover you sold months ago is no news.
    const shown = movers
      .map((m): Mover => {
        const printing = printMap.get(m.scryfallId);
        return {
          ...m,
          printing,
          oracle: printing && oracleMap.get(printing.oracleId),
          inCollection: owned.has(m.scryfallId),
          onTradelist: forTrade.has(m.scryfallId),
          onWishlist: wishedIds.has(m.scryfallId) || (!!printing && wishedOracles.has(printing.oracleId)),
        };
      })
      .filter((m) => m.inCollection || m.onWishlist);
    return {
      tracked: histories.filter((h) => owned.has(h.scryfallId) || wishedIds.has(h.scryfallId)).length,
      movers: shown,
    };
  }, [windowDays]);

  // Scryfall-syntax filtering over the same rows, so `t:goblin` or `c:r` works
  // here exactly as it does on the collection.
  const matchRows = useMemo(
    () => (data?.movers ?? []).map((m) => ({ entry: { id: m.scryfallId }, oracle: m.oracle })),
    [data],
  );
  const matchesQuery = useEntryMatcher(matchRows, query);

  const { risers, fallers, steady, swings, count } = useMemo(() => {
    const all = (data?.movers ?? []).filter((m) => {
      if (!matchesQuery({ entry: { id: m.scryfallId }, oracle: m.oracle })) return false;
      if (listFilter === 'collection' && !m.inCollection) return false;
      if (listFilter === 'tradelist' && !m.onTradelist) return false;
      if (listFilter === 'wishlist' && !m.onWishlist) return false;
      return minPrice === 0 || (currentPrice(m) ?? 0) >= minPrice;
    });
    const big = all.filter((m) => m.stats?.substantial);
    const byScore = (m: Mover) => m.stats?.score ?? null;
    const sections = {
      risers: sortMovers(big.filter((m) => (m.stats?.delta ?? 0) > 0), sort, byScore, false),
      fallers: sortMovers(big.filter((m) => (m.stats?.delta ?? 0) < 0), sort, byScore, false),
      steady: sortMovers(all.filter((m) => m.stats?.trend), sort, (m) => m.stats?.trendR ?? null, false),
      swings: sortMovers(all.filter((m) => m.swing), sort, (m) => m.swing?.score ?? null, true),
    };
    // How many distinct cards the visible sections are actually reporting on —
    // a card can be both a riser and a spike, and counting it twice would lie.
    const visible = (Object.keys(sections) as SectionKey[]).filter((k) => section === 'all' || section === k);
    const ids = new Set(visible.flatMap((k) => sections[k].map((m) => m.scryfallId)));
    return { ...sections, count: ids.size };
  }, [data, matchesQuery, listFilter, minPrice, section, sort]);

  const symbol = currencySymbol(getPrefs().displayCurrency);
  const showing = (k: SectionKey) => section === 'all' || section === k;

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
            <select
              className={section === 'all' ? '' : 'filter-on'}
              value={section}
              onChange={(e) => setSection(e.target.value as SectionKey | 'all')}
              aria-label="Which sections to show"
            >
              {SECTION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              className={listFilter === 'all' ? '' : 'filter-on'}
              value={listFilter}
              onChange={(e) => setListFilter(e.target.value as ListFilter)}
              aria-label="Filter by which list the card is on"
            >
              {LIST_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              className={minPrice === 0 ? '' : 'filter-on'}
              value={String(minPrice)}
              onChange={(e) => setMinPrice(Number(e.target.value))}
              aria-label="Minimum card price"
              title="Hide cards cheaper than this, whichever way they moved"
            >
              {MIN_PRICES.map((p) => (
                <option key={p} value={String(p)}>
                  {p === 0 ? 'Price: Any' : `Price: ${symbol}${p}+`}
                </option>
              ))}
            </select>
          </div>

          <div className="meta-row">
            <p className="search-meta">
              {count} card{count === 1 ? '' : 's'}
            </p>
            <div className="meta-actions">
              <ListSortControls prefs={sort} onChange={setSort} options={SORT_OPTIONS} />
            </div>
          </div>

          {/* A section's own "no big risers in this window" would misread as a
              statement about the market when it's really the filters talking. */}
          {count === 0 && (query.trim() !== '' || listFilter !== 'all' || minPrice > 0) ? (
            <p className="search-meta">Nothing here matches.</p>
          ) : (
            <>
              {showing('risers') && (
                <MoverSection title="Risers" movers={risers} onOpen={setInfo} empty="No big risers in this window." />
              )}
              {showing('fallers') && (
                <MoverSection title="Fallers" movers={fallers} onOpen={setInfo} empty="No big fallers in this window." />
              )}
              {showing('steady') && (
                <MoverSection
                  title="Steady trends"
                  subtitle="Cards moving consistently in one direction since tracking began, even in small steps."
                  movers={steady}
                  onOpen={setInfo}
                  empty="No consistent trends yet. These need at least five readings."
                />
              )}
              {showing('swings') && (
                <MoverSection
                  title="Dips and spikes"
                  subtitle="Cards whose price swings within a range and currently sits near the low or high end of it."
                  movers={swings}
                  onOpen={setInfo}
                  empty="No cards at a dip or spike right now. These need a week or more of readings."
                  swing
                />
              )}
            </>
          )}
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
  return fmtPriceIn(v, cur);
}

// ---- Filtering and sorting ----
// Cards are quoted in whichever currency their history recorded, so every
// number the filters and sorts compare is normalised into the display currency
// first — otherwise a €5 threshold would quietly mean $5 for half the list.

function inDisplay(cur: 'eur' | 'usd', v: number): number {
  return convertToDisplay(v, cur === 'eur' ? 'EUR' : 'USD') ?? v;
}

/** The card's latest price, from whichever stats block recorded one. */
function currentPrice(m: Mover): number | null {
  if (m.stats) return inDisplay(m.stats.cur, m.stats.current);
  if (m.swing) return inDisplay(m.swing.cur, m.swing.current);
  return null;
}

/**
 * The value a sort key reads off a mover. Change is compared by magnitude: the
 * section a card sits in already carries the sign, so "biggest change" in
 * Fallers means the deepest drop, not the shallowest.
 */
function sortField(m: Mover, key: MoverSort, swing: boolean): number | null {
  if (swing) return key === 'price' && m.swing ? inDisplay(m.swing.cur, m.swing.current) : null;
  const s = m.stats;
  if (!s) return null;
  if (key === 'change') return Math.abs(inDisplay(s.cur, s.delta));
  if (key === 'changePct') return s.pct == null ? null : Math.abs(s.pct);
  if (key === 'price') return inDisplay(s.cur, s.current);
  return null;
}

/** `rank` is the section's own notion of notable: move score, trend strength
 *  or swing size. Everything else is a shared key; ties break on name. */
function sortMovers(
  movers: Mover[],
  prefs: ListSortPrefs<MoverSort>,
  rank: (m: Mover) => number | null,
  swing: boolean,
): Mover[] {
  const mul = prefs.dir === 'desc' ? -1 : 1;
  const value = (m: Mover) => (prefs.key === 'notable' ? rank(m) : sortField(m, prefs.key, swing));
  return [...movers].sort((a, b) => {
    let cmp = prefs.key === 'name' ? 0 : compareNullable(value(a), value(b), mul);
    if (cmp === 0) {
      cmp = (a.oracle?.name ?? '').localeCompare(b.oracle?.name ?? '');
      if (prefs.key === 'name') cmp *= mul;
    }
    return cmp;
  });
}
