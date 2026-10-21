import type {
  CollectionEntry,
  Condition,
  ContainerKind,
  DeckBoard,
  DeckFormat,
  Finish,
  OracleCard,
  Priced,
  PriceHistory,
  Printing,
  SlotShape,
  WishLine,
  WishlistEntry,
} from '@mtg/shared';
import { containerMetaFor } from '../../deck/containers.js';
import type { HistoryEntry } from '../../history/useHistoryEntries.js';
import type { IconName } from '../icons.js';

/** Where add mode sends the card (mirrors the context-sensitive search).
 *  'default' is search from a context-free page: the collection form, with
 *  wishlist/tradelist offered as alternative buttons. */
export type AddTarget =
  | { kind: 'collection' }
  | { kind: 'wishlist' }
  | { kind: 'tradelist' }
  /** A deck, binder or box; `containerKind` (default 'deck') picks the wording. */
  | { kind: 'deck'; deckId: string; containerKind?: ContainerKind; format?: DeckFormat }
  | { kind: 'default' };

const ADD_LABEL: Record<AddTarget['kind'], string> = {
  collection: 'Add to collection',
  wishlist: 'Add to wishlist',
  tradelist: 'Add to tradelist',
  deck: 'Add to mainboard',
  default: 'Add to collection',
};

/** The primary button's label. Storage has one pile, so it names the container
 *  ("Add to box") where a deck names the board it's filling. */
export function addLabel(target: AddTarget): string {
  if (target.kind === 'deck') {
    const meta = containerMetaFor(target);
    if (meta.kind !== 'deck') return `Add to ${meta.noun}`;
  }
  return ADD_LABEL[target.kind];
}

/** The three personal lists a card can be filed into, in button order:
 *  the sheet leads with the list it was opened from and offers the other two
 *  as short "+ Wish" style quick-adds. */
export type ListKind = 'collection' | 'tradelist' | 'wishlist';
export const LIST_META: Record<ListKind, { label: string; short: string; icon: IconName; title: string }> = {
  collection: { label: 'Collection', short: 'Collection', icon: 'collection', title: 'Add to collection' },
  tradelist: { label: 'Tradelist', short: 'Trade', icon: 'tradelist', title: 'Add to tradelist' },
  wishlist: { label: 'Wishlist', short: 'Wish', icon: 'wishlist', title: 'Add to wishlist' },
};
export const LIST_ORDER: ListKind[] = ['collection', 'tradelist', 'wishlist'];

/**
 * A scan-session line as the sheet edits it. Fields the scan target doesn't
 * track (e.g. condition for a deck) are left undefined and stay hidden;
 * quantity 0 means "remove the line".
 */
export interface SessionCardValues {
  scryfallId: string;
  quantity: number;
  lang?: string;
  finish?: Finish;
  condition?: Condition;
}

/** The four dropdowns on the traits row; only one is ever open. */
export type TraitKey = 'condition' | 'finish' | 'lang' | 'special';

/** Sentinel for the "any printing" edition option in wish mode. */
export const ANY_PRINTING = '';

/** A deck slot the sheet can edit. The slot's own fields come from SlotShape;
 *  the rest is the container context the Zone field needs. */
export type DeckSlotEdit = SlotShape & {
  id: string;
  quantity: number;
  board?: DeckBoard;
  /** The deck this slot lives in, so the sheet can read its command zone. */
  deckId?: string;
  commanderDeck?: boolean;
  /** Which kind of container holds the slot; only a deck has zones to move between. */
  containerKind?: ContainerKind;
};

/** What a parent sheet already read for this card, so a sheet stacked on it
 *  (adding the copy a slot is missing) doesn't read it all again. */
export interface CardSheetLoaded {
  printings: Priced<Printing>[];
  /** The price row for one printing; only used while that printing is shown. */
  priceHistory?: { scryfallId: string; history: PriceHistory | null };
}

/** What every mode of the sheet needs. */
interface CardSheetCommon {
  oracleCard: Priced<OracleCard>;
  /** Preselect a specific printing (e.g. the one named in a trade line). */
  initialScryfallId?: string;
  /** Open with the Collection history sheet already up (deep-link from the
   *  collection-wide history, where the card was named by an event). */
  openHistory?: boolean;
  /**
   * Printings to group first in the Edition dropdown, each with a short note
   * (e.g. "×2, 1 for trade") — the trade board uses this to surface the
   * editions the relevant person actually has.
   */
  highlightPrintings?: { label: string; notes: Map<string, string> };
  loaded?: CardSheetLoaded;
  onClose: () => void;
}

/**
 * The six jobs this sheet does, each carrying exactly what it needs.
 *
 * The mode used to be *inferred* from which of a pile of optional props the
 * caller filled in (`wishEntry ? 'wish' : deckCard ? 'deck' : entry ? …`), which
 * is how a sheet accumulates when it gains one caller at a time. That let every
 * illegal combination through the type system — a wish entry and a deck slot at
 * once, a session card with no onApply, an addTarget on a mode that never adds —
 * and left the reader working out the precedence to know what a call site does.
 * Naming the mode costs one prop and makes all of that unrepresentable.
 */
export type CardSheetProps = CardSheetCommon &
  (
    | {
        /** An owned copy: opens as a line with an Edit toggle. */
        mode: 'edit';
        entry: CollectionEntry;
        /** The other copies stacked under the same tile (stack printings on):
         *  the sheet offers a strip to step between them. Includes `entry`. */
        copies?: CollectionEntry[];
      }
    | {
        /** Edit a wishlist line (edition + quantity) instead of the collection. */
        mode: 'wish';
        wishEntry: WishlistEntry;
      }
    | {
        /** Edit a deck slot's quantity + printing, and its zone. */
        mode: 'deck';
        deckCard: DeckSlotEdit;
        /** The other slots of this card stacked under the same tile. Includes `deckCard`. */
        slots?: DeckSlotEdit[];
      }
    | {
        /** Edit a scan/trade line held in memory; Apply reports back, nothing is written. */
        mode: 'session';
        sessionCard: SessionCardValues;
        onApply: (values: SessionCardValues) => void;
        /** Label for the primary commit button (defaults to "Apply"). */
        applyLabel?: string;
        /** Hide the Remove button (e.g. when composing a brand-new line). */
        hideRemove?: boolean;
      }
    | {
        /** A form that puts a new copy on one of your lists. */
        mode: 'add';
        /** Where the add goes; defaults to the collection. */
        addTarget?: AddTarget;
        /** The copy that just landed, reported so the sheet that opened this one
         *  can point a slot at it. */
        onAdded?: (copy: CopyTraits) => void;
      }
    | {
        /** The card and its printings, no editing. */
        mode: 'info';
        /** Someone else's wish (Community): their edition (incl. "any printing"),
         *  minimum condition, finish and language, as a disabled form. */
        wishView?: WishLine;
      }
  );

export type SheetMode = CardSheetProps['mode'];

/** A real copy's identity: what picking one from the collection fills in. */
export interface CopyTraits {
  scryfallId: string;
  condition: Condition;
  finish: Finish;
  lang: string;
}

/**
 * Whatever is layered over the sheet. They come one at a time, so one value
 * rather than a dozen booleans that could all be true at once. The collection
 * history is the one layer others stack on (an event from it, then a card from
 * that event), so those two remember whether to drop back to it.
 */
export type Overlay =
  | { kind: 'history' }
  | { kind: 'editions' }
  | { kind: 'chart' }
  | { kind: 'sealed' }
  | { kind: 'legality' }
  | { kind: 'zoom' }
  /** "Pick one from my collection" (container slots): the owned-copies list. */
  | { kind: 'pickCopy' }
  /** The copy they're holding was never added: a nested add form, whose result
   *  becomes this slot's copy. */
  | { kind: 'addCopy' }
  /** "File this copy": the deck/binder/box picker, from a card you own. */
  | { kind: 'pickContainer' }
  /** ...then, with more than one copy on the shelf, which of them goes in. */
  | { kind: 'fileCopies'; id: string; name: string; containerKind: ContainerKind }
  | { kind: 'event'; entry: HistoryEntry; overHistory: boolean }
  | { kind: 'nested'; oracle: Priced<OracleCard>; scryfallId?: string; overHistory: boolean };
