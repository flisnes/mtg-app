import { useEffect, useState, type ReactNode } from 'react';
import type { OracleCard, Priced, SealedProduct } from '@mtg/shared';
import { CardSheet } from '../components/CardSheet.js';
import { formatPrice, pricedForFinish } from '../components/CardSorting.js';
import type { CardItem } from '../components/CardViews.js';
import { Icon } from '../components/icons.js';
import { ResultsList } from '../components/ResultsList.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { Sheet } from '../components/Sheet.js';
import { SealedImage } from './SealedImage.js';
import { loadContents, perCopyCount, type OpenContents, type OpenRow } from './open.js';
import { productImage, subtitle } from './product.js';

// What's actually inside a sealed product, as cards rather than as a list of
// names. A precon's contents are known down to the printing — the Wilds of
// Eldraine Fae Dominion deck ships *that* Hullbreaker Horror, not whichever one
// the card is best known in — so the grid shows that exact art, set symbol and
// price, and tapping a card opens it like a card anywhere else in the app.
//
// Three surfaces share this: the add sheet's "open it" list, the shelf's "open
// it" list, and the reverse lookup's "which precon was this in?" answers.

const finishTag = (r: OpenRow) => (r.finish === 'foil' ? ' · foil' : r.finish === 'etched' ? ' · etched' : '');

function contentItem(r: OpenRow, copies: number, highlight: boolean, onOpen: () => void): CardItem {
  return {
    key: `${r.scryfallId}|${r.finish}`,
    name: r.name,
    image: r.printing.imageSmall ?? r.oracle?.imageSmall ?? null,
    mana: r.oracle?.manaCost,
    foil: r.finish !== 'nonfoil',
    count: r.qty * copies,
    // Only in the reverse lookup, where one card in a 400-card display is the
    // whole reason this list is open.
    ...(highlight
      ? { badge: <Icon name="search" size={12} />, badgeClass: 'badge-hit', badgeTitle: 'The card you looked up' }
      : {}),
    sub: (
      <>
        <SetSymbol set={r.printing.set} className="sub-set-symbol" title={r.printing.setName} />
        {r.printing.setName} · #{r.collectorNumber}
        {finishTag(r)}
      </>
    ),
    price: formatPrice(pricedForFinish(r.printing, r.finish), r.oracle) ?? '—',
    onClick: onOpen,
  };
}

/**
 * The card grid/list for one product's contents. Paged and view-toggled like
 * every other card list, so a 400-card Commander display doesn't paint at once.
 */
export function SealedContentsList({
  rows,
  pageKey,
  copies = 1,
  highlightIds,
  status,
}: {
  rows: OpenRow[];
  /** Paging signature: changing it starts again from the first page. */
  pageKey: string;
  /** Multiplies the per-tile count when several copies are being added. */
  copies?: number;
  /** Printings to mark (the card the reverse lookup was asked about). */
  highlightIds?: Set<string>;
  status: ReactNode;
}) {
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId: string } | null>(null);

  const items = rows.map((r) =>
    contentItem(r, copies, !!highlightIds?.has(r.scryfallId), () => {
      if (r.oracle) setInfo({ oracle: r.oracle, scryfallId: r.scryfallId });
    }),
  );

  return (
    <>
      <ResultsList
        items={items}
        pageKey={pageKey}
        status={status}
        showEmpty={rows.length === 0}
        emptyText="None of this product’s cards are in your installed card data."
      />
      {info && (
        <CardSheet mode="info" oracleCard={info.oracle} initialScryfallId={info.scryfallId} onClose={() => setInfo(null)} />
      )}
    </>
  );
}

/**
 * The contents of a product you don't own, opened from the reverse lookup. No
 * add button: this answers "what's in it?", and the box the card came in is
 * usually one you already cracked years ago.
 */
export function SealedContentsSheet({
  product,
  highlightIds,
  onClose,
}: {
  product: SealedProduct;
  highlightIds?: Set<string>;
  onClose: () => void;
}) {
  const [contents, setContents] = useState<OpenContents | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadContents(product).then((c) => {
      if (!cancelled) setContents(c);
    });
    return () => {
      cancelled = true;
    };
  }, [product]);

  const total = contents ? perCopyCount(contents.rows) : 0;

  return (
    <Sheet onClose={onClose} label={product.name} className="sealed-sheet">
      <div className="sealed-detail-head">
        <SealedImage url={productImage(product, 'thumb')} alt="" className="sealed-shot-sm" />
        <div className="sealed-detail-text">
          <strong className="sealed-result-name">{product.name}</strong>
          <span className="sealed-result-sub">{subtitle(product)}</span>
        </div>
      </div>

      {product.omittedRandom ? (
        <p className="sealed-note">
          ⚠ Also contains {product.omittedRandom} random pack{product.omittedRandom === 1 ? '' : 's'}, whose contents nobody
          can list.
        </p>
      ) : null}
      {contents && contents.missingLocally > 0 ? (
        <p className="sealed-note">
          {contents.missingLocally} card(s) aren’t in your installed card data. Update your card database to see them.
        </p>
      ) : null}

      {contents ? (
        <SealedContentsList
          rows={contents.rows}
          pageKey={product.id}
          {...(highlightIds ? { highlightIds } : {})}
          status={`${total} card${total === 1 ? '' : 's'} in this product.`}
        />
      ) : (
        <p className="sealed-msg">Loading contents…</p>
      )}

      <div className="sheet-actions">
        <button onClick={onClose}>Close</button>
      </div>
    </Sheet>
  );
}
