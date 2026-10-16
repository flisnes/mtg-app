import { useState } from 'react';
import type { Priced, Printing } from '@mtg/shared';
import { formatPrice } from '../CardSorting.js';
import { EditionTile } from '../EditionTile.js';
import { Icon } from '../icons.js';
import { Sheet } from '../Sheet.js';
import { ANY_PRINTING } from './types.js';

/**
 * Move editions the user owns to the front, keeping the original (newest-first)
 * order within the owned and unowned groups. Returns the input untouched when
 * nothing is owned, so the common case allocates nothing.
 */
export function orderByOwned(printings: Priced<Printing>[], ownedIds?: Set<string>): Priced<Printing>[] {
  if (!ownedIds || ownedIds.size === 0) return printings;
  const owned: Priced<Printing>[] = [];
  const rest: Priced<Printing>[] = [];
  for (const p of printings) (ownedIds.has(p.scryfallId) ? owned : rest).push(p);
  return owned.length === 0 ? printings : [...owned, ...rest];
}

/** Every printing as an image tile — pick an edition by looking at it. */
export function EditionGrid({
  printings,
  selected,
  anyOption,
  notes,
  ownedIds,
  ownedForTradeIds,
  onSelect,
  onClose,
}: {
  printings: Priced<Printing>[];
  selected: string;
  /** Lead with the "any printing" tile (a wish, or a lands-box basic). */
  anyOption?: boolean;
  /** Short annotations per printing (e.g. the trade board's "×2, 1 for trade"). */
  notes?: Map<string, string>;
  /** Exact printings the user owns — these tiles get a double-check ownership badge. */
  ownedIds?: Set<string>;
  /** Of the owned printings, the ones with copies for trade — their tile gets the purple tag instead. */
  ownedForTradeIds?: Set<string>;
  onSelect: (scryfallId: string) => void;
  onClose: () => void;
}) {
  // A card can have forty printings, and scrolling art to find "the Modern
  // Horizons 2 one" is slower than typing it. Set name, set code and collector
  // number all match, since those are the three things printed on the card.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? printings.filter(
        (p) =>
          p.setName.toLowerCase().includes(q) ||
          p.set.toLowerCase().includes(q) ||
          p.collectorNumber.toLowerCase().includes(q),
      )
    : printings;
  return (
    <Sheet onClose={onClose} className="edition-picker-sheet" title="All printings">
        <input
          type="search"
          className="edition-grid-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by set, code or number"
          aria-label="Search printings"
        />
        {q && shown.length === 0 && <p className="fine-print">No printing matches that.</p>}
        <div className="edition-grid">
          {/* "Any printing" has no set name to search, so it only shows unfiltered. */}
          {anyOption && !q && (
            <button className={selected === ANY_PRINTING ? 'edition-tile edition-tile-selected' : 'edition-tile'} onClick={() => onSelect(ANY_PRINTING)}>
              <span className="edition-tile-ph">Any printing</span>
              <span className="edition-tile-caption">No specific edition</span>
            </button>
          )}
          {shown.map((p) => (
            <EditionTile
              key={p.scryfallId}
              printing={p}
              selected={p.scryfallId === selected}
              year
              onClick={() => onSelect(p.scryfallId)}
              badges={
                ownedIds?.has(p.scryfallId) &&
                (ownedForTradeIds?.has(p.scryfallId) ? (
                  <span className="tile-badge own-trade" title="You own this printing · marked for trade">
                    <Icon name="tradelist" size={13} />
                  </span>
                ) : (
                  <span className="tile-badge own-yes" title="You own this exact printing">
                    <Icon name="checkDouble" size={13} />
                  </span>
                ))
              }
              sub={notes?.get(p.scryfallId) ?? formatPrice(p) ?? ''}
            />
          ))}
        </div>
    </Sheet>
  );
}
