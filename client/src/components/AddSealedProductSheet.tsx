import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Finish, SealedProduct } from '@mtg/shared';
import { applyImport, type ImportLine } from '../db/dataAccess.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { loadSealedProducts } from '../sealed/store.js';
import { useToast } from './Toast.js';

// "Add sealed product" (see sealed-products feature). Search a named,
// non-randomized product (precon deck, Secret Lair, gift box…) and add every
// card it contains to the collection in one go. Contents are expanded
// server-side (MTGJSON → Scryfall printings); randomised parts like booster
// packs are omitted and flagged here rather than silently dropped.

type Load =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; products: SealedProduct[] };

/** A product's cards joined with the installed card DB for display + add. */
interface DetailRow {
  scryfallId: string;
  oracleId: string;
  name: string;
  set: string;
  collectorNumber: string;
  qty: number;
  finish: Finish;
  imageSmall: string | null;
}
interface Detail {
  rows: DetailRow[];
  /** Cards in the product that aren't in the installed card DB (version skew). */
  missingLocally: number;
}

const MAX_RESULTS = 60;
const finishTag = (f: Finish) => (f === 'foil' ? ' · foil' : f === 'etched' ? ' · etched' : '');

function subtitle(p: SealedProduct): string {
  const bits = [p.setName ?? p.set.toUpperCase()];
  if (p.releaseDate) bits.push(p.releaseDate.slice(0, 4));
  return bits.join(' · ');
}

export function AddSealedProductSheet({ onClose }: { onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SealedProduct | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [copies, setCopies] = useState(1);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void loadSealedProducts().then((r) => {
      if (cancelled) return;
      setLoad(r.kind === 'ready' ? { kind: 'ready', products: r.products } : { kind: 'unavailable' });
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
        imageSmall: pr.imageSmall,
      });
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    setDetail({ rows, missingLocally });
  };

  const totalCards = detail ? detail.rows.reduce((s, r) => s + r.qty, 0) * copies : 0;

  const add = async () => {
    if (!selected || !detail || adding) return;
    setAdding(true);
    try {
      const lines: ImportLine[] = detail.rows.map((r) => ({
        oracleId: r.oracleId,
        scryfallId: r.scryfallId,
        condition: 'NM',
        finish: r.finish,
        lang: 'en',
        quantity: r.qty * copies,
        quantityForTrade: 0,
      }));
      const { cards } = await applyImport(lines, { source: 'sealed', label: selected.name });
      toast(`Added ${cards} card${cards === 1 ? '' : 's'} from ${selected.name}`);
      onClose();
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
            copies={copies}
            setCopies={setCopies}
            totalCards={totalCards}
            adding={adding}
            onAdd={() => void add()}
          />
        )}
      </div>
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
        placeholder="Search products (e.g. a Commander deck or Secret Lair)…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() === '' ? (
        <p className="sealed-msg">Search {load.products.length.toLocaleString()} preconstructed decks, Secret Lairs and other fixed-content products.</p>
      ) : results.length === 0 ? (
        <p className="sealed-msg">No products match “{query.trim()}”.</p>
      ) : (
        <ul className="sealed-results">
          {results.slice(0, MAX_RESULTS).map((p) => {
            const count = p.cards.reduce((s, c) => s + c.qty, 0);
            return (
              <li key={p.id}>
                <button className="sealed-result" onClick={() => onPick(p)}>
                  <span className="sealed-result-name">{p.name}</span>
                  <span className="sealed-result-sub">
                    {subtitle(p)} · {count} cards
                    {p.omittedRandom ? ' +packs' : ''}
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
  copies,
  setCopies,
  totalCards,
  adding,
  onAdd,
}: {
  product: SealedProduct;
  detail: Detail | null;
  copies: number;
  setCopies: (n: number) => void;
  totalCards: number;
  adding: boolean;
  onAdd: () => void;
}) {
  if (!detail) return <p className="sealed-msg">Loading contents…</p>;

  const foils = detail.rows.filter((r) => r.finish !== 'nonfoil').reduce((s, r) => s + r.qty, 0);
  const perCopy = detail.rows.reduce((s, r) => s + r.qty, 0);

  return (
    <>
      <div className="sealed-detail-head">
        <strong className="sealed-result-name">{product.name}</strong>
        <span className="sealed-result-sub">{subtitle(product)}</span>
      </div>

      <p className="sealed-summary">
        {perCopy} cards{foils > 0 ? ` (${foils} foil/etched)` : ''}
      </p>

      {product.omittedRandom ? (
        <p className="sealed-note">⚠ Also contains {product.omittedRandom} random pack{product.omittedRandom === 1 ? '' : 's'} — not added (contents unknown).</p>
      ) : null}
      {product.unresolved ? <p className="sealed-note">{product.unresolved} card(s) in this product couldn’t be identified and were skipped.</p> : null}
      {detail.missingLocally > 0 ? (
        <p className="sealed-note">{detail.missingLocally} card(s) aren’t in your installed card data — update your card database to include them.</p>
      ) : null}

      {perCopy === 0 ? (
        <p className="sealed-msg">None of this product’s cards are available to add.</p>
      ) : (
        <>
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

          <div className="scan-confirm-actions">
            <button className="primary" disabled={adding} onClick={onAdd}>
              {adding ? 'Adding…' : `Add ${totalCards} cards to collection`}
            </button>
          </div>
        </>
      )}
    </>
  );
}
