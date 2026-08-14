import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { SealedItem, SealedPriceMap } from '@mtg/shared';
import { db } from '../db/schema.js';
import { removeSealedItem, setSealedItemQuantity } from '../db/dataAccess.js';
import { loadSealedProducts } from '../sealed/store.js';
import { SealedImage } from '../sealed/SealedImage.js';
import { fmtSealedPrice, itemImage, sealedPrice } from '../sealed/product.js';
import { AddSealedProductSheet } from '../components/AddSealedProductSheet.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { HeaderValue } from '../components/ValueSummary.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { EmptyState, Page } from './Page.js';

// The sealed shelf: unopened boxes, displays, packs and precons. Deliberately
// its own view rather than a section of the collection — these rows have no
// oracleId, so none of the collection's search, sorting, price history or
// mover machinery applies to them.

export function SealedProducts() {
  const items = useLiveQuery(() => db.sealedItems.toArray(), []);
  const [prices, setPrices] = useState<SealedPriceMap>({});
  const [adding, setAdding] = useState(false);
  const { confirm, sheet: confirmSheet } = useConfirm();

  // Prices ride with the sealed catalog artifact; owning an item doesn't
  // require the catalog to be installed, so this is best-effort decoration.
  useEffect(() => {
    let cancelled = false;
    void loadSealedProducts().then((r) => {
      if (!cancelled && r.kind === 'ready') setPrices(r.prices);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = items
    ? [...items].sort((a, b) => a.name.localeCompare(b.name))
    : undefined;

  let total = 0;
  let unpriced = 0;
  for (const item of sorted ?? []) {
    const price = sealedPrice(prices, item.tcgplayerId);
    if (price == null) unpriced += item.quantity;
    else total += price * item.quantity;
  }
  const boxes = (sorted ?? []).reduce((s, i) => s + i.quantity, 0);

  const onRemove = async (item: SealedItem) => {
    const ok = await confirm({
      title: `Remove ${item.name}?`,
      body: `All ${item.quantity} unopened cop${item.quantity === 1 ? 'y' : 'ies'} will be removed.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) await removeSealedItem(item.id);
  };

  return (
    <Page
      title="Sealed products"
      subtitle="Unopened boxes, packs and precons you own."
      aside={
        <HeaderValue
          label="Sealed value"
          value={total > 0 ? fmtSealedPrice(total) : undefined}
          note={unpriced > 0 ? `${unpriced} unpriced` : undefined}
          title="TCGplayer market price, in USD"
        />
      }
      menu={
        <OptionsMenu
          label="Sealed options"
          actions={[{ label: 'Add sealed product', icon: 'sealed', onClick: () => setAdding(true) }]}
        />
      }
    >
      {sorted === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : sorted.length === 0 ? (
        <EmptyState hint="Booster boxes, displays, bundles and precons still in shrink live here.">
          Nothing sealed yet.{' '}
          <button className="linklike" onClick={() => setAdding(true)}>
            Add a sealed product
          </button>
          .
        </EmptyState>
      ) : (
        <>
          <div className="meta-row">
            <p className="search-meta">
              {boxes} product{boxes === 1 ? '' : 's'} across {sorted.length} line{sorted.length === 1 ? '' : 's'}
            </p>
          </div>
          <ul className="sealed-owned">
            {sorted.map((item) => {
              const price = sealedPrice(prices, item.tcgplayerId);
              return (
                <li key={item.id} className="sealed-owned-row">
                  <SealedImage url={itemImage(item, 'thumb')} alt="" className="sealed-shot-sm" />
                  <div className="sealed-owned-text">
                    <span className="sealed-result-name">{item.name}</span>
                    <span className="sealed-result-sub">
                      {item.setName ?? item.set.toUpperCase()}
                      {price != null ? ` · ${fmtSealedPrice(price)} each` : ''}
                    </span>
                  </div>
                  <div className="sealed-owned-qty">
                    <button
                      onClick={() => void setSealedItemQuantity(item.id, item.quantity - 1)}
                      aria-label={`One fewer ${item.name}`}
                    >
                      −
                    </button>
                    <span className="sealed-copies-n">{item.quantity}</span>
                    <button
                      onClick={() => void setSealedItemQuantity(item.id, item.quantity + 1)}
                      aria-label={`One more ${item.name}`}
                      disabled={item.quantity >= 9999}
                    >
                      +
                    </button>
                  </div>
                  <button className="linklike sealed-owned-remove" onClick={() => void onRemove(item)}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
          {unpriced > 0 && (
            <p className="fine-print">
              {unpriced === 1
                ? '1 product has no TCGplayer market price and isn’t counted in the total.'
                : `${unpriced} products have no TCGplayer market price and aren’t counted in the total.`}
            </p>
          )}
        </>
      )}

      {adding && <AddSealedProductSheet onClose={() => setAdding(false)} />}
      {confirmSheet}
    </Page>
  );
}
