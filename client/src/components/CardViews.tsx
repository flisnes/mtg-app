import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';
import { ManaCost } from './ManaCost.js';
import { NO_PRICE } from './cardSort.js';
import { useCardCursorCtx } from './useCardCursor.js';

// The one way cards are displayed anywhere in the app: a list of CardItems
// rendered as rows (CardList), a tile grid (CardGrid) or overlapping visual
// stacks (CardStacks), switched by whichever view preference the surface uses.
// Tapping a card opens whatever the caller wires up — usually the CardSheet.
//
// list⇄grid is the app-wide preference (useViewMode). Stacks are offered only
// where a tall column of cards has room beside it for their set and price — the
// trade board and the scan review list — so those two keep their own keys.
//
// The collection's heap of cardboard (goblin mode, PileView.tsx) is NOT a value
// here: goblin mode forces the pile and hides this toggle entirely, so it rides
// its own flag (CollectionListView's `pileMode`). The union used to carry a
// 'pile' member anyway, which every consumer then had to handle and none could
// ever receive — the hook coerced it away on the way out.

export type ViewMode = 'list' | 'grid' | 'stack';

/**
 * A view preference, shared across every mounted instance: toggling the view in
 * one place (e.g. the search overlay) must update the list behind it, not just
 * until remount. Anything stored that isn't offered here reads back as the
 * default, which is also how a legacy 'pile' was retired.
 */
function sharedPref<T>(key: string, parse: (stored: string | null) => T, serialize: (v: T) => string) {
  const read = (): T => {
    try {
      return parse(localStorage.getItem(key));
    } catch {
      return parse(null);
    }
  };
  let current = read();
  const listeners = new Set<(v: T) => void>();
  return function usePref(): [T, (v: T) => void] {
    const [value, setValue] = useState<T>(current);
    useEffect(() => {
      listeners.add(setValue);
      setValue(current); // catch a change between first render and subscribe
      return () => {
        listeners.delete(setValue);
      };
    }, []);
    const set = (v: T) => {
      current = v;
      try {
        localStorage.setItem(key, serialize(v));
      } catch {
        /* ignore */
      }
      listeners.forEach((cb) => cb(v));
    };
    return [value, set];
  };
}

function viewPref(key: string, allowed: readonly ViewMode[], dflt: ViewMode) {
  return sharedPref<ViewMode>(
    key,
    (stored) => (stored && allowed.includes(stored as ViewMode) ? (stored as ViewMode) : dflt),
    (v) => v,
  );
}

/** The app-wide list⇄grid preference, used by every card list that has one. */
export const useViewMode = viewPref('cardViewMode', ['list', 'grid'], 'grid');
/** The trade board's two offer columns: card tiles or visual stacks. */
export const useTradeViewMode = viewPref('tradeViewMode', ['grid', 'stack'], 'stack');
/** The scan session's review list: plain rows or visual stacks. */
export const useScanViewMode = viewPref('scanViewMode', ['list', 'stack'], 'stack');
/**
 * Stack printings: every copy of a card you own folds into one tile, whatever
 * edition, finish, condition or language it is, showing the total and the
 * edition your printing preference picks out of the ones you hold. App-wide
 * like list⇄grid, because "how do I count my cards" is one answer, not one per
 * screen. Off by default: the per-copy rows are what the app has always shown.
 */
export const useStackPrintings = sharedPref<boolean>(
  'stackPrintings',
  (stored) => stored === '1',
  (v) => (v ? '1' : '0'),
);

/** The stack-printings switch, sitting beside the view toggle. */
export function StackToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={`stack-toggle${on ? ' active' : ''}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      aria-label="Stack printings"
      title={on ? 'Stacking every printing of a card into one. Tap to show each copy.' : 'Show each copy. Tap to stack every printing of a card into one.'}
    >
      <Icon name="stack" size={16} />
    </button>
  );
}

const VIEW_LABELS: Record<ViewMode, { icon: IconName; title: string }> = {
  list: { icon: 'list', title: 'List view' },
  grid: { icon: 'grid', title: 'Grid view' },
  stack: { icon: 'piles', title: 'Visual stacks' },
};

export function ViewToggle({
  mode,
  onChange,
  options = ['list', 'grid'],
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
  /** Which views this surface offers, in order. */
  options?: readonly ViewMode[];
}) {
  return (
    <div className="view-toggle" role="group" aria-label="View mode">
      {options.map((opt) => (
        <button
          key={opt}
          className={mode === opt ? 'active' : ''}
          onClick={() => onChange(opt)}
          aria-pressed={mode === opt}
          title={VIEW_LABELS[opt].title}
          aria-label={VIEW_LABELS[opt].title}
        >
          <Icon name={VIEW_LABELS[opt].icon} size={16} />
        </button>
      ))}
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
  /** The "A" mark of a copy with special conditions (altered, signed, …), in
   *  the same two places, after the filing badge. */
  special?: { node: ReactNode; cls?: string; title?: string };
  /** A flag, when the copy isn't in the language you collect in. Last of the
   *  marks: the rest are about you, this one is about the cardboard. */
  lang?: { node: ReactNode; cls?: string; title?: string };
  /** Release year, shown only while the list is sorted by release date — a grid
   *  tile is all art, so the thing being sorted on has to be visible somewhere
   *  or the order reads as random. Sits with the other cardboard marks. */
  year?: { node: ReactNode; title?: string };
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
  /** Subtitle line (set, condition, …). Beside the card in stacks, under the
   *  name in list rows; grid tiles have no room for it. */
  sub?: ReactNode;
  /** Mana cost (Scryfall braced string), rendered as pips in list rows. */
  mana?: string | null;
  /** Right-aligned price, in list rows and beside a stacked card. */
  price?: string;
  /** Recent price movement marker: chart glyph by the price / last mark in the
   *  tile's bottom-left row. */
  trend?: 'up' | 'down';
  /** Action buttons: right edge of list rows, under the image on grid tiles,
   *  in the panel beside an expanded stacked card. */
  actions?: ReactNode;
  /** Interactive strip hugging the card's right edge (grid) or sitting with the
   *  actions (list) — the choose-a-color commander's mana pips. Its own slot
   *  because it must be clickable, and the tile image is already one button. */
  sideStrip?: ReactNode;
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
  gridRef,
  ...sel
}: {
  items: CardItem[];
  view: ViewMode;
  className?: string;
  /** Handed to the grid so a paged caller can measure its column count. */
  gridRef?: (el: HTMLUListElement | null) => void;
} & SelectProps) {
  if (view === 'grid') return <CardGrid items={items} className={className} gridRef={gridRef} {...sel} />;
  if (view === 'stack') return <CardStacks items={items} className={className} {...sel} />;
  return <CardList items={items} className={className} {...sel} />;
}

/**
 * Stand-ins for cards whose display data is still coming out of IndexedDB. A
 * blank screen with the word "Loading" on it reads as an empty collection; a
 * grid of card-shaped placeholders reads as a grid that hasn't painted yet,
 * which is the truth. Sized and spaced exactly like the real thing so nothing
 * jumps when the cards land.
 */
export function CardItemsSkeleton({ view, count }: { view: ViewMode; count: number }) {
  const keys = Array.from({ length: Math.max(1, count) }, (_, i) => i);
  if (view === 'list' || view === 'stack') {
    return (
      <ul className="result-list" aria-busy="true" aria-label="Loading cards">
        {keys.map((k) => (
          <li key={k} className="result-row skeleton-row">
            <span className="result-thumb skeleton-block" aria-hidden />
            <span className="skeleton-lines" aria-hidden>
              <span className="skeleton-block skeleton-line" />
              <span className="skeleton-block skeleton-line skeleton-line-short" />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="card-grid" aria-busy="true" aria-label="Loading cards">
      {keys.map((k) => (
        <li key={k} className="card-tile">
          <span className="card-tile-img skeleton-block" aria-hidden />
        </li>
      ))}
    </ul>
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
            {/* The name gets line 1 to itself and is the only thing the ellipsis
                may cut: badges sit beside it, not inside it, and the pips go
                down to line 2 where they used to squeeze the name to "Atrax…". */}
            <div className="result-main">
              <div className="result-title">
                <span className="result-name">{it.name}</span>
                <RowBadges it={it} />
              </div>
              {(it.mana || it.sub) && (
                <div className="result-meta">
                  {it.mana && <ManaCost cost={it.mana} className="result-mana" />}
                  {it.sub && <span className="result-sub">{it.sub}</span>}
                </div>
              )}
            </div>
            {/* Price over count, one narrow column, so the name and set get the width. */}
            {(it.trend || it.price || (it.count != null && it.count !== 1)) && (
              <div className="result-end">
                {(it.trend || it.price) && (
                  <span className="result-end-price">
                    {it.trend && <TrendMark dir={it.trend} />}
                    {it.price && <PriceText price={it.price} className="result-price" />}
                  </span>
                )}
                {it.count != null && it.count !== 1 && <span className="qty-pill">×{it.count}</span>}
              </div>
            )}
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
            {!selectable && (it.actions || it.sideStrip) && (
              <div className="quick-actions">
                {it.sideStrip}
                {it.actions}
              </div>
            )}
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

/** The per-copy marks beside a row's name (list) or along a stack's side line. */
function RowBadges({ it }: { it: CardItem }) {
  return (
    <>
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
      {it.special && (
        <span className={`badge ${it.special.cls ?? ''}`} title={it.special.title}>
          {it.special.node}
        </span>
      )}
      {it.lang && (
        <span className={`badge ${it.lang.cls ?? ''}`} title={it.lang.title}>
          {it.lang.node}
        </span>
      )}
      {it.year && (
        <span className="badge badge-year" title={it.year.title}>
          {it.year.node}
        </span>
      )}
    </>
  );
}

/** A row's price, or a muted "no price" where a bare dash used to leave you guessing. */
function PriceText({ price, className }: { price: string; className: string }) {
  if (price === NO_PRICE) return <span className={`${className} price-none`}>no price</span>;
  return <span className={className}>{price}</span>;
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

/**
 * Visual stacks: the cards overlap down the column so only each one's title bar
 * — name and mana cost — shows, which leaves the room beside them for the set
 * and the price. Tapping a card slides the rest of it into view, together with
 * its details and whatever actions the caller hung on it; tapping it again (or
 * opening another) puts it back on the pile.
 *
 * One card is expanded at a time. Two open cards push everything below them so
 * far down that the stack stops being the compact thing it is here for.
 */
export function CardStacks({
  items,
  className,
  selectable = false,
  selectedKeys,
  onToggleSelect,
}: { items: CardItem[]; className?: string } & SelectProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <ul className={`card-stacks${className ? ` ${className}` : ''}`}>
      {items.map((it) => {
        const selected = selectable && !!selectedKeys?.has(it.key);
        // Selecting and expanding both want the same tap, so select mode wins
        // and the stack stays flat while a bulk action is being lined up.
        const open = !selectable && openKey === it.key;
        return (
          <li
            key={it.key}
            className={`stack-item${open ? ' stack-open' : ''}${it.dim ? ' stack-dim' : ''}${it.cut ? ' card-cut' : ''}${selected ? ' selected' : ''}`}
          >
            <button
              className="stack-card"
              onClick={() => (selectable ? onToggleSelect?.(it.key) : setOpenKey(open ? null : it.key))}
              aria-label={it.name}
              aria-expanded={selectable ? undefined : open}
              aria-pressed={selectable ? selected : undefined}
            >
              {it.image ? (
                <img src={it.image} alt="" loading="lazy" />
              ) : (
                <span className="stack-ph">{it.name}</span>
              )}
              {it.foil && it.image && <span className="foil-sheen" aria-hidden />}
              {selectable && (
                <span className={`tile-select${selected ? ' checked' : ''}`} aria-hidden>
                  {selected && <Icon name="check" size={16} />}
                </span>
              )}
            </button>
            <div className="stack-side">
              <div className="stack-line">
                <RowBadges it={it} />
                {it.sub && <span className="stack-sub">{it.sub}</span>}
                {it.count != null && it.count !== 1 && <span className="stack-qty">×{it.count}</span>}
                {it.trend && <TrendMark dir={it.trend} />}
                {it.price && <PriceText price={it.price} className="stack-price" />}
              </div>
              {open && (
                <div className="stack-more">
                  {it.actions && <div className="stack-actions">{it.actions}</div>}
                  {it.onClick && (
                    <button className="chip stack-details" onClick={it.onClick}>
                      Details
                    </button>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function CardGrid({
  items,
  className,
  gridRef,
  selectable = false,
  selectedKeys,
  onToggleSelect,
}: {
  items: CardItem[];
  className?: string;
  gridRef?: (el: HTMLUListElement | null) => void;
} & SelectProps) {
  const cursor = useCardCursorCtx();
  return (
    <ul
      ref={gridRef}
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
              {/* Corner marks share one row along the bottom edge: owned, filed,
                  special conditions, language, release year, trend. */}
              {(it.badge || it.place || it.special || it.lang || it.year || it.trend) && (
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
                  {it.special && (
                    <span className={`tile-badge ${it.special.cls ?? ''}`} title={it.special.title}>
                      {it.special.node}
                    </span>
                  )}
                  {it.lang && (
                    <span className={`tile-badge ${it.lang.cls ?? ''}`} title={it.lang.title}>
                      {it.lang.node}
                    </span>
                  )}
                  {it.year && (
                    <span className="tile-badge badge-year" title={it.year.title}>
                      {it.year.node}
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
            {/* Outside the tile button — its pips are buttons of their own. */}
            {!selectable && it.sideStrip && <div className="tile-side-strip">{it.sideStrip}</div>}
            {!selectable && it.actions && <div className="tile-footer">{it.actions}</div>}
          </li>
        );
      })}
    </ul>
  );
}

// How many cards fit across the grid right now. The template is
// `repeat(auto-fill, minmax(…, 1fr))`, so only the browser knows the answer:
// read it back off the resolved style and re-read it whenever the grid resizes.
//
// Paging uses this to load whole rows. A page of 60 on a 7-wide grid leaves a
// half-empty last row hanging, which reads as "that's all there is" and stops
// people scrolling for the rest. Zero (list view, or nothing rendered yet)
// means "don't round".
export function useGridColumns(): {
  gridRef: (el: HTMLUListElement | null) => void;
  columns: number;
} {
  const [grid, setGrid] = useState<HTMLUListElement | null>(null);
  const [columns, setColumns] = useState(0);
  const gridRef = useCallback((el: HTMLUListElement | null) => setGrid(el), []);

  useEffect(() => {
    if (!grid) {
      setColumns(0);
      return;
    }
    const measure = () => {
      const template = getComputedStyle(grid).gridTemplateColumns;
      // `none` is the horizontal card-row variant; it has no columns to count.
      setColumns(!template || template === 'none' ? 0 : template.split(' ').filter(Boolean).length);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [grid]);

  return { gridRef, columns };
}
