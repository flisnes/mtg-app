import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONDITIONS, type Condition, type Finish, type SealedPriceMap, type SealedProduct } from '@mtg/shared';
import { addSealedItem, applyImport, type ImportLine } from '../db/dataAccess.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { loadSealedProducts } from '../sealed/store.js';
import { SealedImage } from '../sealed/SealedImage.js';
import {
  cardCount,
  fmtSealedPrice,
  isRandomOnly,
  productImage,
  sealedPriceOf,
  sealedPriceSourceLabel,
  subtitle,
} from '../sealed/product.js';
import { useFileThese } from '../deck/useFileThese.js';
import { LANGS } from './CardSheet.js';
import { useToast } from './Toast.js';
import { useDismiss } from './useDismiss.js';

// "Add sealed product" (see sealed-products feature). Search any sealed product
// MTGJSON knows, then choose what owning it means: keep the box sealed, or open
// it and put its cards in the collection. Products whose contents are entirely
// random — booster boxes, displays, loose packs — only offer the first, because
// nobody can say what's inside an unopened pack.

type Load =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; products: SealedProduct[]; prices: SealedPriceMap };

/** What the user intends to do with the product they picked. */
type Outcome = 'unopened' | 'cards';

/** A product's cards joined with the installed card DB for display + add. */
interface DetailRow {
  scryfallId: string;
  oracleId: string;
  name: string;
  set: string;
  collectorNumber: string;
  qty: number;
  finish: Finish;
}
interface Detail {
  rows: DetailRow[];
  /** Cards in the product that aren't in the installed card DB (version skew). */
  missingLocally: number;
}

const MAX_RESULTS = 60;
const finishTag = (f: Finish) => (f === 'foil' ? ' · foil' : f === 'etched' ? ' · etched' : '');

export function AddSealedProductSheet({ onClose }: { onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SealedProduct | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [outcome, setOutcome] = useState<Outcome>('unopened');
  const [copies, setCopies] = useState(1);
  const [adding, setAdding] = useState(false);
  // A product isn't always a mint English one: reprints turn up played, and
  // plenty of precons are bought in Japanese.
  const [condition, setCondition] = useState<Condition>('NM');
  const [lang, setLang] = useState('en');
  const toast = useToast();
  // A precon lives in a box on the shelf far more often than loose in a
  // collection, so the add ends with the same question every other intake asks.
  const { offer: offerFiling, sheet: fileTheseSheet } = useFileThese();

  // Back / Escape steps out of a chosen product first (mirroring the ‹ Back
  // button), then closes the sheet.
  useDismiss(adding ? null : selected ? () => setSelected(null) : onClose);

  useEffect(() => {
    let cancelled = false;
    void loadSealedProducts().then((r) => {
      if (cancelled) return;
      setLoad(r.kind === 'ready' ? { kind: 'ready', products: r.products, prices: r.prices } : { kind: 'unavailable' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => {
    if (load.kind !== 'ready') return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const matches = load.products.filter((p) => p.name.toLowerCase().includes(q));
    // Prefix matches first, then alphabetical (the list is already name-sorted).
    matches.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp;
    });
    return matches;
  }, [load, query]);

  const openProduct = async (p: SealedProduct) => {
    setSelected(p);
    setDetail(null);
    setCopies(1);
    // A box of boosters can only be owned unopened; anything with a known
    // decklist defaults to the reason that feature was built — adding the cards.
    setOutcome(isRandomOnly(p) ? 'unopened' : 'cards');
    const printings = await getPrintingsByIds(p.cards.map((c) => c.scryfallId));
    const oracles = await getOracleCardsByIds([...printings.values()].map((pr) => pr.oracleId));
    const rows: DetailRow[] = [];
    let missingLocally = 0;
    for (const c of p.cards) {
      const pr = printings.get(c.scryfallId);
      if (!pr) {
        missingLocally += c.qty;
        continue;
      }
      rows.push({
        scryfallId: c.scryfallId,
        oracleId: pr.oracleId,
        name: oracles.get(pr.oracleId)?.name ?? '(unknown card)',
        set: pr.set,
        collectorNumber: pr.collectorNumber,
        qty: c.qty,
        finish: c.finish,
      });
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    setDetail({ rows, missingLocally });
  };

  const addUnopened = async (product: SealedProduct) => {
    await addSealedItem(
      {
        productId: product.id,
        name: product.name,
        set: product.set,
        ...(product.setName ? { setName: product.setName } : {}),
        ...(product.identifiers?.tcgplayer ? { tcgplayerId: product.identifiers.tcgplayer } : {}),
      },
      copies,
    );
    toast(`Added ${copies} unopened ${product.name}`);
    onClose();
  };

  const addCards = async (product: SealedProduct, d: Detail) => {
    const lines: ImportLine[] = d.rows.map((r) => ({
      oracleId: r.oracleId,
      scryfallId: r.scryfallId,
      condition,
      finish: r.finish,
      lang,
      quantity: r.qty * copies,
      quantityForTrade: 0,
    }));
    const { cards } = await applyImport(lines, { source: 'sealed', label: product.name });
    toast(`Added ${cards} card${cards === 1 ? '' : 's'} from ${product.name}`);
    setAdding(false);
    await offerFiling(
      lines.map((l) => {
        const row = d.rows.find((r) => r.scryfallId === l.scryfallId);
        return {
          oracleId: l.oracleId,
          scryfallId: l.scryfallId,
          quantity: l.quantity,
          board: 'main' as const,
          wants: { condition: l.condition, finish: l.finish, lang: l.lang },
          ...(row ? { label: row.name, sub: `${row.set.toUpperCase()} #${row.collectorNumber}` } : {}),
        };
      }),
      cards,
    );
    onClose();
  };

  const add = async () => {
    if (!selected || adding) return;
    setAdding(true);
    try {
      if (outcome === 'unopened') await addUnopened(selected);
      else if (detail) await addCards(selected, detail);
    } catch (e) {
      toast(`Couldn't add product: ${(e as Error).message}`);
      setAdding(false);
    }
  };

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet sealed-sheet" role="dialog" aria-label="Add sealed product" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>{selected ? 'Add product' : 'Add sealed product'}</h2>
          {selected && (
            <button className="sealed-back" onClick={() => setSelected(null)} aria-label="Back to search">
              ‹ Back
            </button>
          )}
          <button className="scan-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {!selected && <SearchView load={load} query={query} setQuery={setQuery} results={results} onPick={(p) => void openProduct(p)} />}

        {selected && (
          <DetailView
            product={selected}
            detail={detail}
            prices={load.kind === 'ready' ? load.prices : {}}
            outcome={outcome}
            setOutcome={setOutcome}
            copies={copies}
            setCopies={setCopies}
            condition={condition}
            setCondition={setCondition}
            lang={lang}
            setLang={setLang}
            adding={adding}
            onAdd={() => void add()}
          />
        )}
      </div>
      {fileTheseSheet}
    </div>,
    document.body,
  );
}

function SearchView({
  load,
  query,
  setQuery,
  results,
  onPick,
}: {
  load: Load;
  query: string;
  setQuery: (v: string) => void;
  results: SealedProduct[];
  onPick: (p: SealedProduct) => void;
}) {
  if (load.kind === 'loading') return <p className="sealed-msg">Loading products…</p>;
  if (load.kind === 'unavailable')
    return <p className="sealed-msg">Sealed-product data isn’t available yet. Try again after your card database updates.</p>;

  return (
    <>
      <input
        className="sealed-search"
        type="search"
        autoFocus
        placeholder="Search products (a booster box, Commander deck, Secret Lair…)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() === '' ? (
        <p className="sealed-msg">
          Search {load.products.length.toLocaleString()} sealed products. Keep one unopened, or open it and add its cards.
        </p>
      ) : results.length === 0 ? (
        <p className="sealed-msg">No products match “{query.trim()}”.</p>
      ) : (
        <ul className="sealed-results">
          {results.slice(0, MAX_RESULTS).map((p) => {
            const count = cardCount(p);
            return (
              <li key={p.id}>
                <button className="sealed-result" onClick={() => onPick(p)}>
                  <SealedImage url={productImage(p, 'thumb')} alt="" className="sealed-shot-sm" />
                  <span className="sealed-result-text">
                    <span className="sealed-result-name">{p.name}</span>
                    <span className="sealed-result-sub">
                      {subtitle(p)}
                      {count > 0 ? ` · ${count} cards` : ''}
                      {p.omittedRandom ? ` · ${p.omittedRandom} random pack${p.omittedRandom === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {results.length > MAX_RESULTS && <li className="sealed-msg">…refine your search to see more ({results.length} matches).</li>}
        </ul>
      )}
    </>
  );
}

function DetailView({
  product,
  detail,
  prices,
  outcome,
  setOutcome,
  copies,
  setCopies,
  condition,
  setCondition,
  lang,
  setLang,
  adding,
  onAdd,
}: {
  product: SealedProduct;
  detail: Detail | null;
  prices: SealedPriceMap;
  outcome: Outcome;
  setOutcome: (o: Outcome) => void;
  copies: number;
  setCopies: (n: number) => void;
  condition: Condition;
  setCondition: (c: Condition) => void;
  lang: string;
  setLang: (l: string) => void;
  adding: boolean;
  onAdd: () => void;
}) {
  const randomOnly = isRandomOnly(product);
  const perCopy = detail ? detail.rows.reduce((s, r) => s + r.qty, 0) : 0;
  const foils = detail ? detail.rows.filter((r) => r.finish !== 'nonfoil').reduce((s, r) => s + r.qty, 0) : 0;
  const price = sealedPriceOf(prices, product.id);
  const priceText = fmtSealedPrice(price);
  const showCards = outcome === 'cards' && !randomOnly;

  return (
    <>
      <div className="sealed-detail-head">
        <SealedImage url={productImage(product, 'full')} alt={product.name} className="sealed-shot-lg" />
        <div className="sealed-detail-text">
          <strong className="sealed-result-name">{product.name}</strong>
          <span className="sealed-result-sub">{subtitle(product)}</span>
          {priceText && (
            <span className="sealed-price">
              {priceText} <span className="sealed-price-src">{sealedPriceSourceLabel(price)} market</span>
            </span>
          )}
        </div>
      </div>

      {/* The whole point of the outcome picker: a box on the shelf and a box
          you cracked are different things, and only you know which this is. */}
      <div className="sealed-outcome" role="radiogroup" aria-label="What are you adding?">
        <label className={outcome === 'unopened' ? 'sealed-outcome-opt sealed-outcome-on' : 'sealed-outcome-opt'}>
          <input
            type="radio"
            name="sealed-outcome"
            checked={outcome === 'unopened'}
            onChange={() => setOutcome('unopened')}
          />
          <span className="sealed-outcome-label">Add as unopened</span>
          <span className="sealed-outcome-note">Keeps the sealed product itself, cards stay inside.</span>
        </label>
        <label
          className={
            randomOnly
              ? 'sealed-outcome-opt sealed-outcome-off'
              : showCards
                ? 'sealed-outcome-opt sealed-outcome-on'
                : 'sealed-outcome-opt'
          }
        >
          <input
            type="radio"
            name="sealed-outcome"
            checked={showCards}
            disabled={randomOnly}
            onChange={() => setOutcome('cards')}
          />
          <span className="sealed-outcome-label">Open it, add the cards</span>
          <span className="sealed-outcome-note">
            {randomOnly
              ? 'Contents are random, so there’s no card list to add.'
              : detail
                ? `${perCopy} card${perCopy === 1 ? '' : 's'}${foils > 0 ? ` (${foils} foil/etched)` : ''}`
                : 'Loading contents…'}
          </span>
        </label>
      </div>

      {product.omittedRandom && showCards ? (
        <p className="sealed-note">
          ⚠ Also contains {product.omittedRandom} random pack{product.omittedRandom === 1 ? '' : 's'}, not added (contents unknown).
        </p>
      ) : null}
      {product.unresolved && showCards ? (
        <p className="sealed-note">{product.unresolved} card(s) in this product couldn’t be identified and were skipped.</p>
      ) : null}
      {detail && detail.missingLocally > 0 && showCards ? (
        <p className="sealed-note">{detail.missingLocally} card(s) aren’t in your installed card data. Update your card database to include them.</p>
      ) : null}

      <div className="sealed-copies">
        <span>Copies</span>
        <button onClick={() => setCopies(Math.max(1, copies - 1))} aria-label="Fewer copies" disabled={copies <= 1}>
          −
        </button>
        <span className="sealed-copies-n">{copies}</span>
        <button onClick={() => setCopies(Math.min(99, copies + 1))} aria-label="More copies" disabled={copies >= 99}>
          +
        </button>
      </div>

      {showCards && (
        <>
          {/* Finish comes from the product itself; condition and language don't,
              and a Japanese precon shouldn't have to be corrected card by card. */}
          <div className="chips" role="group" aria-label="Details for these cards">
            <label className="chip">
              Condition:{' '}
              <select value={condition} onChange={(e) => setCondition(e.target.value as Condition)} aria-label="Condition">
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="chip">
              Language:{' '}
              <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language">
                {LANGS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {detail ? (
            <ul className="sealed-cardlist">
              {detail.rows.map((r) => (
                <li key={`${r.scryfallId}|${r.finish}`}>
                  <span className="sealed-card-qty">{r.qty * copies}×</span>
                  <span className="sealed-card-name">
                    {r.name}
                    <span className="sealed-card-set">
                      {' '}
                      {r.set.toUpperCase()} #{r.collectorNumber}
                      {finishTag(r.finish)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sealed-msg">Loading contents…</p>
          )}
        </>
      )}

      <div className="scan-confirm-actions">
        <button className="primary" disabled={adding || (showCards && (!detail || perCopy === 0))} onClick={onAdd}>
          {adding
            ? 'Adding…'
            : showCards
              ? `Add ${perCopy * copies} cards to collection`
              : `Add ${copies} unopened to collection`}
        </button>
      </div>
      {showCards && detail && perCopy === 0 && <p className="sealed-msg">None of this product’s cards are available to add.</p>}
    </>
  );
}
