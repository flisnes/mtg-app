import { useEffect, useState, type ReactNode } from 'react';
import { Icon } from './icons.js';
import { ManaCost } from './ManaCost.js';
import { useCardCursorCtx } from './useCardCursor.js';

// The one way cards are displayed anywhere in the app: a list of CardItems
// rendered as rows (CardList) or a tile grid (CardGrid), switched by the
// shared list⇄grid preference (localStorage, synchronous). Tapping a card
// opens whatever the caller wires up — usually the CardSheet.
//
// The collection's heap of cardboard (goblin mode, PileView.tsx) is NOT a third
// value here: goblin mode forces the pile and hides this toggle entirely, so it
// rides its own flag (CollectionListView's `pileMode`). The union used to carry
// a 'pile' member anyway, which every consumer then had to handle and none could
// ever receive — the hook coerced it away on the way out.

export type ViewMode = 'list' | 'grid';
const KEY = 'cardViewMode';

// Shared across every mounted instance: toggling the view in one place (e.g. the
// search overlay) must update the list behind it, not just until remount.
// Normalized on the way in, which also retires a stored legacy 'pile'.
function readMode(): ViewMode {
  try {
    return localStorage.getItem(KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
let currentMode: ViewMode = readMode();
const viewModeListeners = new Set<(m: ViewMode) => void>();

export function useViewMode(): [ViewMode, (m: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(currentMode);
  useEffect(() => {
    viewModeListeners.add(setMode);
    setMode(currentMode); // catch a change between first render and subscribe
    return () => {
      viewModeListeners.delete(setMode);
    };
  }, []);
  const set = (m: ViewMode) => {
    currentMode = m;
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* ignore */
    }
    viewModeListeners.forEach((cb) => cb(m));
  };
  return [mode, set];
}

export function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
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
  /** Small badge: after the name in list rows, first mark in the tile's
   *  bottom-left row on grid tiles. */
  badge?: ReactNode;
  badgeClass?: string;
  badgeTitle?: string;
  /** Where the card is filed (deck / binder / box). Sits after the primary
   *  badge in list rows and second in the tile's bottom-left mark row. */
  place?: { node: ReactNode; cls?: string; title?: string };
  /** Dim the entry (e.g. unowned deck cards). */
  dim?: boolean;
  /** Marked for a cut: still here, but on its way out as soon as it's pasted. */
  cut?: boolean;
  /** Iridescent foil sheen over the image (foil / etched finishes). */
  foil?: boolean;
  /** Custom thumbnail (list view only), replacing the default image — e.g. the
   *  stacked-cards glyph an edit-history batch entry shows. */
  thumb?: ReactNode;
  /** Open card info / edit. Rows and tiles are inert without it. */
  onClick?: () => void;
  /** Subtitle line, list view only (set, condition, …). */
  sub?: ReactNode;
  /** Mana cost (Scryfall braced string), rendered as pips in list rows. */
  mana?: string | null;
  /** Right-aligned price, list view only. */
  price?: string;
  /** Recent price movement marker: chart glyph by the price / last mark in the
   *  tile's bottom-left row. */
  trend?: 'up' | 'down';
  /** Action buttons: right edge of list rows, under the image on grid tiles. */
  actions?: ReactNode;
}

/**
 * Multi-select props, threaded identically through grid and list. When
 * `selectable` is on, tapping a row/tile toggles its selection (by CardItem.key)
 * instead of firing its onClick, per-item actions are hidden, and selected
 * entries paint a checkmark. Callers drive this with useMultiSelect.
 */
export interface SelectProps {
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onToggleSelect?: (key: string) => void;
}

export function CardItems({
  items,
  view,
  className,
  ...sel
}: { items: CardItem[]; view: ViewMode; className?: string } & SelectProps) {
  return view === 'grid' ? (
    <CardGrid items={items} className={className} {...sel} />
  ) : (
    <CardList items={items} className={className} {...sel} />
  );
}

export function CardList({
  items,
  className,
  selectable = false,
  selectedKeys,
  onToggleSelect,
}: { items: CardItem[]; className?: string } & SelectProps) {
  const cursor = useCardCursorCtx();
  return (
    <ul
      className={`result-list${className ? ` ${className}` : ''}`}
      onMouseLeave={cursor ? () => cursor.setActive(null) : undefined}
    >
      {items.map((it) => {
        const selected = selectable && !!selectedKeys?.has(it.key);
        const active = cursor?.activeKey === it.key;
        const body = (
          <>
            {selectable && (
              <span className={`select-box${selected ? ' checked' : ''}`} aria-hidden>
                {selected && <Icon name="check" size={14} />}
              </span>
            )}
            {it.thumb ? (
              it.thumb
            ) : it.image ? (
              <span className="result-thumb-wrap">
                <img className="result-thumb" src={it.image} alt="" loading="lazy" width={46} height={64} />
                {it.foil && <span className="foil-sheen" aria-hidden />}
              </span>
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
                {it.place && (
                  <span className={`badge ${it.place.cls ?? ''}`} title={it.place.title}>
                    {it.place.node}
                  </span>
                )}
              </div>
              {it.sub && <div className="result-sub">{it.sub}</div>}
            </div>
            {it.mana && <ManaCost cost={it.mana} className="result-mana" />}
            {it.trend && <TrendMark dir={it.trend} />}
            {it.price && <div className="result-price">{it.price}</div>}
            {it.count != null && it.count !== 1 && <div className="qty-pill">×{it.count}</div>}
          </>
        );
        return (
          <li
            key={it.key}
            {...(cursor ? { 'data-card-key': it.key } : {})}
            onMouseEnter={cursor ? () => cursor.setActive(it.key) : undefined}
            className={`result-row${it.dim ? ' result-row-dim' : ''}${it.cut ? ' card-cut' : ''}${active ? ' card-active' : ''}${selected ? ' selected' : ''}`}
          >
            {selectable ? (
              <button
                className="result-open"
                onClick={() => onToggleSelect?.(it.key)}
                aria-label={it.name}
                aria-pressed={selected}
              >
                {body}
              </button>
            ) : it.onClick ? (
              <button className="result-open" onClick={it.onClick} aria-label={it.name}>
                {body}
              </button>
            ) : (
              <div className="result-open">{body}</div>
            )}
            {!selectable && it.actions && <div className="quick-actions">{it.actions}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Overlapping card thumbnails for a grouped list entry (import / sealed /
 * trade in the edit history). Shows up to three images fanned out; falls back
 * to blank card shapes when images are missing.
 */
export function StackedThumb({ images }: { images: (string | null)[] }) {
  const shown = images.slice(0, 3);
  if (shown.length === 0) shown.push(null);
  return (
    <span className="stack-thumb" aria-hidden>
      {shown.map((src, i) =>
        src ? (
          <img key={i} className="stack-thumb-card" src={src} alt="" loading="lazy" style={{ zIndex: i }} />
        ) : (
          <span key={i} className="stack-thumb-card stack-thumb-ph" style={{ zIndex: i }} />
        ),
      )}
    </span>
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

export function CardGrid({
  items,
  className,
  selectable = false,
  selectedKeys,
  onToggleSelect,
}: { items: CardItem[]; className?: string } & SelectProps) {
  const cursor = useCardCursorCtx();
  return (
    <ul
      className={`card-grid${className ? ` ${className}` : ''}`}
      onMouseLeave={cursor ? () => cursor.setActive(null) : undefined}
    >
      {items.map((it) => {
        const selected = selectable && !!selectedKeys?.has(it.key);
        const active = cursor?.activeKey === it.key;
        return (
          <li
            key={it.key}
            {...(cursor ? { 'data-card-key': it.key } : {})}
            onMouseEnter={cursor ? () => cursor.setActive(it.key) : undefined}
            className={`card-tile${it.dim ? ' card-tile-dim' : ''}${it.cut ? ' card-cut' : ''}${active ? ' card-active' : ''}${selected ? ' selected' : ''}`}
          >
            <button
              className="card-tile-img"
              onClick={selectable ? () => onToggleSelect?.(it.key) : it.onClick}
              disabled={!selectable && !it.onClick}
              aria-label={it.name}
              aria-pressed={selectable ? selected : undefined}
            >
              {it.image ? (
                <img src={it.image} alt={it.name} loading="lazy" />
              ) : (
                <span className="card-tile-ph">{it.name}</span>
              )}
              {it.foil && it.image && <span className="foil-sheen" aria-hidden />}
              {/* Corner marks share one row along the bottom edge: owned, filed, trend. */}
              {(it.badge || it.place || it.trend) && (
                <span className="tile-marks">
                  {it.badge && (
                    <span className={`tile-badge ${it.badgeClass ?? ''}`} title={it.badgeTitle}>
                      {it.badge}
                    </span>
                  )}
                  {it.place && (
                    <span className={`tile-place ${it.place.cls ?? ''}`} title={it.place.title}>
                      {it.place.node}
                    </span>
                  )}
                  {it.trend && <TrendMark dir={it.trend} tile />}
                </span>
              )}
              {it.count != null && it.count !== 1 && <span className="tile-count">×{it.count}</span>}
              {selectable && (
                <span className={`tile-select${selected ? ' checked' : ''}`} aria-hidden>
                  {selected && <Icon name="check" size={16} />}
                </span>
              )}
            </button>
            {!selectable && it.actions && <div className="tile-footer">{it.actions}</div>}
          </li>
        );
      })}
    </ul>
  );
}
