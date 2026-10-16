import { useEffect, useMemo, useState } from 'react';
import { FilterSelect } from '../components/FilterSelect.js';
import { useLiveQuery } from 'dexie-react-hooks';
import type { SealedItem, SealedPriceMap, SealedProduct } from '@mtg/shared';
import { db } from '../db/schema.js';
import { removeSealedItem, setSealedItemQuantity } from '../db/dataAccess.js';
import { loadSealedProducts } from '../sealed/store.js';
import { SealedImage } from '../sealed/SealedImage.js';
import { SealedItemSheet } from '../sealed/SealedItemSheet.js';
import { OpenSealedSheet } from '../sealed/OpenSealedSheet.js';
import { SealedValueChartSheet } from '../components/ChartSheetsLazy.js';
import { categoryLabel, fmtSealedPrice, isRandomOnly, itemImage, sealedPriceOf } from '../sealed/product.js';
import { AddSealedProductSheet } from '../components/AddSealedProductSheet.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { ListSortControls, priceValue, sortRows, useListSort } from '../components/CardSorting.js';
import { ViewToggle, useViewMode, type ViewMode } from '../components/CardViews.js';
import { Icon } from '../components/icons.js';
import { HeaderValue, headerValue, useSealedValue } from '../components/ValueSummary.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { historyChange } from '../price/history.js';
import { useSealedHistories } from '../price/sealedValue.js';
import { EmptyState, Page } from './Page.js';
import { useAsyncAction } from '../components/useAsyncAction.js';
import { fmtCardCount } from '../util/format.js';
import { sumQty } from '../util/groupBy.js';
import { Loading } from '../components/Loading.js';
import { QtyStepper } from '../components/QtyStepper.js';

// The sealed shelf: unopened boxes, displays, packs and precons. Deliberately
// its own view rather than a section of the collection — these rows have no
// oracleId, so none of the collection's search, sorting, price history or
// mover machinery applies to them.
//
// Value tracking is the shelf's own (price/sealedTracking.ts): daily readings
// per product id, which is what the change sorts, the trend marks and the value
// chart behind the header total all read.

type SealedSort = 'name' | 'price' | 'value' | 'change' | 'changePct' | 'copies' | 'set' | 'released' | 'added';
const SORT_OPTIONS: [SealedSort, string][] = [
  ['name', 'Name'],
  ['price', 'Price each'],
  ['value', 'Total value'],
  ['change', 'Price change'],
  ['changePct', 'Price change %'],
  ['copies', 'Copies'],
  ['set', 'Set'],
  ['released', 'Release date'],
  ['added', 'Date added'],
];

type PriceFilter = 'all' | 'priced' | 'unpriced';
const PRICE_OPTIONS: [PriceFilter, string][] = [
  ['all', 'Price: Any'],
  ['priced', 'Price: Priced'],
  ['unpriced', 'Price: Unpriced'],
];

/** Recorded movement of one product, in its own quoted currency. */
interface Change {
  delta: number;
  pct: number | null;
}

export function SealedProducts() {
  const items = useLiveQuery(() => db.sealedItems.toArray(), []);
  const [prices, setPrices] = useState<SealedPriceMap>({});
  // Catalog rows for what you own, keyed by product id: category and release
  // date live there, not on the owned row.
  const [catalog, setCatalog] = useState<Map<string, SealedProduct>>(new Map());
  const [adding, setAdding] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [openItem, setOpenItem] = useState<string | null>(null);
  // Cracking a box snapshots the row it started from: the shelf count drops
  // (and at zero the row is deleted) while the filing prompt is still open, so
  // this can't be an id looked up in the live list.
  const [cracking, setCracking] = useState<{ item: SealedItem; product: SealedProduct } | null>(null);
  const { confirm, sheet: confirmSheet } = useConfirm();
  const [sort, setSort] = useListSort<SealedSort>('sealed', { key: 'name', dir: 'asc' });
  const [view, setView] = useViewMode();
  const [nameFilter, setNameFilter] = useState('');
  const [setFilter, setSetFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all');

  // Prices ride with the sealed catalog artifact; owning an item doesn't
  // require the catalog to be installed, so this is best-effort decoration.
  useEffect(() => {
    let cancelled = false;
    void loadSealedProducts().then((r) => {
      if (cancelled || r.kind !== 'ready') return;
      setPrices(r.prices);
      setCatalog(new Map(r.products.map((p) => [p.id, p])));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // One row per product, so unlike the collection's histories this table is
  // small enough to read whether or not a change sort is active — the trend
  // marks want it either way.
  const histories = useSealedHistories();
  const changes = useMemo(() => {
    const m = new Map<string, Change>();
    for (const [productId, h] of histories ?? []) {
      const c = historyChange(h);
      if (c) m.set(productId, { delta: c.delta, pct: c.pct });
    }
    return m;
  }, [histories]);

  // The same total the collection header folds in, so the two never disagree.
  const value = useSealedValue();
  const unpriced = value?.unpriced ?? 0;

  // Only what's actually on the shelf gets an option — a set list of every
  // Magic set would be a scroll, and every entry but a handful would be empty.
  const { sets, categories } = useMemo(() => {
    const sets = new Map<string, string>();
    const categories = new Set<string>();
    for (const item of items ?? []) {
      sets.set(item.set, item.setName ?? item.set.toUpperCase());
      const category = catalog.get(item.productId)?.category;
      if (category) categories.add(category);
    }
    return {
      sets: [...sets].sort((a, b) => a[1].localeCompare(b[1])),
      categories: [...categories].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b))),
    };
  }, [items, catalog]);

  const sorted = useMemo(() => {
    if (!items) return undefined;
    const needle = nameFilter.trim().toLowerCase();
    const kept = items.filter((item) => {
      if (needle && !item.name.toLowerCase().includes(needle)) return false;
      if (setFilter !== 'all' && item.set !== setFilter) return false;
      if (categoryFilter !== 'all' && catalog.get(item.productId)?.category !== categoryFilter) return false;
      if (priceFilter === 'all') return true;
      const priced = !!sealedPriceOf(prices, item.productId);
      return priceFilter === 'priced' ? priced : !priced;
    });
    return sortSealed(kept, sort, prices, catalog, changes);
  }, [items, nameFilter, setFilter, categoryFilter, priceFilter, sort, prices, catalog, changes]);

  const boxes = sumQty(sorted ?? []);
  const filtering = !!nameFilter.trim() || setFilter !== 'all' || categoryFilter !== 'all' || priceFilter !== 'all';
  // From the unfiltered rows on purpose: narrowing the list while a product's
  // sheet is open shouldn't yank it out from under the reader.
  const shown = openItem ? (items ?? []).find((i) => i.id === openItem) : undefined;
  const shownProduct = shown ? catalog.get(shown.productId) : undefined;

  const onRemove = async (item: SealedItem) => {
    const ok = await confirm({
      title: `Remove ${item.name}?`,
      body: `All ${item.quantity} unopened cop${item.quantity === 1 ? 'y' : 'ies'} will be removed.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) {
      setOpenItem(null);
      await removeSealedItem(item.id);
    }
  };

  return (
    <Page
      title="Sealed products"
      subtitle="Unopened boxes, packs and precons you own."
      aside={
        <HeaderValue
          label="Sealed value"
          value={headerValue(value?.total)}
          note={unpriced > 0 ? `${unpriced} unpriced` : undefined}
          onClick={() => setChartOpen(true)}
          title="Open the sealed value chart"
        />
      }
      menu={
        <OptionsMenu
          label="Sealed options"
          actions={[{ label: 'Add sealed product', icon: 'sealed', onClick: () => setAdding(true) }]}
        />
      }
    >
      {sorted === undefined || items === undefined ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState hint="Booster boxes, displays, bundles and precons still in shrink live here.">
          Nothing sealed yet.{' '}
          <button className="linklike" onClick={() => setAdding(true)}>
            Add a sealed product
          </button>
          .
        </EmptyState>
      ) : (
        <>
          <div className="filter-row">
            <input
              type="search"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              placeholder="Filter by name…"
              aria-label="Filter sealed products by name"
            />
            {sets.length > 1 && (
              <FilterSelect
                value={setFilter}
                onChange={setSetFilter}
                neutral="all"
                options={[['all', 'Set: Any'], ...sets.map(([code, name]) => [code, `Set: ${name}`] as const)]}
                label="Filter by set"
              />
            )}
            {categories.length > 1 && (
              <FilterSelect
                value={categoryFilter}
                onChange={setCategoryFilter}
                neutral="all"
                options={[['all', 'Type: Any'], ...categories.map((c) => [c, `Type: ${categoryLabel(c)}`] as const)]}
                label="Filter by product type"
              />
            )}
            <FilterSelect
              value={priceFilter}
              onChange={setPriceFilter}
              neutral="all"
              options={PRICE_OPTIONS}
              label="Filter by whether a market price is known"
            />
          </div>

          <div className="meta-row">
            <p className="search-meta">
              {fmtCardCount(boxes, sorted.length, ['product', 'products'])}
              {filtering && ` (filtered from ${items.length})`}
            </p>
            <div className="meta-actions">
              <ListSortControls prefs={sort} onChange={setSort} options={SORT_OPTIONS} />
              <ViewToggle mode={view} onChange={setView} />
            </div>
          </div>
          {sorted.length === 0 && <p className="search-meta">Nothing here matches.</p>}
          <SealedShelf
            items={sorted}
            view={view}
            prices={prices}
            catalog={catalog}
            changes={changes}
            onOpen={(item) => setOpenItem(item.id)}
            onRemove={(item) => void onRemove(item)}
          />
          {unpriced > 0 && (
            <p className="fine-print">
              {unpriced === 1
                ? '1 product has no market price and isn’t counted in the total.'
                : `${unpriced} products have no market price and aren’t counted in the total.`}
            </p>
          )}
        </>
      )}

      {adding && <AddSealedProductSheet onClose={() => setAdding(false)} />}
      {chartOpen && <SealedValueChartSheet onClose={() => setChartOpen(false)} />}
      {shown && (
        <SealedItemSheet
          item={shown}
          product={catalog.get(shown.productId)}
          price={sealedPriceOf(prices, shown.productId)}
          onOpenIt={
            shownProduct && !isRandomOnly(shownProduct)
              ? () => {
                  setCracking({ item: shown, product: shownProduct });
                  setOpenItem(null);
                }
              : null
          }
          onRemove={() => void onRemove(shown)}
          onClose={() => setOpenItem(null)}
        />
      )}
      {cracking && (
        <OpenSealedSheet item={cracking.item} product={cracking.product} onClose={() => setCracking(null)} />
      )}
      {confirmSheet}
    </Page>
  );
}

/** Green rising / red falling glyph for a product whose recorded price moved. */
function TrendMark({ change }: { change: Change | undefined }) {
  if (!change || Math.abs(change.delta) < 0.005) return null;
  const dir = change.delta > 0 ? 'up' : 'down';
  return (
    <span className={`sealed-trend trend-${dir}`} title={dir === 'up' ? 'Price rising' : 'Price falling'}>
      <Icon name={dir === 'up' ? 'prices' : 'pricesDown'} size={12} />
      {change.pct != null && ` ${change.pct >= 0 ? '+' : '−'}${Math.abs(change.pct).toFixed(1)}%`}
    </span>
  );
}

/** The shelf itself, as rows or as box shots. */
function SealedShelf({
  items,
  view,
  prices,
  catalog,
  changes,
  onOpen,
  onRemove,
}: {
  items: SealedItem[];
  view: ViewMode;
  prices: SealedPriceMap;
  catalog: Map<string, SealedProduct>;
  changes: Map<string, Change>;
  onOpen: (item: SealedItem) => void;
  onRemove: (item: SealedItem) => void;
}) {
  const action = useAsyncAction();
  if (view === 'grid') {
    return (
      <ul className="sealed-grid">
        {items.map((item) => {
          const priceText = fmtSealedPrice(sealedPriceOf(prices, item.productId));
          return (
            <li key={item.id} className="sealed-tile">
              <button className="sealed-tile-img" onClick={() => onOpen(item)} aria-label={item.name}>
                <SealedImage url={itemImage(item, 'thumb')} alt="" />
                {item.quantity !== 1 && <span className="tile-count">×{item.quantity}</span>}
              </button>
              <span className="sealed-tile-name" title={item.name}>
                {item.name}
              </span>
              <span className="sealed-tile-sub">
                {priceText ?? '—'}
                <TrendMark change={changes.get(item.productId)} />
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <ul className="sealed-owned">
      {items.map((item) => {
        const priceText = fmtSealedPrice(sealedPriceOf(prices, item.productId));
        const category = catalog.get(item.productId)?.category;
        return (
          <li key={item.id} className="sealed-owned-row">
            <button className="sealed-owned-open" onClick={() => onOpen(item)} aria-label={item.name}>
              <SealedImage url={itemImage(item, 'thumb')} alt="" className="sealed-shot-sm" />
              <span className="sealed-owned-text">
                <span className="sealed-result-name">{item.name}</span>
                <span className="sealed-result-sub">
                  {item.setName ?? item.set.toUpperCase()}
                  {category ? ` · ${categoryLabel(category)}` : ''}
                  {priceText ? ` · ${priceText} each` : ''}
                  <TrendMark change={changes.get(item.productId)} />
                </span>
              </span>
            </button>
            <div className="sealed-owned-qty">
              <QtyStepper
                compact
                value={item.quantity}
                min={0}
                max={9999}
                onChange={(v) => action.run('change the count', () => setSealedItemQuantity(item.id, v))}
                label={item.name}
              />
            </div>
            <button className="linklike sealed-owned-remove" onClick={() => onRemove(item)}>
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Sort the shelf. Money is normalised into the display currency (the two
 * markets disagree on sealed, and half the shelf may only be quoted in one of
 * them), and anything the catalog can't answer for — a release date for a
 * product that isn't installed, a change for one tracked since yesterday —
 * sorts last rather than first.
 */
function sortSealed(
  items: SealedItem[],
  prefs: { key: SealedSort; dir: 'asc' | 'desc' },
  prices: SealedPriceMap,
  catalog: Map<string, SealedProduct>,
  changes: Map<string, Change>,
): SealedItem[] {
  const each = (i: SealedItem) => priceValue(sealedPriceOf(prices, i.productId));
  return sortRows(
    items,
    prefs,
    (i, key) => {
      switch (key) {
        case 'price':
          return each(i);
        case 'value': {
          const p = each(i);
          return p == null ? null : p * i.quantity;
        }
        case 'change':
          return changes.get(i.productId)?.delta ?? null;
        case 'changePct':
          return changes.get(i.productId)?.pct ?? null;
        case 'copies':
          return i.quantity;
        case 'added':
          return i.createdAt;
        case 'set':
          return i.setName ?? i.set;
        case 'released':
          return catalog.get(i.productId)?.releaseDate ?? null;
        default:
          return null;
      }
    },
    (i) => i.name,
  );
}
