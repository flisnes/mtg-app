import type { CollectionEntry, Condition, Finish, Priced, Printing } from '@mtg/shared';
import { specialLabel } from '@mtg/shared';
import { CONTAINER_META } from '../deck/containers.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { Icon } from './icons.js';
import { SetSymbol } from './SetSymbol.js';
import { useDismiss } from './useDismiss.js';

// "Your copies": the cards you actually hold, as tiles. Used three times: the
// card sheet's "pick one from my collection" shortcut, the deck assembler that
// walks a whole list asking the same question card by card, and the filing
// picker that asks which of your copies is going into a container.
//
// The first two pick one copy; the filing picker counts them, and passes
// `picked` / `roomFor` to say how many of each row are going in and how many
// more will fit.
//
// A tile shows everything you need to choose between two pieces of cardboard:
// the printing, the traits, the sheen if it's a foil, and where the copy is
// filed right now. That last one is the point — picking the copy already sitting
// in another deck means taking it out of that deck, and you should be able to
// see that before you tap, not after.

export const FINISH_LABELS: Record<Finish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };

/** Condition · finish · language · special, leaving the unremarkable defaults unsaid. */
export function copyDetail(e: CollectionEntry): string {
  const bits: string[] = [e.condition];
  if (e.finish !== 'nonfoil') bits.push(FINISH_LABELS[e.finish]);
  if (e.lang !== 'en') bits.push(e.lang);
  if (e.special?.length) bits.push(specialLabel(e.special));
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
  picked,
  roomFor,
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
  /** Counting mode: copies of each row taken so far, by entry id. A tile with a
   *  count reads as chosen and wears it, so tapping the same row twice is how
   *  you send both your Command Beacons the same way. */
  picked?: Map<string, number>;
  /** Counting mode: how many more of that row the target can still take. 0
   *  greys the tile out — its pills already say the container has them all. */
  roomFor?: (copy: CollectionEntry) => number;
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
        const took = picked?.get(e.id) ?? 0;
        const full = !!roomFor && roomFor(e) === 0 && took === 0;
        const classes = ['edition-tile'];
        if (isSelected(e) || took > 0) classes.push('edition-tile-selected');
        if (full) classes.push('edition-tile-full');
        return (
          <button
            key={e.id}
            className={classes.join(' ')}
            disabled={full}
            title={full ? 'Every copy of this one is already in there' : undefined}
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
              {took > 0 && (
                <span className="tile-badge tile-badge-took" title={`${took} of these going in`}>
                  <Icon name="check" size={11} /> {took}
                </span>
              )}
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
  onAddCopy,
  onClose,
}: {
  copies: CollectionEntry[];
  printings: Priced<Printing>[];
  selected: CopySelection;
  onSelect: (copy: CollectionEntry) => void;
  /** The edition they're holding isn't on the grid, because it never made it
   *  into the collection. Offered as a way out of the picker rather than a dead
   *  end: add the copy first, then file that one. */
  onAddCopy?: () => void;
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
        {onAddCopy && (
          <button
            type="button"
            className="linklike copy-picker-add"
            onClick={onAddCopy}
            title="Add the copy to your collection, then file that one"
          >
            <Icon name="plus" size={14} /> Not here? Add a copy
          </button>
        )}
      </div>
    </div>
  );
}
