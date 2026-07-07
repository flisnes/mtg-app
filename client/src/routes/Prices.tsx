import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router-dom';
import { Page, EmptyState } from './Page.js';
import { getWatchedRows, type WatchedRow } from '../price/tracking.js';
import { unwatchCard } from '../db/dataAccess.js';
import { Sparkline } from '../components/Sparkline.js';

function money(v: number | null, cur: 'eur' | 'usd'): string {
  if (v == null) return '—';
  return (cur === 'eur' ? '€' : '$') + v.toFixed(2);
}

function pricePoints(row: WatchedRow): { cur: 'eur' | 'usd'; series: number[] } {
  const last = row.snapshots[row.snapshots.length - 1];
  const cur: 'eur' | 'usd' = last && last.eur != null ? 'eur' : last && last.usd != null ? 'usd' : 'eur';
  const series = row.snapshots.map((s) => s[cur]).filter((v): v is number => v != null);
  return { cur, series };
}

export function Prices() {
  const rows = useLiveQuery(getWatchedRows, []);

  return (
    <Page title="Price tracker" subtitle="Cards you’re watching. Prices are recorded each time you open the app.">
      {rows === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState phase="tracking">
          You’re not tracking any cards yet. Open a card and tap “Watch price”, or track your whole collection from{' '}
          <Link to="/about">About</Link>.
        </EmptyState>
      ) : (
        <>
          <p className="search-meta">{rows.length} card{rows.length === 1 ? '' : 's'} tracked</p>
          <ul className="result-list">
            {rows.map((row) => {
              const { cur, series } = pricePoints(row);
              const current = series.length ? series[series.length - 1]! : null;
              const first = series.length ? series[0]! : null;
              const delta = current != null && first != null ? current - first : 0;
              const pct = first ? (delta / first) * 100 : 0;
              const dir = delta > 0.001 ? 'up' : delta < -0.001 ? 'down' : 'flat';
              return (
                <li key={row.watched.scryfallId} className="result-row">
                  <div className="result-open" style={{ cursor: 'default' }}>
                    {row.printing?.imageSmall ? (
                      <img className="result-thumb" src={row.printing.imageSmall} alt="" loading="lazy" width={46} height={64} />
                    ) : (
                      <div className="result-thumb" aria-hidden />
                    )}
                    <div className="result-main">
                      <div className="result-name">{row.oracle?.name ?? '(unknown card)'}</div>
                      <div className="result-sub">
                        {row.printing ? `${row.printing.setName} · #${row.printing.collectorNumber}` : ''}
                      </div>
                      <div className={`price-change price-${dir}`}>
                        {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {money(Math.abs(delta), cur)}
                        {first ? ` (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)` : ''}
                        <span className="fine-print"> · {series.length} pt{series.length === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                    <div className="price-now">
                      <Sparkline values={series} />
                      <div className="result-price">{money(current, cur)}</div>
                    </div>
                  </div>
                  <div className="quick-actions">
                    <button title="Stop watching" onClick={() => unwatchCard(row.watched.scryfallId)}>
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Page>
  );
}
