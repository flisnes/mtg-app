import type { ReactNode } from 'react';
import type { DeckBoard, DeckFormat, OracleCard, Priced, Printing } from '@mtg/shared';
import { addDeckCard, addToCollection, addToWishlist, newId } from '../db/dataAccess.js';
import { isBasicLand, isCompanion } from '../deck/legality.js';
import { containerMetaFor } from '../deck/containers.js';
import type { AddTarget } from '../components/cardSheet/types.js';
import { Icon } from '../components/icons.js';
import { useToast } from '../components/Toast.js';
import { useUndoToast } from '../components/useUndoToast.js';

// The add buttons on a search result row, and what `+` does with the result
// under the pointer. Both follow the search target: a deck adds to its boards,
// a list page to that list, anywhere else offers the generic trio.

/** The three lists a result row quick-adds to, in button order. Each name is
 *  also its icon. Row buttons stay +icon: a list row has no room for words, and
 *  the card sheet carries the labelled ones. */
type QuickList = 'collection' | 'wishlist' | 'tradelist';
const QUICK_LISTS: QuickList[] = ['collection', 'wishlist', 'tradelist'];

/** The printing a result is showing: the user's preference or a `set:` pin,
 *  else the card DB's representative. Quick-adds use it, NM / nonfoil / en;
 *  the sheet is for detail. */
export const shownId = (card: OracleCard, printing?: Printing) => printing?.scryfallId ?? card.defaultScryfallId;

export function useQuickAdd(
  target: AddTarget,
  /** The deck's format, once known: Commander swaps the sideboard for the command zone. */
  format: DeckFormat | undefined,
): {
  quickAdd: (card: Priced<OracleCard>, printing?: Priced<Printing>) => void;
  actionsFor: (card: Priced<OracleCard>, printing?: Priced<Printing>) => ReactNode;
  targetHint: string | null;
} {
  const toast = useToast();
  const undoToast = useUndoToast();
  // Wording for the container being searched from (a deck, binder or box).
  const containerMeta = containerMetaFor(target);

  async function quickList(list: QuickList, card: OracleCard, printing?: Printing) {
    const eventId = newId();
    if (list === 'wishlist') await addToWishlist({ oracleId: card.oracleId, scryfallId: null, eventId });
    else
      await addToCollection({
        oracleId: card.oracleId,
        scryfallId: shownId(card, printing),
        condition: 'NM',
        finish: 'nonfoil',
        lang: 'en',
        ...(list === 'tradelist' ? { quantityForTrade: 1 } : {}),
        eventId,
      });
    undoToast(`${card.name} added to ${list}`, eventId);
  }
  const quickListButton = (list: QuickList, card: OracleCard, printing?: Printing) => (
    <button key={list} title={`Add to ${list}`} aria-label={`Add to ${list}`} onClick={() => quickList(list, card, printing)}>
      +<Icon name={list} size={16} />
    </button>
  );

  async function quickDeck(card: OracleCard, deckId: string, board: DeckBoard, noun = 'deck', printing?: Printing) {
    // A basic land in a deck defaults to "any printing": whatever's on top of
    // the lands box. Binders and boxes hold real cardboard, so they don't.
    const anyBasic = containerMeta.kind === 'deck' && isBasicLand(card);
    // The printing the result is showing, like the collection quick-adds: tap +
    // on an edition tile and that edition is what lands in the container.
    await addDeckCard({ deckId, oracleId: card.oracleId, board, anyBasic, scryfallId: shownId(card, printing) });
    if (board === 'companion') {
      toast(`${card.name} is the companion`);
      return;
    }
    const suffix =
      board === 'side' ? ' (sideboard)' : board === 'commander' ? ' (commander)' : board === 'maybe' ? ' (considering)' : '';
    toast(`Added ${card.name}${suffix} to ${noun}${anyBasic ? ' (any printing)' : ''}`);
  }

  /** What `+` does: whatever the first button in actionsFor would have done. */
  function quickAdd(card: Priced<OracleCard>, printing?: Priced<Printing>): void {
    switch (target.kind) {
      case 'deck':
        void quickDeck(card, target.deckId, 'main', containerMeta.kind === 'deck' ? 'deck' : containerMeta.noun, printing);
        return;
      case 'wishlist':
      case 'tradelist':
        void quickList(target.kind, card, printing);
        return;
      default:
        void quickList('collection', card, printing);
    }
  }

  function actionsFor(card: Priced<OracleCard>, printing?: Priced<Printing>): ReactNode {
    switch (target.kind) {
      case 'deck': {
        // Storage is one pile: a single quick-add, no board buttons.
        if (containerMeta.kind !== 'deck') {
          return (
            <button
              title={`Add to ${containerMeta.noun}`}
              onClick={() => quickDeck(card, target.deckId, 'main', containerMeta.noun, printing)}
            >
              +<Icon name={containerMeta.icon} size={16} />
            </button>
          );
        }
        return (
          <>
            <button title="Add to mainboard" onClick={() => quickDeck(card, target.deckId, 'main', 'deck', printing)}>
              +Main
            </button>
            {/* Commander has no sideboard; its companion gets a zone of its own. */}
            {format !== 'commander' && (
              <button title="Add to sideboard" onClick={() => quickDeck(card, target.deckId, 'side', 'deck', printing)}>
                +SB
              </button>
            )}
            <button title="Add to considering" onClick={() => quickDeck(card, target.deckId, 'maybe', 'deck', printing)}>
              +Maybe
            </button>
            {format === 'commander' && (
              <button title="Add as commander" onClick={() => quickDeck(card, target.deckId, 'commander', 'deck', printing)}>
                +Cmdr
              </button>
            )}
            {format === 'commander' && isCompanion(card) && (
              <button title="Set as companion" onClick={() => quickDeck(card, target.deckId, 'companion', 'deck', printing)}>
                +Comp
              </button>
            )}
          </>
        );
      }
      case 'collection':
      case 'wishlist':
      case 'tradelist':
        return quickListButton(target.kind, card, printing);
      default:
        return <>{QUICK_LISTS.map((list) => quickListButton(list, card, printing))}</>;
    }
  }

  const targetHint = {
    deck:
      containerMeta.kind === 'deck'
        ? 'Adding a result puts it in this deck (main or sideboard).'
        : `Adding a result files it in this ${containerMeta.noun}.`,
    collection: 'Adding a result puts it in your collection.',
    wishlist: 'Adding a result puts it on your wishlist.',
    tradelist: 'Adding a result puts it in your collection, marked for trade.',
    default: null,
  }[target.kind];

  return { quickAdd, actionsFor, targetHint };
}
