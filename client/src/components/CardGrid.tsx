import { useState, type ReactNode } from 'react';

// Shared card-grid display used by collection / lists / decks, plus the
// list⇄grid toggle. View mode is a UI preference (localStorage, synchronous)
// shared across views.

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

export interface GridItem {
  key: string;
  name: string;
  image: string | null;
  /** Quantity badge shown in the bottom-right corner. */
  count?: number;
  /** Small badge top-left (e.g. an owned check or "FT"). */
  badge?: string;
  badgeClass?: string;
  /** Dim the tile (e.g. unowned deck cards). */
  dim?: boolean;
  onClick?: () => void;
  /** Optional controls under the image (steppers etc.). */
  footer?: ReactNode;
}

export function CardGrid({ items }: { items: GridItem[] }) {
  return (
    <ul className="card-grid">
      {items.map((it) => (
        <li key={it.key} className={`card-tile${it.dim ? ' card-tile-dim' : ''}`}>
          <button className="card-tile-img" onClick={it.onClick} disabled={!it.onClick} aria-label={it.name}>
            {it.image ? (
              <img src={it.image} alt={it.name} loading="lazy" />
            ) : (
              <span className="card-tile-ph">{it.name}</span>
            )}
            {it.badge && <span className={`tile-badge ${it.badgeClass ?? ''}`}>{it.badge}</span>}
            {it.count != null && <span className="tile-count">×{it.count}</span>}
          </button>
          {it.footer && <div className="tile-footer">{it.footer}</div>}
        </li>
      ))}
    </ul>
  );
}
