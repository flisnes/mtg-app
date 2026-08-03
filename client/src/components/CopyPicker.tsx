import type { CollectionEntry, Condition, Finish, Priced, Printing } from '@mtg/shared';
import { CONTAINER_META } from '../deck/containers.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { Icon } from './icons.js';
import { SetSymbol } from './SetSymbol.js';
import { useDismiss } from './useDismiss.js';

// "Your copies": the cards you actually hold, as tiles. Used twice — the card
// sheet's "pick one from my collection" shortcut, and the deck assembler that
// walks a whole list asking the same question card by card.
//
// A tile shows everything you need to choose between two pieces of cardboard:
// the printing, the traits, the sheen if it's a foil, and where the copy is
// filed right now. That last one is the point — picking the copy already sitting
// in another deck means taking it out of that deck, and you should be able to
// see that before you tap, not after.

export const FINISH_LABELS: Record<Finish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };

/** Condition · finish · language, leaving the unremarkable defaults unsaid. */
export function copyDetail(e: CollectionEntry): string {
  const bits: string[] = [e.condition];
  if (e.finish !== 'nonfoil') bits.push(FINISH_LABELS[e.finish]);
  if (e.lang !== 'en') bits.push(e.lang);
  return bits.join(' · ');
}

/** What the caller currently asks for, so the matching tile reads as selected. */
export interface CopySelection {
  scryfallId: string;
  condition: Condition | '';
  finish: Finish | '';
  lang: string;
}

export function CopyGrid({
  copies,
  printings,
  selected,
  hereId,
  onSelect,
}: {
  copies: CollectionEntry[];
  printings: Priced<Printing>[];
  selected?: CopySelection;
  /** The container the picker is filling, if any. Its *unbacked* pills are
   *  dropped: while assembling a deck, "listed in this deck" is on every tile
   *  and drowns out the one pill that matters, the other deck holding the card.
   *  A backed pill stays — that one says "you already committed a copy here". */
  hereId?: string;
  onSelect: (copy: CollectionEntry) => void;
}) {
  const placements = usePlacementIndex();
  const byId = new Map(printings.map((p) => [p.scryfallId, p]));
  const isSelected = (e: CollectionEntry) =>
    !!selected &&
    e.scryfallId === selected.scryfallId &&
    e.condition === selected.condition &&
    e.finish === selected.finish &&
    e.lang === selected.lang;

  return (
    <div className="edition-grid">
      {copies.map((e) => {
        const p = byId.get(e.scryfallId);
        const img = p?.imageSmall ?? p?.imageNormal;
        // Narrowed all the way down to this piece of cardboard, so two copies of
        // one printing that differ only in language point at their own decks.
        const places = (
          placements?.lookup(e.oracleId, e.scryfallId, {
            condition: e.condition,
            finish: e.finish,
            lang: e.lang,
          }).places ?? []
        ).flatMap((pl) => {
          if (pl.containerId !== hereId) return [pl];
          // The slot being filled is on every tile and says nothing; what's worth
          // saying about this container is how many copies are already committed
          // to it, so the pill counts those and goes green.
          return pl.backed > 0 ? [{ ...pl, quantity: pl.backed }] : [];
        });
        return (
          <button
            key={e.id}
            className={isSelected(e) ? 'edition-tile edition-tile-selected' : 'edition-tile'}
            onClick={() => onSelect(e)}
          >
            <span className="edition-tile-art">
              {img ? (
                <img src={img} alt={p?.setName ?? ''} loading="lazy" />
              ) : (
                <span className="edition-tile-ph">{p?.setName ?? 'Unknown set'}</span>
              )}
              {e.finish !== 'nonfoil' && img && <span className="foil-sheen" aria-hidden />}
              <span
                className={`tile-badge ${e.quantityForTrade > 0 ? 'own-trade' : 'own-yes'}`}
                title={`You own ${e.quantity}`}
              >
                ×{e.quantity}
              </span>
            </span>
            <span className="edition-tile-caption">
              {p ? (
                <>
                  <SetSymbol set={p.set} title={p.setName} /> {p.set.toUpperCase()} #{p.collectorNumber}
                </>
              ) : (
                'Unknown edition'
              )}
            </span>
            <span className="edition-tile-sub">{copyDetail(e)}</span>
            <span className="copy-tile-where">
              {places.length === 0 ? (
                <span className="fine-print">On the shelf</span>
              ) : (
                places.map((pl) => (
                  <span
                    key={pl.containerId}
                    className={
                      pl.backed >= pl.quantity
                        ? 'place-pill place-pill-static place-pill-backed'
                        : 'place-pill place-pill-static'
                    }
                    title={pl.backed >= pl.quantity ? `Your copy is filed in ${pl.name}` : `Listed in ${pl.name}`}
                  >
                    <Icon name={CONTAINER_META[pl.kind].icon} size={12} />
                    <span className="place-pill-name">{pl.name}</span>
                    {pl.quantity > 1 && <span className="place-pill-qty">×{pl.quantity}</span>}
                  </span>
                ))
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The grid as an overlay, for the card sheet's edition shortcut. */
export function CopyPicker({
  copies,
  printings,
  selected,
  onSelect,
  onClose,
}: {
  copies: CollectionEntry[];
  printings: Priced<Printing>[];
  selected: CopySelection;
  onSelect: (copy: CollectionEntry) => void;
  onClose: () => void;
}) {
  useDismiss(onClose);
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="sheet edition-picker-sheet"
        role="dialog"
        aria-label="Your copies"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="edition-picker-head">
          <h2>Your copies</h2>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <CopyGrid copies={copies} printings={printings} selected={selected} onSelect={onSelect} />
      </div>
    </div>
  );
}
