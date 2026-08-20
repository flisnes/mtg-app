import { useEffect, useState } from 'react';
import { CONDITIONS, type Condition, type Finish, type SealedItem, type SealedProduct } from '@mtg/shared';
import { setSealedItemQuantity } from '../db/dataAccess.js';
import { LANGS } from '../components/CardSheet.js';
import { Sheet } from '../components/Sheet.js';
import { useToast } from '../components/Toast.js';
import { useFileThese } from '../deck/useFileThese.js';
import { loadContents, openIntoCollection, perCopyCount, type OpenContents } from './open.js';

// Cracking a box you already own. The add sheet has always been able to open a
// product on the way in; a box that sat on the shelf for a year had no way out
// but Remove, then re-add as cards. This is the same operation, one copy at a
// time: the cards land in the collection, the shelf count drops, and the same
// "where do these live?" prompt every other bulk intake asks follows.

const finishTag = (f: Finish) => (f === 'foil' ? ' · foil' : f === 'etched' ? ' · etched' : '');

export function OpenSealedSheet({
  item,
  product,
  onClose,
}: {
  item: SealedItem;
  product: SealedProduct;
  onClose: () => void;
}) {
  const [contents, setContents] = useState<OpenContents | null>(null);
  const [copies, setCopies] = useState(1);
  const [condition, setCondition] = useState<Condition>('NM');
  const [lang, setLang] = useState('en');
  const [opening, setOpening] = useState(false);
  const toast = useToast();
  const { offer: offerFiling, sheet: fileTheseSheet } = useFileThese();

  useEffect(() => {
    let cancelled = false;
    void loadContents(product).then((c) => {
      if (!cancelled) setContents(c);
    });
    return () => {
      cancelled = true;
    };
  }, [product]);

  const perCopy = contents ? perCopyCount(contents.rows) : 0;
  const max = Math.min(item.quantity, 99);

  const open = async () => {
    if (!contents || opening) return;
    setOpening(true);
    try {
      const { cards, filing } = await openIntoCollection(contents.rows, { copies, condition, lang, label: product.name });
      // Only after the cards are safely in: a failed decrement would otherwise
      // lose the box without adding anything.
      await setSealedItemQuantity(item.id, item.quantity - copies);
      toast(`Opened ${copies} ${product.name}, added ${cards} card${cards === 1 ? '' : 's'}`);
      setOpening(false);
      await offerFiling(filing, cards);
      onClose();
    } catch (e) {
      toast(`Couldn't open product: ${(e as Error).message}`);
      setOpening(false);
    }
  };

  return (
    <>
      <Sheet onClose={onClose} title={`Open ${product.name}`} className="sealed-sheet">
        <p className="search-meta">
          {perCopy > 0
            ? `${perCopy} card${perCopy === 1 ? '' : 's'} per copy go into your collection, and the shelf drops by what you crack.`
            : 'Loading contents…'}
        </p>

        {product.omittedRandom ? (
          <p className="sealed-note">
            ⚠ Also contains {product.omittedRandom} random pack{product.omittedRandom === 1 ? '' : 's'}, not added (contents
            unknown).
          </p>
        ) : null}
        {product.unresolved ? (
          <p className="sealed-note">{product.unresolved} card(s) in this product couldn’t be identified and were skipped.</p>
        ) : null}
        {contents && contents.missingLocally > 0 ? (
          <p className="sealed-note">
            {contents.missingLocally} card(s) aren’t in your installed card data. Update your card database to include them.
          </p>
        ) : null}

        <div className="sealed-copies">
          <span>Open</span>
          <button onClick={() => setCopies(Math.max(1, copies - 1))} aria-label="Open fewer copies" disabled={copies <= 1}>
            −
          </button>
          <span className="sealed-copies-n">{copies}</span>
          <button
            onClick={() => setCopies(Math.min(max, copies + 1))}
            aria-label="Open more copies"
            disabled={copies >= max}
          >
            +
          </button>
          <span className="fine-print">of {item.quantity}</span>
        </div>

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

        {contents ? (
          <ul className="sealed-cardlist">
            {contents.rows.map((r) => (
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

        <div className="scan-confirm-actions">
          <button className="primary" disabled={opening || !contents || perCopy === 0} onClick={() => void open()}>
            {opening ? 'Opening…' : `Open ${copies}, add ${perCopy * copies} cards`}
          </button>
          <button onClick={onClose} disabled={opening}>
            Cancel
          </button>
        </div>
      </Sheet>
      {fileTheseSheet}
    </>
  );
}
