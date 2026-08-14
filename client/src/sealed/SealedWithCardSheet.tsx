import { useEffect, useState } from 'react';
import { Sheet } from '../components/Sheet.js';
import { SealedImage } from './SealedImage.js';
import { loadSealedProducts } from './store.js';
import { cardCount, productImage, productsContaining, subtitle, type ProductWithCard } from './product.js';

// "Which sealed product can I find this card in?" — the question you ask when a
// card turns up and you want to know which Commander precon it came in. Answered
// off the sealed catalog we already ship: it lists every product's deterministic
// contents, so this is a scan of data already on the device, not a lookup.
//
// Only fixed-content products can answer. A card that only ever appeared in
// boosters has no product to name, because "it's somewhere in a random pack" is
// not an answer worth printing.

type Load =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; hits: ProductWithCard[] };

export function SealedWithCardSheet({
  cardName,
  scryfallIds,
  onClose,
}: {
  cardName: string;
  /** Every printing of the card's oracle id — a reprint lives in a different product. */
  scryfallIds: string[];
  onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void loadSealedProducts().then((r) => {
      if (cancelled) return;
      if (r.kind !== 'ready') {
        setLoad({ kind: 'unavailable' });
        return;
      }
      setLoad({ kind: 'ready', hits: productsContaining(r.products, new Set(scryfallIds)) });
    });
    return () => {
      cancelled = true;
    };
  }, [scryfallIds]);

  return (
    <Sheet onClose={onClose} title={`Sealed products with ${cardName}`} className="sealed-sheet">
      {load.kind === 'loading' && <p className="sealed-msg">Searching products…</p>}

      {load.kind === 'unavailable' && (
        <p className="sealed-msg">Sealed-product data isn’t available yet. Try again after your card database updates.</p>
      )}

      {load.kind === 'ready' && load.hits.length === 0 && (
        <p className="sealed-msg">
          No fixed-content product lists {cardName}. It may only come from booster packs, whose contents are random.
        </p>
      )}

      {load.kind === 'ready' && load.hits.length > 0 && (
        <>
          <p className="search-meta">
            Found in {load.hits.length} product{load.hits.length === 1 ? '' : 's'}.
          </p>
          <ul className="sealed-results">
            {load.hits.map(({ product, qty }) => (
              <li key={product.id}>
                <div className="sealed-result sealed-result-static">
                  <SealedImage url={productImage(product, 'thumb')} alt="" className="sealed-shot-sm" />
                  <span className="sealed-result-text">
                    <span className="sealed-result-name">{product.name}</span>
                    <span className="sealed-result-sub">
                      {subtitle(product)} · {cardCount(product)} cards
                      {qty > 1 ? ` · ${qty} copies of this card` : ''}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="sheet-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Sheet>
  );
}
