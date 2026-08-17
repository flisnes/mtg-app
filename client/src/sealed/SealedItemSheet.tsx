import { useEffect, useState } from 'react';
import type { SealedItem, SealedPriceHistory, SealedProduct } from '@mtg/shared';
import { setSealedItemQuantity } from '../db/dataAccess.js';
import { addToTotal, formatTotal, type PriceTotal } from '../components/CardSorting.js';
import { Icon } from '../components/icons.js';
import { PriceChartSheet } from '../components/PriceChart.js';
import { PriceTrend } from '../components/PriceTrend.js';
import { Sheet } from '../components/Sheet.js';
import { historyChange } from '../price/history.js';
import { getSealedPriceHistory } from '../price/sealedTracking.js';
import { SealedImage } from './SealedImage.js';
import { categoryLabel, fmtSealedPrice, itemImage, sealedPriceSourceLabel, type SealedPriceSource } from './product.js';

// One unopened product on the shelf: what it's worth, what the copies you own
// add up to, and how its price has moved since the app started watching it. The
// card sheet's shape, minus everything a box can't have — no printings, no
// finish, no deck slots.

export function SealedItemSheet({
  item,
  product,
  price,
  onRemove,
  onClose,
}: {
  item: SealedItem;
  /** Catalog row for the product, when the catalog is installed. */
  product: SealedProduct | undefined;
  price: SealedPriceSource | undefined;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<SealedPriceHistory | null>(null);
  const [chartOpen, setChartOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSealedPriceHistory(item.productId).then((h) => {
      if (!cancelled) setHistory(h ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [item.productId]);

  const trend = history ? historyChange(history) : null;
  const priceText = fmtSealedPrice(price);
  const total: PriceTotal = { eur: 0, usd: 0 };
  if (price) addToTotal(total, item.quantity, price);
  const category = product?.category;
  const released = product?.releaseDate?.slice(0, 4);

  return (
    <Sheet onClose={onClose} label={item.name} className="sealed-sheet">
      <div className="sealed-detail-head">
        <SealedImage url={itemImage(item, 'full')} alt={item.name} className="sealed-shot-lg" />
        <div className="sealed-detail-text">
          <strong className="sealed-result-name">{item.name}</strong>
          <span className="sealed-result-sub">
            {item.setName ?? item.set.toUpperCase()}
            {category ? ` · ${categoryLabel(category)}` : ''}
            {released ? ` · ${released}` : ''}
          </span>
          {priceText ? (
            <span className="sealed-price">
              {priceText} <span className="sealed-price-src">each · {sealedPriceSourceLabel(price)} market</span>
            </span>
          ) : (
            <span className="sealed-result-sub">Neither market quotes this product.</span>
          )}
        </div>
      </div>

      <div className="sealed-owned-stats">
        <div>
          <span className="fine-print">On the shelf</span>
          <strong>
            {item.quantity} cop{item.quantity === 1 ? 'y' : 'ies'}
          </strong>
        </div>
        <div>
          <span className="fine-print">Worth</span>
          <strong>{price ? formatTotal(total) : '—'}</strong>
        </div>
      </div>

      {trend ? (
        <PriceTrend trend={trend} onOpen={() => setChartOpen(true)} />
      ) : (
        <p className="fine-print">
          No price history yet. Sealed prices are recorded once a day when you open the app, so a line appears tomorrow.
        </p>
      )}

      <div className="sealed-copies">
        <span>Copies</span>
        <button
          onClick={() => void setSealedItemQuantity(item.id, item.quantity - 1)}
          aria-label={`One fewer ${item.name}`}
          disabled={item.quantity <= 1}
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

      <div className="sheet-actions">
        <button className="danger" onClick={onRemove}>
          <Icon name="trash" size={14} /> Remove
        </button>
        <button className="primary" onClick={onClose}>
          Close
        </button>
      </div>

      {chartOpen && history && (
        <PriceChartSheet
          name={item.name}
          subtitle={`${item.setName ?? item.set.toUpperCase()}${category ? ` · ${categoryLabel(category)}` : ''}`}
          history={history}
          onClose={() => setChartOpen(false)}
        />
      )}
    </Sheet>
  );
}
