import { useState, type ReactNode } from 'react';
import { Icon } from './icons.js';

// The one way cards are displayed anywhere in the app: a list of CardItems
// rendered as rows (CardList) or a tile grid (CardGrid), switched by the
// shared list⇄grid preference (localStorage, synchronous). Tapping a card
// opens whatever the caller wires up — usually the CardSheet.

export type ViewMode = 'list' | 'grid';
const KEY = 'cardViewMode';

export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return (localStorage.getItem(KEY) as ViewMode) || 'grid';
    } catch {
      return 'grid';
    }
  });
  const set = (m: ViewMode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* ignore */
    }
  };
  return [mode, set];
}

export function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="View mode">
      <button
        className={mode === 'list' ? 'active' : ''}
        onClick={() => onChange('list')}
        aria-pressed={mode === 'list'}
        title="List view"
      >
        ☰
      </button>
      <button
        className={mode === 'grid' ? 'active' : ''}
        onClick={() => onChange('grid')}
        aria-pressed={mode === 'grid'}
        title="Grid view"
      >
        ▦
      </button>
    </div>
  );
}

export interface CardItem {
  key: string;
  name: string;
  image: string | null;
  /** Quantity: pill in list rows, corner badge on grid tiles. Hidden when exactly 1. */
  count?: number;
  /** Small badge: after the name in list rows, top-left on grid tiles. */
  badge?: ReactNode;
  badgeClass?: string;
  badgeTitle?: string;
  /** Dim the entry (e.g. unowned deck cards). */
  dim?: boolean;
  /** Open card info / edit. Rows and tiles are inert without it. */
  onClick?: () => void;
  /** Subtitle line, list view only (set, condition, …). */
  sub?: ReactNode;
  /** Right-aligned price, list view only. */
  price?: string;
  /** Recent price movement marker: chart glyph by the price / tile corner. */
  trend?: 'up' | 'down';
  /** Action buttons: right edge of list rows, under the image on grid tiles. */
  actions?: ReactNode;
}

export function CardItems({ items, view, className }: { items: CardItem[]; view: ViewMode; className?: string }) {
  return view === 'grid' ? <CardGrid items={items} className={className} /> : <CardList items={items} className={className} />;
}

export function CardList({ items, className }: { items: CardItem[]; className?: string }) {
  return (
    <ul className={`result-list${className ? ` ${className}` : ''}`}>
      {items.map((it) => {
        const body = (
          <>
            {it.image ? (
              <img className="result-thumb" src={it.image} alt="" loading="lazy" width={46} height={64} />
            ) : (
              <div className="result-thumb" aria-hidden />
            )}
            <div className="result-main">
              <div className="result-name">
                {it.name}
                {it.badge && (
                  <span className={`badge ${it.badgeClass ?? ''}`} title={it.badgeTitle}>
                    {it.badge}
                  </span>
                )}
              </div>
              {it.sub && <div className="result-sub">{it.sub}</div>}
            </div>
            {it.trend && <TrendMark dir={it.trend} />}
            {it.price && <div className="result-price">{it.price}</div>}
            {it.count != null && it.count !== 1 && <div className="qty-pill">×{it.count}</div>}
          </>
        );
        return (
          <li key={it.key} className={`result-row${it.dim ? ' result-row-dim' : ''}`}>
            {it.onClick ? (
              <button className="result-open" onClick={it.onClick} aria-label={it.name}>
                {body}
              </button>
            ) : (
              <div className="result-open">{body}</div>
            )}
            {it.actions && <div className="quick-actions">{it.actions}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** Green rising / red falling chart glyph for cards that moved in price. */
function TrendMark({ dir, tile = false }: { dir: 'up' | 'down'; tile?: boolean }) {
  return (
    <span
      className={`${tile ? 'tile-trend' : 'result-trend'} trend-${dir}`}
      title={dir === 'up' ? 'Price rising' : 'Price falling'}
    >
      <Icon name={dir === 'up' ? 'prices' : 'pricesDown'} size={tile ? 12 : 14} />
    </span>
  );
}

export function CardGrid({ items, className }: { items: CardItem[]; className?: string }) {
  return (
    <ul className={`card-grid${className ? ` ${className}` : ''}`}>
      {items.map((it) => (
        <li key={it.key} className={`card-tile${it.dim ? ' card-tile-dim' : ''}`}>
          <button className="card-tile-img" onClick={it.onClick} disabled={!it.onClick} aria-label={it.name}>
            {it.image ? (
              <img src={it.image} alt={it.name} loading="lazy" />
            ) : (
              <span className="card-tile-ph">{it.name}</span>
            )}
            {it.badge && (
              <span className={`tile-badge ${it.badgeClass ?? ''}`} title={it.badgeTitle}>
                {it.badge}
              </span>
            )}
            {it.count != null && it.count !== 1 && <span className="tile-count">×{it.count}</span>}
            {it.trend && <TrendMark dir={it.trend} tile />}
          </button>
          {it.actions && <div className="tile-footer">{it.actions}</div>}
        </li>
      ))}
    </ul>
  );
}
