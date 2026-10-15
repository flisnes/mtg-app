import { useEffect, useMemo, useState } from 'react';
import type { SealedProduct } from '@mtg/shared';
import { Sheet } from '../components/Sheet.js';
import { SealedImage } from './SealedImage.js';
import { SealedContentsSheet } from './SealedContents.js';
import { loadSealedProducts } from './store.js';
import {
  boostersContaining,
  cardCount,
  categoryLabel,
  packsContaining,
  productImage,
  productsContaining,
  subtitle,
  type PrintingPlace,
  type ProductWithCard,
} from './product.js';

// "Which sealed product can I find this card in?" — the question you ask when a
// card turns up and you want to know which Commander precon it came in. Answered
// off the sealed catalog we already ship: it lists every product's deterministic
// contents, so this is a scan of data already on the device, not a lookup.
//
// Two kinds of answer. Fixed-content products (precons, Secret Lairs) list the
// card outright. Boosters are random, but MTGJSON lists what each booster type
// can contain, which tells you a Wilds of Eldraine card is in Set Boosters and
// not Draft. Those, and the boxes and bundles holding them, come second.

type Load =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; hits: ProductWithCard[]; packHits: SealedProduct[] };

export function SealedWithCardSheet({
  cardName,
  printings,
  onClose,
}: {
  cardName: string;
  /** Every printing of the card's oracle id — a reprint lives in a different product. */
  printings: Array<PrintingPlace & { scryfallId: string }>;
  onClose: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  // Naming the product is only half an answer: the follow-up question is always
  // "what else was in it?", so a hit opens its card list.
  const [contents, setContents] = useState<SealedProduct | null>(null);
  const highlightIds = useMemo(() => new Set(printings.map((p) => p.scryfallId)), [printings]);

  useEffect(() => {
    let cancelled = false;
    void loadSealedProducts().then((r) => {
      if (cancelled) return;
      if (r.kind !== 'ready') {
        setLoad({ kind: 'unavailable' });
        return;
      }
      const hits = productsContaining(r.products, highlightIds);
      const fixedIds = new Set(hits.map((h) => h.product.id));
      const packHits = packsContaining(r.products, boostersContaining(r.boosters, printings), fixedIds);
      setLoad({ kind: 'ready', hits, packHits });
    });
    return () => {
      cancelled = true;
    };
  }, [printings, highlightIds]);

  return (
    <Sheet onClose={onClose} title={`Sealed products with ${cardName}`} className="sealed-sheet">
      {load.kind === 'loading' && <p className="sealed-msg">Searching products…</p>}

      {load.kind === 'unavailable' && (
        <p className="sealed-msg">Sealed-product data isn’t available yet. Try again after your card database updates.</p>
      )}

      {load.kind === 'ready' && load.hits.length === 0 && load.packHits.length === 0 && (
        <p className="sealed-msg">No sealed product we know of contains {cardName}.</p>
      )}

      {load.kind === 'ready' && load.hits.length > 0 && (
        <>
          <p className="search-meta">
            Always in {load.hits.length} product{load.hits.length === 1 ? '' : 's'}.
          </p>
          <ul className="sealed-results sealed-results-flow">
            {load.hits.map(({ product, qty }) => (
              <li key={product.id}>
                <button className="sealed-result" onClick={() => setContents(product)}>
                  <SealedImage url={productImage(product, 'thumb')} alt="" className="sealed-shot-sm" />
                  <span className="sealed-result-text">
                    <span className="sealed-result-name">{product.name}</span>
                    <span className="sealed-result-sub">
                      {subtitle(product)} · {cardCount(product)} cards
                      {qty > 1 ? ` · ${qty} copies of this card` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {load.kind === 'ready' && load.packHits.length > 0 && (
        <>
          <p className="search-meta">
            Can be opened from {load.packHits.length} product{load.packHits.length === 1 ? '' : 's'} with random boosters.
          </p>
          <ul className="sealed-results sealed-results-flow">
            {load.packHits.map((product) => (
              <li key={product.id}>
                <div className="sealed-result sealed-result-static">
                  <SealedImage url={productImage(product, 'thumb')} alt="" className="sealed-shot-sm" />
                  <span className="sealed-result-text">
                    <span className="sealed-result-name">{product.name}</span>
                    <span className="sealed-result-sub">
                      {subtitle(product)}
                      {product.category ? ` · ${categoryLabel(product.category)}` : ''}
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

      {contents && (
        <SealedContentsSheet product={contents} highlightIds={highlightIds} onClose={() => setContents(null)} />
      )}
    </Sheet>
  );
}
