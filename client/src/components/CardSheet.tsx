import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CollectionEntry, Condition, ContainerKind, CopyPrefs, DeckBoard, DeckFormat, Finish, OracleCard, Priced, PriceHistory, Printing, SlotShape, SpecialCondition, UserEvent, WishLine, WishlistEntry } from '@mtg/shared';
import { CONDITIONS, FINISHES, specialLabel } from '@mtg/shared';
import {
  addDeckCard,
  addToCollection,
  addToWishlist,
  moveDeckCard,
  removeDeckCard,
  removeFromCollection,
  removeFromWishlist,
  updateCollectionEntry,
  updateDeckCard,
  updateWishlistEntry,
} from '../db/dataAccess.js';
import { getPrintingsForOracle } from '../db/queries.js';
import { canJoinCommandZone, isBasicLand, isNonDeckCard } from '../deck/legality.js';
import { BOARD_LABEL, boardOptions } from '../deck/boards.js';
import { CONTAINER_META } from '../deck/containers.js';
import { claimKeyOf, type FilingCopy } from '../deck/filing.js';
import { useFiling } from '../deck/useFiling.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { PlacementPills } from './PlacementBadge.js';
import { db } from '../db/schema.js';
import { getPriceHistory } from '../price/tracking.js';
import { getMergedPriceHistory } from '../price/serverHistory.js';
import { historyChange, type HistoryChange } from '../price/history.js';
import { preferredScryfallId } from '../cardDb/preferredPrinting.js';
import { CardHistory } from './CardHistory.js';
import { ContainerPickerSheet } from './ContainerPickerSheet.js';
import { CopyPicker, FINISH_LABELS } from './CopyPicker.js';
import { SpecialConditionsField } from './SpecialConditions.js';
import { EventSheet } from './EventSheet.js';
import { useOpenCollectionSearch, useOpenDbSearch } from './GlobalSearch.js';
import { Icon, type IconName } from './icons.js';
import { OptionsMenu } from './OptionsMenu.js';
import { OracleSearchChip, useOracleSelection } from './OracleSearchChip.js';
import { SealedWithCardSheet } from '../sealed/SealedWithCardSheet.js';
import { PriceChartSheet } from './PriceChart.js';
import { PriceTrend } from './PriceTrend.js';
import { useToast } from './Toast.js';
import type { HistoryEntry } from '../history/useHistoryEntries.js';
import { formatPrice, pricedForFinish } from './CardSorting.js';
import { ManaCost, SymbolText } from './ManaCost.js';
import { SetSymbol } from './SetSymbol.js';
import { EditionPicker } from './EditionPicker.js';
import { TagField } from './TagField.js';
import { useDismiss } from './useDismiss.js';

// Bottom-sheet for a card's details, in six modes the caller names outright
// (see CardSheetProps, which carries what each one needs and nothing else):
//  - add: add the card somewhere new — where depends on addTarget (collection
//    with edition/condition/qty/…, wishlist, tradelist, or a deck)
//  - edit: edit an existing collection entry — covers the tradelist via the
//    "for trade" quantity (beta plan §4/§6)
//  - wish: edit a wishlist line — edition (incl. "any printing") and quantity
//  - deck: edit a deck slot's quantity
//  - session: edit a scan-session line in memory — Apply reports the values
//    through onApply instead of writing to Dexie
//  - info: app-wide card info — image, printings, price + history
//
// Any mode can step sideways into add mode ("Add to your collection" from a card
// you're only viewing, "Got it" on a wish): `addFlow` names the list and the
// sheet turns into the real add form for it, so nothing about the copy is
// guessed on the user's behalf. Cancel steps back to where they were.

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
function addLabel(target: AddTarget): string {
  if (target.kind === 'deck') {
    const meta = CONTAINER_META[target.containerKind ?? 'deck'];
    if (meta.kind !== 'deck') return `Add to ${meta.noun}`;
  }
  return ADD_LABEL[target.kind];
}

/** The three personal lists a card can be filed into, in button order:
 *  the sheet leads with the list it was opened from and offers the other two
 *  as compact +icon quick-adds. */
type ListKind = 'collection' | 'tradelist' | 'wishlist';
const LIST_META: Record<ListKind, { label: string; icon: IconName; title: string }> = {
  collection: { label: 'Collection', icon: 'collection', title: 'Add to collection' },
  tradelist: { label: 'Tradelist', icon: 'tradelist', title: 'Add to tradelist' },
  wishlist: { label: 'Wishlist', icon: 'wishlist', title: 'Add to wishlist' },
};
const LIST_ORDER: ListKind[] = ['collection', 'tradelist', 'wishlist'];

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

/** Sentinel for the "any printing" edition option in wish mode. */
const ANY_PRINTING = '';

// Lives with the copy tiles that spell a finish out; re-exported here because
// every other caller reaches for it through the card sheet.
export { FINISH_LABELS };
export const LANGS =['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht'];

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

/** What every mode of the sheet needs. */
interface CardSheetCommon {
  oracleCard: Priced<OracleCard>;
  /** Preselect a specific printing (e.g. the one named in a trade line). */
  initialScryfallId?: string;
  /** Open on a specific tab (e.g. deep-link to History from the edit history). */
  initialTab?: 'details' | 'history';
  /**
   * Printings to group first in the Edition dropdown, each with a short note
   * (e.g. "×2, 1 for trade") — the trade board uses this to surface the
   * editions the relevant person actually has.
   */
  highlightPrintings?: { label: string; notes: Map<string, string> };
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
        onAdded?: (copy: { scryfallId: string; condition: Condition; finish: Finish; lang: string }) => void;
      }
    | {
        /** The card and its printings, no editing. */
        mode: 'info';
        /** Someone else's wish (Community): their edition (incl. "any printing"),
         *  minimum condition, finish and language, as a disabled form. */
        wishView?: WishLine;
      }
  );

export function CardSheet(props: CardSheetProps) {
  const { oracleCard, initialScryfallId, initialTab, highlightPrintings, onClose } = props;
  // The current mode's own props, unpacked once. Everything below reads these
  // rather than narrowing `props` at each of the three dozen sites that ask.
  const entry = props.mode === 'edit' ? props.entry : undefined;
  const wishEntry = props.mode === 'wish' ? props.wishEntry : undefined;
  const wishView = props.mode === 'info' ? props.wishView : undefined;
  const deckCard = props.mode === 'deck' ? props.deckCard : undefined;
  const sessionCard = props.mode === 'session' ? props.sessionCard : undefined;
  const onApply = props.mode === 'session' ? props.onApply : undefined;
  const applyLabel = props.mode === 'session' ? props.applyLabel : undefined;
  const hideRemove = props.mode === 'session' ? props.hideRemove === true : false;
  const addTarget = props.mode === 'add' ? props.addTarget : undefined;
  const onAdded = props.mode === 'add' ? props.onAdded : undefined;

  // Stepping sideways into an add form from another mode (see the note above):
  // the list being added to, or null for "the sheet as its caller opened it".
  const [addFlow, setAddFlow] = useState<ListKind | null>(null);
  const mode = addFlow ? 'add' : props.mode;
  const editing = mode === 'edit';
  const openCollectionSearch = useOpenCollectionSearch();
  const openDbSearch = useOpenDbSearch();
  // Highlighting a phrase in the rules text offers to search the database for it.
  const oracleSelection = useOracleSelection(oracleCard.oracleText, oracleCard.name);
  const toast = useToast();
  // An owned collection entry opens read-only with an Edit toggle; add/wish/
  // deck/session are always a form; info is never editable.
  const [editMode, setEditMode] = useState(false);
  const canToggleEdit = mode === 'edit';
  const formEditable = mode === 'add' || mode === 'wish' || mode === 'deck' || mode === 'session' || (mode === 'edit' && editMode);
  /** An owned copy being looked at, not edited: it reads as a line, not a form. */
  const readOnlyEntry = mode === 'edit' && !editMode;
  const addTo: AddTarget = addFlow ? { kind: addFlow } : (mode === 'add' && addTarget) || { kind: 'collection' };
  // Wishlist adds default to "any printing"; deck slots don't store an edition
  // at all, so those variants drop the collection-specific fields below.
  const wishAdd = mode === 'add' && addTo.kind === 'wishlist';
  const deckAdd = mode === 'add' && addTo.kind === 'deck';
  // Adding into a real deck (not a binder or box): only then are the sideboard
  // and command-zone buttons meaningful.
  const deckAddIsDeck = deckAdd && (addTo.kind !== 'deck' || (addTo.containerKind ?? 'deck') === 'deck');
  // A token, emblem, or art card can never be a real deck card (see
  // isNonDeckCard) — offering it doesn't belong in mainboard/sideboard/command
  // zone, only in the deck's token board.
  const cardIsToken = isNonDeckCard(oracleCard);
  // Who's in the command zone right now. The command-zone buttons need the
  // actual cards, not just a count: a Background or a Partner is only offered
  // when it pairs with whoever is already there (see canJoinCommandZone).
  const commandZoneDeckId =
    deckCard?.commanderDeck && deckCard.deckId
      ? deckCard.deckId
      : deckAddIsDeck && addTo.kind === 'deck' && addTo.format === 'commander'
        ? addTo.deckId
        : undefined;
  const commandZone = useLiveQuery(
    async () => {
      if (!commandZoneDeckId) return [];
      const rows = await db.deckCards.where('[deckId+board]').equals([commandZoneDeckId, 'commander']).toArray();
      const oracles = await db.oracleCards.bulkGet(rows.map((r) => r.oracleId));
      return oracles.filter((o): o is OracleCard => !!o);
    },
    [commandZoneDeckId],
    [] as OracleCard[],
  );
  // Basic lands in a container can be "any printing": whatever's on top of the
  // lands box. Offered when filing a basic into a container or editing such a
  // slot; the default when the container is a deck, since nobody sleeves 24
  // specific Islands. Binders and boxes hold real cardboard, so they opt in.
  const basicAny = (deckAdd || mode === 'deck') && isBasicLand(oracleCard);
  const basicAnyDefault = basicAny && (deckAddIsDeck || !!deckCard?.anyBasic);
  // The zones this slot could move to. Only a deck has any (storage is one
  // pile), and the command zone check must not count the slot being moved as
  // someone it has to pair with — it's the card doing the moving.
  const zones =
    mode === 'deck' && (deckCard?.containerKind ?? 'deck') === 'deck'
      ? boardOptions({
          cards: [oracleCard],
          commanderDeck: !!deckCard?.commanderDeck,
          commandZone: commandZone.filter((o) => o.oracleId !== oracleCard.oracleId),
          from: deckCard?.board,
        })
      : [];
  // Viewing someone else's wish (Community): the same wish fields, but the
  // sheet is read-only, so nothing here is editable.
  const wishInfo = mode === 'info' && !!wishView;
  // Editing, adding or viewing a wish: condition/finish/lang are all optional
  // and lead with an "Any" choice (a wish isn't for one specific copy).
  const wishMode = mode === 'wish' || wishAdd || wishInfo;
  // A container slot works the same way: it says what the deck wants of the copy
  // filling it, so every field can sit on "any" — until you pick a copy out of
  // your collection, which fills them all in.
  const deckPrefs = mode === 'deck' || deckAdd;
  const anyPrefs = wishMode || deckPrefs;
  // Add mode into a personal list: which list leads (the primary button). The
  // other two ride along as compact +icon quick-adds, so a card found while
  // searching one list can still be filed anywhere. A context-free ('default')
  // search leads with the collection.
  const listAddKind: ListKind | null =
    mode !== 'add'
      ? null
      : addTo.kind === 'default'
        ? 'collection'
        : addTo.kind === 'collection' || addTo.kind === 'tradelist' || addTo.kind === 'wishlist'
          ? addTo.kind
          : null;
  const collectionFields =
    mode === 'edit' ||
    (mode === 'add' && (addTo.kind === 'collection' || addTo.kind === 'tradelist' || addTo.kind === 'default'));
  // The condition/finish/lang selects show for collection entries and for wishes
  // and container slots (as "Any"-able preferences); "For trade" stays gated on
  // collectionFields alone. A lands-box basic is detached from the collection, so
  // there is nothing for it to prefer.
  const showCfl = collectionFields || wishMode || deckPrefs;
  // Session lines only edit the fields their scan target tracks.
  const showCondition = mode === 'session' ? sessionCard!.condition !== undefined : showCfl;
  const showFinish = mode === 'session' ? sessionCard!.finish !== undefined : showCfl;
  const showLang = mode === 'session' ? sessionCard!.lang !== undefined : showCfl;
  const [printings, setPrintings] = useState<Priced<Printing>[]>([]);
  // A printing this card is already tied to: the copy in the collection, the
  // deck's recorded edition, a scanned card, or the one the caller was showing.
  const recordedId = entry?.scryfallId ?? deckCard?.scryfallId ?? sessionCard?.scryfallId ?? initialScryfallId;
  // Which edition the art should show isn't known at first paint: the printings
  // are a Dexie read away, and with nothing recorded the preferred-printing
  // lookup may still move us off the card DB's default. Painting before both
  // settle flashes the wrong edition for a frame, so the frame stays empty
  // until they do.
  const [printingsLoaded, setPrintingsLoaded] = useState(false);
  const [preferredSettled, setPreferredSettled] = useState(!!recordedId || wishMode || mode === 'deck');
  const editionResolved = printingsLoaded && preferredSettled;
  // In wish mode (and for a lands-box basic) the empty string means "any
  // printing" — no specific edition.
  const [scryfallId, setScryfallId] = useState(
    wishMode
      ? wishEntry?.scryfallId ?? wishView?.scryfallId ?? ANY_PRINTING
      : basicAnyDefault
        ? ANY_PRINTING
        : // A slot that pins no edition means it: "any printing" is a real answer
          // here, not a gap to fill with the card's default.
          mode === 'deck'
          ? deckCard!.scryfallId ?? ANY_PRINTING
          : recordedId ?? oracleCard.defaultScryfallId,
  );
  /** The edition picker is sitting on "any printing" — a basic from the lands box. */
  const anyBasicPicked = basicAny && scryfallId === ANY_PRINTING;
  // Empty string is the "Any" sentinel, used only in wish mode (mirrors
  // ANY_PRINTING for the edition). Collection/edit/session modes stay concrete.
  const [condition, setCondition] = useState<Condition | ''>(
    entry?.condition ??
      sessionCard?.condition ??
      (anyPrefs ? wishEntry?.condition ?? wishView?.condition ?? deckCard?.condition ?? '' : 'NM'),
  );
  const [finish, setFinish] = useState<Finish | ''>(
    entry?.finish ??
      sessionCard?.finish ??
      (anyPrefs ? wishEntry?.finish ?? wishView?.finish ?? deckCard?.finish ?? '' : 'nonfoil'),
  );
  const [lang, setLang] = useState<string>(
    entry?.lang ?? sessionCard?.lang ?? (anyPrefs ? wishEntry?.lang ?? wishView?.lang ?? deckCard?.lang ?? '' : 'en'),
  );
  const [quantity, setQuantity] = useState(
    entry?.quantity ?? wishEntry?.quantity ?? wishView?.quantity ?? deckCard?.quantity ?? sessionCard?.quantity ?? 1,
  );
  const [forTrade, setForTrade] = useState(entry?.quantityForTrade ?? (addTo.kind === 'tradelist' ? 1 : 0));
  // What's remarkable about this piece of cardboard (altered, signed, …).
  // Collection-only: a wish or a deck slot asks nothing about it, because
  // matching a card never does.
  const [special, setSpecial] = useState<SpecialCondition[]>(entry?.special ?? []);
  // Slot tags ride along with Save/Cancel like every other field on the sheet.
  const [tags, setTags] = useState<string[]>(deckCard?.tags ?? []);
  // Which zone the slot sits in. Editable like every other field on this form:
  // picking another one and saving moves the card, rather than making the user
  // remove it here and add it again over there. Deliberately not called `board`:
  // save() takes a `board` parameter (the board an *add* targets), and a slot
  // being moved must not read that.
  const [zone, setZone] = useState<DeckBoard>(deckCard?.board ?? 'main');
  const [busy, setBusy] = useState(false);
  const [trend, setTrend] = useState<HistoryChange | null>(null);
  const [priceHistory, setPriceHistory] = useState<PriceHistory | null>(null);
  const [tab, setTab] = useState<'details' | 'history'>(initialTab ?? 'details');
  // Visual "view all editions" grid, layered over the sheet.
  const [allEditions, setAllEditions] = useState(false);
  // The sparkline blown up: full price chart with axes and event markers.
  const [chartOpen, setChartOpen] = useState(false);
  const [sealedOpen, setSealedOpen] = useState(false);
  // "Pick one from my collection" (container slots): the owned-copies overlay.
  const [pickingCopy, setPickingCopy] = useState(false);
  // The copy they're holding was never added: a nested add form, whose result
  // becomes this slot's copy.
  const [addingCopy, setAddingCopy] = useState(false);
  // "File this copy": the deck/binder/box picker, from a card you own.
  const [pickingContainer, setPickingContainer] = useState(false);
  // History rows expand into their inline price editor. Its own toggle, not the
  // form's: correcting what you paid is reading-your-own-history work, and every
  // mode's History tab shows your own events.
  const [historyEdit, setHistoryEdit] = useState(false);
  // Event info modal opened from the History tab (out of edit mode), plus a
  // nested card sheet when the user drills from that event into another card.
  const [eventEntry, setEventEntry] = useState<HistoryEntry | null>(null);
  const [nestedCard, setNestedCard] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);
  // The card landed on one of your lists: the sheet says so where the button
  // was, then shows itself out. A toast would fire off-screen behind the sheet,
  // and the answer belongs on the thing you just pressed.
  const [added, setAdded] = useState<ListKind | null>(null);
  useDismiss(busy ? null : onClose);

  // onClose is usually a fresh arrow from the caller, so hold it in a ref: the
  // goodbye timer must not restart every time the parent re-renders.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!added) return;
    const t = window.setTimeout(() => closeRef.current(), 800);
    return () => window.clearTimeout(t);
  }, [added]);

  useEffect(() => {
    let live = true;
    void getPrintingsForOracle(oracleCard.oracleId)
      .then((ps) => {
        if (live) setPrintings(ps);
      })
      // Even a failed read has to release the art: an empty frame forever is
      // worse than the oracle's default image.
      .finally(() => {
        if (live) setPrintingsLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [oracleCard.oracleId]);

  // Nothing tied this sheet to an edition (adding a card the caller didn't
  // resolve a printing for), so honour the printing preference rather than
  // silently landing on the card DB's representative one. Skipped in wish mode,
  // where "any printing" is the point (a lands-box basic sits on the same empty
  // sentinel, which the setter below leaves alone).
  useEffect(() => {
    if (recordedId || wishMode || mode === 'deck') return;
    let live = true;
    void preferredScryfallId(oracleCard)
      .then((id) => {
        // Don't stomp a choice the user made in the edition picker meanwhile.
        if (live && id !== oracleCard.defaultScryfallId) {
          setScryfallId((cur) => (cur === oracleCard.defaultScryfallId ? id : cur));
        }
      })
      .finally(() => {
        if (live) setPreferredSettled(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleCard.oracleId]);

  // Recorded price history for the shown printing (collection cards are
  // tracked automatically); "any printing" falls back to the default one.
  // The local row paints immediately; signed-in users then get the server
  // archive merged in (a longer window than any single device recorded).
  const shownId = scryfallId || oracleCard.defaultScryfallId;
  useEffect(() => {
    let live = true;
    let merged = false;
    void getPriceHistory(shownId).then((h) => {
      if (!live || merged) return;
      setPriceHistory(h ?? null);
      setTrend(h ? historyChange(h) : null);
    });
    void getMergedPriceHistory(shownId).then((h) => {
      if (!live) return;
      merged = true;
      setPriceHistory(h ?? null);
      setTrend(h ? historyChange(h) : null);
    });
    return () => {
      live = false;
    };
  }, [shownId]);

  const printing = useMemo(
    () => printings.find((p) => p.scryfallId === scryfallId),
    [printings, scryfallId],
  );
  // "Do I own this card (any printing)?" — live so it reflects edits made from
  // this very sheet. Shown everywhere except plain edit mode, where the entry
  // being edited already proves ownership.
  const ownedEntries = useLiveQuery(
    () => db.collection.where('oracleId').equals(oracleCard.oracleId).toArray(),
    [oracleCard.oracleId],
  );
  // Where this printing is filed (deck / binder / box) — the pills under the
  // name. Follows the edition picker: switch editions and the pills follow. When
  // the sheet is about one concrete copy (a collection entry) or one slot, its
  // finish/condition/language narrow the pills further, so two copies of a card
  // that differ only in language each point at their own deck. A search hit or a
  // fresh add knows no copy, so it stays per printing.
  const placements = usePlacementIndex();
  const { file, sheet: filingSheet } = useFiling();
  const copyPrefs: CopyPrefs | undefined =
    mode === 'edit' || mode === 'deck'
      ? { condition: condition || undefined, finish: finish || undefined, lang: lang || undefined }
      : undefined;
  const placement = placements?.lookup(oracleCard.oracleId, shownId, copyPrefs);
  const ownedQty = ownedEntries?.reduce((s, e) => s + e.quantity, 0) ?? 0;
  const ownedForTrade = ownedEntries?.reduce((s, e) => s + e.quantityForTrade, 0) ?? 0;
  // Do we own the exact printing currently shown? (Not just some other edition.)
  const ownsExact = !!scryfallId && (ownedEntries?.some((e) => e.scryfallId === scryfallId) ?? false);
  // The exact printings we own — the "view all editions" grid double-checks these.
  const ownedIds = useMemo(() => new Set((ownedEntries ?? []).map((e) => e.scryfallId)), [ownedEntries]);
  // The copies themselves, newest edition first, for "pick one from my collection".
  const ownedCopies = useMemo(() => {
    const order = new Map(printings.map((p, i) => [p.scryfallId, i]));
    const rank = (e: CollectionEntry) => order.get(e.scryfallId) ?? printings.length;
    return [...(ownedEntries ?? [])].sort(
      (a, b) => rank(a) - rank(b) || CONDITIONS.indexOf(a.condition) - CONDITIONS.indexOf(b.condition),
    );
  }, [ownedEntries, printings]);
  // The "In your collection" badge jumps to a Collection search for this card's
  // name, never from a scan session — leaving that sheet mid-scan would throw
  // the session away — or edit mode, which already shows the entry itself.
  const canOpenInCollection = mode !== 'session' && mode !== 'edit';
  // Printings with copies marked for trade — their edition tile gets the purple tag.
  const ownedForTradeIds = useMemo(
    () => new Set((ownedEntries ?? []).filter((e) => e.quantityForTrade > 0).map((e) => e.scryfallId)),
    [ownedEntries],
  );
  // Editions the caller flagged (owned / on a tradelist) group first in the
  // dropdown; within the rest, editions the user owns lead so their printing is
  // the easy pick (and its double-check badge is the first thing they see).
  const highlighted = highlightPrintings ? printings.filter((p) => highlightPrintings.notes.has(p.scryfallId)) : [];
  const otherPrintings = orderByOwned(
    highlighted.length > 0 ? printings.filter((p) => !highlightPrintings!.notes.has(p.scryfallId)) : printings,
    ownedIds,
  );
  // Picking an edition is not editing: in info mode it only changes which
  // printing you're looking at (art, price, history, placement pills all
  // follow), and info mode writes nothing. So every mode gets the picker and the
  // visual grid — except a wish you're only reading, where the
  // edition is that person's answer, not yours to flip through.
  const editionPickable = formEditable || (mode === 'info' && !wishInfo);
  // A wish can want any finish (esp. an "any printing" wish, where no single
  // printing constrains the choice); a collection entry is limited to what the
  // selected printing actually comes in. A slot follows its edition where it pins
  // one — asking for a foil that was never printed would never match a copy.
  const availableFinishes = wishMode
    ? FINISHES
    : printing?.finishes ?? (deckPrefs ? FINISHES : (['nonfoil'] as Finish[]));

  // Full-size image + price for the currently-selected printing (falls back to the oracle default).
  const cardImage = printing?.imageNormal ?? oracleCard.imageNormal ?? printing?.imageSmall ?? oracleCard.imageSmall ?? null;
  // Back face for double-faced cards (transform / modal DFC / …); absent for single-faced ones.
  const cardBackImage =
    printing?.imageBackNormal ?? oracleCard.imageBackNormal ?? printing?.imageBackSmall ?? oracleCard.imageBackSmall ?? null;
  const cardPrice = formatPrice(pricedForFinish(printing, finish || 'nonfoil'), oracleCard) ?? '—';
  // Flip state for the shown card art; reset when switching editions (a
  // different printing may not be double-faced at all).
  const [flipped, setFlipped] = useState(false);
  useEffect(() => setFlipped(false), [scryfallId]);
  const shownImage = flipped && cardBackImage ? cardBackImage : cardImage;
  // Tap the art to read it: the card alone, as large as the screen allows.
  const [zoomed, setZoomed] = useState(false);
  // The first paint of the art waits for the browser to actually decode it —
  // the foil sheen has nothing to shimmer over until then. A latch, not a
  // per-image flag: once the sheet has shown a card, switching editions swaps
  // the art in place instead of blanking the frame.
  const [artShown, setArtShown] = useState(false);
  // The right printing's image didn't load: fall back to the card's default art
  // rather than an empty frame (a wrong edition beats no card at all).
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => setArtFailed(false), [shownImage]);
  const fallbackImage = oracleCard.imageNormal ?? oracleCard.imageSmall ?? null;
  const artSrc = (artFailed && fallbackImage) || shownImage || cardImage;

  // Keep a concrete finish valid for the chosen printing (skip the "Any"
  // sentinel and wish mode, where the finish is a preference, not a real copy).
  useEffect(() => {
    if (!wishMode && printing && finish && !printing.finishes.includes(finish)) {
      setFinish(printing.finishes[0] ?? 'nonfoil');
    }
  }, [printing, finish, wishMode]);

  const clampedForTrade = Math.min(forTrade, quantity);

  /** Session mode: the edited line as reported back, mirroring the hidden fields.
   *  Session mode is never wish mode, so these are always concrete values. */
  function sessionValues(qty: number): SessionCardValues {
    return {
      scryfallId,
      quantity: qty,
      lang: sessionCard?.lang !== undefined ? lang : undefined,
      finish: sessionCard?.finish !== undefined ? (finish as Finish) : undefined,
      condition: sessionCard?.condition !== undefined ? (condition as Condition) : undefined,
    };
  }

  // A wish (and a container slot) stores its preferences as-is ('' → undefined =
  // "any"); a collection entry needs a concrete condition/finish/lang, so fall
  // back to the defaults.
  const wishPrefs = { condition: condition || undefined, finish: finish || undefined, lang: lang || undefined };
  const concrete = { condition: condition || 'NM', finish: finish || 'nonfoil', lang: lang || 'en' };

  /** In add mode `dest` names the list a button chose; when omitted the add
   *  follows the sheet's own scope (collection for a context-free search). */
  async function save(board: DeckBoard = 'main', dest?: ListKind) {
    setBusy(true);
    // Add mode first: the sheet may have stepped into it from a wish, a deck
    // slot or a card it's only showing, and those props are all still set.
    if (mode === 'add') {
      if (!(await saveAdd(board, dest))) {
        setBusy(false);
        return;
      }
      // Onto one of the three lists: flash which one, and let the timer close.
      if (addTo.kind !== 'deck') {
        setAdded(listDest(dest));
        return;
      }
    } else if (sessionCard) {
      onApply?.(sessionValues(quantity));
    } else if (wishEntry) {
      await updateWishlistEntry(wishEntry.id, { scryfallId: scryfallId || null, ...wishPrefs, quantity });
    } else if (deckCard) {
      await updateDeckCard(deckCard.id, { quantity, scryfallId, anyBasic: anyBasicPicked, wants: wishPrefs, tags });
      // The move goes last so the slot carries this form's quantity and tags
      // into whatever it merges with on the far side.
      if (zone !== (deckCard.board ?? 'main')) await moveDeckCard(deckCard.id, zone);
    } else if (editing && entry) {
      await updateCollectionEntry(entry.id, {
        scryfallId,
        ...concrete,
        quantity,
        quantityForTrade: clampedForTrade,
        special,
      });
    }
    onClose();
  }

  /** The add half of `save`. Returns false when the user backed out of the
   *  filing prompt, so the sheet stays open on the form they were filling. */
  async function saveAdd(board: DeckBoard, dest?: ListKind): Promise<boolean> {
    if (addTo.kind === 'deck') {
      // A slot naming a real copy of yours (edition + all three traits) is
      // cardboard being filed, so it goes through the filing flow and may offer
      // to take the card out of wherever it was. Anything vaguer is a brew line
      // that claims no copy — straight in, merging by card and board as ever.
      const claims = !anyBasicPicked && !!claimKeyOf({ ...wishPrefs, scryfallId });
      if (claims) {
        const filed = await file(addTo.deckId, [filingCopy(board)]);
        if (!filed) return false;
      } else {
        await addDeckCard({
          deckId: addTo.deckId,
          oracleId: oracleCard.oracleId,
          ...(anyBasicPicked ? { anyBasic: true } : { scryfallId, wants: wishPrefs }),
          board,
          quantity,
        });
      }
      return true;
    }
    const where = listDest(dest);
    if (where === 'wishlist') {
      await addToWishlist({ oracleId: oracleCard.oracleId, scryfallId: scryfallId || null, ...wishPrefs, quantity });
    } else {
      // Collection and tradelist both write a collection entry (the latter
      // starts with copies marked for trade). A wishlist-origin sheet can
      // sit on "any printing", so fall back to a concrete edition here.
      const addedId = scryfallId || oracleCard.defaultScryfallId;
      await addToCollection({
        oracleId: oracleCard.oracleId,
        scryfallId: addedId,
        ...concrete,
        quantity,
        quantityForTrade: where === 'tradelist' ? clampedForTrade || 1 : clampedForTrade,
        special,
      });
      onAdded?.({ scryfallId: addedId, ...concrete });
    }
    return true;
  }

  /** Which of the three personal lists an add lands on. An explicit button
   *  (dest) wins; otherwise the sheet's own scope decides, and a context-free
   *  ('default') search files to the collection. */
  function listDest(dest?: ListKind): ListKind {
    return dest ?? (addTo.kind === 'wishlist' || addTo.kind === 'tradelist' ? addTo.kind : 'collection');
  }

  /** This sheet's card as cardboard being filed somewhere, for the prompt. */
  function filingCopy(board: DeckBoard = 'main'): FilingCopy {
    return {
      oracleId: oracleCard.oracleId,
      scryfallId,
      quantity,
      board,
      wants: wishPrefs,
      label: oracleCard.name,
      sub: [printing?.setName, condition, finish, lang !== 'en' ? lang : null].filter(Boolean).join(' · '),
    };
  }

  /** Enter in a quantity field commits the sheet, like a form submit. */
  function saveOnEnter(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !busy) void save();
  }

  async function del() {
    setBusy(true);
    // A session line isn't stored anywhere yet — quantity 0 tells the scan
    // list to drop it.
    if (sessionCard) onApply?.(sessionValues(0));
    else if (wishEntry) await removeFromWishlist(wishEntry.id);
    else if (deckCard) await removeDeckCard(deckCard.id);
    else if (entry) await removeFromCollection(entry.id);
    onClose();
  }

  /**
   * Add this card to one of your own lists from a sheet that isn't about them —
   * a deck slot, a wish you just got hold of, or a card you're only viewing.
   * It turns the sheet into that list's real add form rather than filing a
   * guessed copy, so condition, finish, language and quantity are answered by
   * the person who knows them. Fields carrying an "any" (a slot's or a wish's
   * preference) land on the collection's defaults, since a copy you own is a
   * specific piece of cardboard.
   */
  function startAdd(dest: ListKind) {
    if (!scryfallId && dest !== 'wishlist') setScryfallId(oracleCard.defaultScryfallId);
    if (dest !== 'wishlist') {
      if (!condition) setCondition('NM');
      if (!finish) setFinish('nonfoil');
      if (!lang) setLang('en');
    }
    setForTrade(dest === 'tradelist' ? Math.max(1, forTrade) : 0);
    setAddFlow(dest);
  }

  /** Put this copy in a deck, binder or box, straight from the entry that owns
   *  it — the same filing flow (and move-or-both question) the collection's
   *  bulk "File away" runs, for the one card in front of you. */
  async function fileHere(containerId: string, kind: ContainerKind) {
    setPickingContainer(false);
    setBusy(true);
    const filed = await file(containerId, [filingCopy()]);
    if (filed === null) {
      setBusy(false);
      return;
    }
    const noun = CONTAINER_META[kind].noun;
    // Every copy you own is in there already. Saying "filed" for a write that
    // didn't happen is how you end up filing the same card twice.
    toast(
      filed.filed === 0
        ? `Already in that ${noun}`
        : filed.mode === 'move'
          ? `Moved to ${noun}`
          : `Filed in ${noun}`,
    );
    onClose();
  }

  // Portal to <body>: the sheet must escape any stacking context its opener
  // lives in (e.g. the search overlay), or the tab bar can cover its buttons.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet card-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={mode === 'info' ? oracleCard.name : `${mode === 'add' ? 'Add' : 'Edit'} ${oracleCard.name}`}
      >
        <div className="sheet-head">
          {cardImage || !editionResolved ? (
            // The wrap holds the card's space from the first frame; what goes in
            // it waits until we know the edition and the image has decoded.
            <div className="sheet-card-wrap">
              {editionResolved && artSrc && (
                <button
                  type="button"
                  className="sheet-card-zoom"
                  onClick={() => artShown && setZoomed(true)}
                  aria-label={`Enlarge ${oracleCard.name}`}
                  title="Enlarge"
                >
                  <img
                    className={artShown ? 'sheet-card' : 'sheet-card sheet-card-loading'}
                    src={artSrc}
                    alt={oracleCard.name}
                    onLoad={() => setArtShown(true)}
                    onError={() => {
                      if (!artFailed && fallbackImage && fallbackImage !== artSrc) setArtFailed(true);
                      else setArtShown(true);
                    }}
                  />
                </button>
              )}
              {artShown && finish && finish !== 'nonfoil' && <span className="foil-sheen" aria-hidden />}
              {artShown && cardBackImage && (
                <button
                  type="button"
                  className="sheet-flip"
                  onClick={() => setFlipped((f) => !f)}
                  aria-label="Flip card"
                  title="Flip card"
                >
                  <Icon name="flip" size={16} />
                </button>
              )}
            </div>
          ) : (
            <div className="sheet-card sheet-card-ph">{oracleCard.name}</div>
          )}
          {/* Everything that describes the card rides in the column beside the
              art — name, cost, type, what you own, what it's worth and where
              your copies are filed. That column is as tall as the card, and the
              form below it starts at a fixed place on every card. */}
          <div className="sheet-info">
            <div className="sheet-name-row">
              <div className="sheet-name">{oracleCard.name}</div>
              <OptionsMenu
                label="Card options"
                actions={[
                  {
                    label: 'Find sealed products with this card',
                    icon: 'sealed',
                    onClick: () => setSealedOpen(true),
                  },
                ]}
              />
            </div>
            <div className="result-sub sheet-typeline">
              {oracleCard.manaCost && <ManaCost cost={oracleCard.manaCost} />}
              <span>{oracleCard.typeLine}</span>
            </div>
            {mode !== 'edit' && ownedQty > 0 && (
              <OwnedHere
                qty={ownedQty}
                forTrade={ownedForTrade}
                ownsExact={ownsExact}
                onOpen={
                  canOpenInCollection
                    ? () => {
                        onClose();
                        openCollectionSearch(oracleCard.name);
                      }
                    : undefined
                }
              />
            )}
            <div className="result-price">{cardPrice}</div>
            {trend && trend.points > 1 && <PriceTrend trend={trend} onOpen={() => setChartOpen(true)} />}
            {/* Where the copies live. A binder name can be long, so the pills
                scroll on their own rather than pushing the form down. */}
            {placement && placement.places.length > 0 && (
              <div className="sheet-places">
                <span className="sheet-places-label">Filed in</span>
                <PlacementPills info={placement} onNavigate={onClose} />
              </div>
            )}
          </div>
        </div>

        <div className="seg-row sheet-tabs" role="tablist" aria-label="Card view">
          <button
            role="tab"
            aria-selected={tab === 'details'}
            className={tab === 'details' ? 'seg seg-active' : 'seg'}
            onClick={() => setTab('details')}
          >
            Details
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'seg seg-active' : 'seg'}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </div>

        {/* The one part of the sheet that scrolls. Head, tabs and the action row
            stay put, so the buttons are always in the same place no matter how
            much rules text or history the card carries. */}
        <div className={tab === 'history' ? 'sheet-body sheet-body-history' : 'sheet-body'}>
        {tab === 'history' ? (
          <CardHistory
            oracleCard={oracleCard}
            scryfallId={shownId}
            printings={printings}
            priceHistory={priceHistory}
            editMode={historyEdit}
            onToggleEdit={() => setHistoryEdit((v) => !v)}
            onEventClick={(e: UserEvent) => setEventEntry({ kind: 'single', id: e.id, ts: e.ts, event: e })}
          />
        ) : (
        <>
        {oracleCard.oracleText && (
          <SymbolText className="oracle-text sheet-oracle" text={oracleCard.oracleText} />
        )}
        {oracleSelection && (
          <OracleSearchChip
            selection={oracleSelection}
            onSearch={(query) => {
              onClose();
              openDbSearch(query);
            }}
          />
        )}

        {/* Not a <label>: the picker is a button until it's opened, and a label
            wrapping a button turns its own text into a second trigger. */}
        <div className="field">
          <span>Edition</span>
          <div className="edition-row">
            <EditionPicker
              printings={otherPrintings}
              highlighted={highlighted}
              highlightLabel={highlightPrintings?.label}
              notes={highlightPrintings?.notes}
              selected={scryfallId}
              // A basic in a container spends its "any" on the lands box (the
              // slot is detached from the collection entirely); everything else
              // means "any edition of this card that I own".
              anyLabel={basicAny ? 'Any printing (from your lands box)' : anyPrefs ? 'Any printing' : undefined}
              disabled={!editionPickable}
              onSelect={setScryfallId}
            />
            {editionPickable && printings.length > 0 && (
              <button
                type="button"
                className="edition-grid-btn"
                onClick={() => setAllEditions(true)}
                aria-label="View all editions"
                title="View all editions"
              >
                <Icon name="grid" size={18} />
              </button>
            )}
          </div>
        </div>

        {/* The shortcut that makes a slot concrete: point it at a copy you
            actually have and the edition, finish, condition and language all come
            along, so the double check means "this very card". */}
        {deckPrefs && formEditable && ownedCopies.length > 0 && (
          <button type="button" className="linklike pick-copy-btn" onClick={() => setPickingCopy(true)}>
            <Icon name="collection" size={14} /> Pick one from my collection
          </button>
        )}

        {/* Looking at a copy you own: three greyed-out dropdowns and two dead
            steppers say the same thing as one line, and cost the sheet the room
            the card art wants. The form itself is one tap away. */}
        {readOnlyEntry && (
          <div className="sheet-copy-summary">
            <span>{condition}</span>
            <span>{FINISH_LABELS[(finish || 'nonfoil') as Finish]}</span>
            <span>{(lang || 'en').toUpperCase()}</span>
            {special.length > 0 && <span className="sheet-copy-special">{specialLabel(special)}</span>}
            <span className="sheet-copy-qty">
              ×{quantity}
              {clampedForTrade > 0 ? ` · ${clampedForTrade} for trade` : ''}
            </span>
          </div>
        )}

        {/* A lands-box basic never claims a copy of yours, so it prefers nothing. */}
        {!readOnlyEntry && (showCondition || showFinish || showLang) && !anyBasicPicked && (
        <div className="field-grid">
          {showCondition && (
          <label className="field">
            <span>{anyPrefs ? 'Minimum condition' : 'Condition'}</span>
            <select value={condition} onChange={(e) => setCondition(e.target.value as Condition | '')} disabled={!formEditable}>
              {anyPrefs && <option value="">Any</option>}
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          )}
          {showFinish && (
          <label className="field">
            <span>Finish</span>
            <select value={finish} onChange={(e) => setFinish(e.target.value as Finish | '')} disabled={!formEditable}>
              {anyPrefs && <option value="">Any</option>}
              {availableFinishes.map((f) => (
                <option key={f} value={f}>
                  {FINISH_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          )}
          {showLang && (
          <label className="field">
            <span>Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={!formEditable}>
              {anyPrefs && <option value="">Any</option>}
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          )}
        </div>
        )}

        {(mode !== 'info' || wishInfo) && !readOnlyEntry && (
        <div className="field-grid">
          <label className="field">
            <span>Quantity</span>
            <QtyStepper value={quantity} min={1} disabled={!formEditable} onChange={setQuantity} onEnter={saveOnEnter} />
          </label>
          {collectionFields && (
            <label className="field">
              <span>For trade</span>
              <QtyStepper value={clampedForTrade} min={0} max={quantity} disabled={!formEditable} onChange={setForTrade} onEnter={saveOnEnter} />
            </label>
          )}
        </div>
        )}

        {/* Altered, signed, misprint … : facts about this cardboard, not about
            the card, so only a collection copy is asked. Ticking a box splits the
            copy onto its own line — your altered Bolt stops sharing a row with
            the plain one — while every match (wish, deck slot, owned count)
            carries on ignoring it. */}
        {collectionFields && !readOnlyEntry && (
          <SpecialConditionsField value={special} onChange={setSpecial} disabled={!formEditable} />
        )}

        {/* Which zone the card sits in. A deck's zones are the one thing about a
            slot that used to need a remove and a re-add; now it's a field like
            any other, applied when the sheet is saved. */}
        {formEditable && zones.some((z) => !z.refusal && z.board !== zone) && (
          <div className="field">
            <span>Zone</span>
            <div className="seg-row zone-row" role="radiogroup" aria-label="Zone">
              {zones.map((z) => (
                <button
                  key={z.board}
                  type="button"
                  role="radio"
                  aria-checked={zone === z.board}
                  className={zone === z.board ? 'seg seg-active' : 'seg'}
                  disabled={!!z.refusal && zone !== z.board}
                  title={z.refusal}
                  onClick={() => setZone(z.board)}
                >
                  {z.label}
                </button>
              ))}
            </div>
            {zone !== (deckCard?.board ?? 'main') && (
              <p className="fine-print zone-note">
                Moves out of the {BOARD_LABEL[deckCard?.board ?? 'main'].toLowerCase()} when you save.
              </p>
            )}
          </div>
        )}

        {/* Slot tags: your own labels on this card in this list ("Ramp",
            "Turn-3 play"), which the group-by-tag view reads. */}
        {mode === 'deck' && deckCard?.deckId && (
          <TagField deckId={deckCard.deckId} tags={tags} onChange={setTags} />
        )}

        {/* The slot was emptied out on purpose, and saving names the copy it
            holds — so say so before it quietly goes back on the shelf. */}
        {mode === 'deck' && deckCard?.unfiled && (
          <p className="fine-print">
            This copy is out of the list right now. Saving files it back in.
          </p>
        )}

        </>
        )}
        </div>

        {/* File-into-your-lists affordance, for the modes that aren't about your
            lists: a container slot (yours or not), a wish you just got hold of,
            or any card you're only viewing. Each opens that list's real add
            form — the copy is yours to describe, not ours to guess. */}
        {(mode === 'deck' || deckAdd || mode === 'info') && (
          <div className="sheet-quickadd">
            <span className="sheet-quickadd-label">Add to your</span>
            <div className="sheet-quickadd-btns">
              <button onClick={() => startAdd('collection')} disabled={busy} title="Add to collection">
                <Icon name="collection" size={16} /> Collection
              </button>
              <button onClick={() => startAdd('wishlist')} disabled={busy} title="Add to wishlist">
                <Icon name="wishlist" size={16} /> Wishlist
              </button>
            </div>
          </div>
        )}
        {mode === 'wish' && (
          <div className="sheet-quickadd">
            <span className="sheet-quickadd-label">Got it?</span>
            <div className="sheet-quickadd-btns">
              <button onClick={() => startAdd('collection')} disabled={busy} title="Add to collection">
                <Icon name="collection" size={16} /> Add to collection
              </button>
            </div>
          </div>
        )}
        {/* Cardboard you own, on its way somewhere: same filing flow as the
            collection's bulk "File away", for the one copy in front of you. */}
        {mode === 'edit' && !editMode && (
          <div className="sheet-quickadd">
            <span className="sheet-quickadd-label">File this copy</span>
            <div className="sheet-quickadd-btns">
              <button onClick={() => setPickingContainer(true)} disabled={busy} title="File into a deck, binder or box">
                <Icon name="binder" size={16} /> Into a deck, binder or box
              </button>
            </div>
          </div>
        )}

        {added ? (
          // Where the +List button was a moment ago: the same shape, answered.
          <div className="sheet-actions">
            <p className="sheet-added" role="status">
              <Icon name="check" size={16} /> Added to {LIST_META[added].label.toLowerCase()}{' '}
              <Icon name={LIST_META[added].icon} size={16} />
            </p>
          </div>
        ) : mode === 'info' ? (
          <div className="sheet-actions">
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        ) : canToggleEdit && !editMode ? (
          <div className="sheet-actions">
            <button className="primary" onClick={() => setEditMode(true)}>
              <Icon name="edit" size={16} /> Edit
            </button>
            <button onClick={onClose}>Close</button>
          </div>
        ) : (
          <div className="sheet-actions">
            {mode !== 'add' && !hideRemove && (
              <button className="danger-outline" onClick={del} disabled={busy}>
                Remove
              </button>
            )}
            {/* Stepped into this form from another mode: back out to the sheet
                they were reading, not out of the card entirely. */}
            <button onClick={addFlow ? () => setAddFlow(null) : onClose} disabled={busy}>
              {addFlow ? 'Back' : 'Cancel'}
            </button>
            {deckAdd && addTo.kind === 'deck' && deckAddIsDeck && !cardIsToken && addTo.format === 'commander' && canJoinCommandZone(oracleCard, commandZone) && (
              <button onClick={() => save('commander')} disabled={busy}>
                {commandZone.length === 1 ? 'Add as second commander' : 'Add as commander'}
              </button>
            )}
            {deckAdd && deckAddIsDeck && !cardIsToken && (
              <button onClick={() => save('side')} disabled={busy}>
                Add to sideboard
              </button>
            )}
            {deckAdd && deckAddIsDeck && cardIsToken ? (
              <button className="primary" onClick={() => save('token')} disabled={busy}>
                Add to tokens
              </button>
            ) : listAddKind ? (
              <>
                {LIST_ORDER.filter((k) => k !== listAddKind).map((k) => (
                  <button
                    key={k}
                    className="add-alt"
                    title={LIST_META[k].title}
                    onClick={() => save('main', k)}
                    disabled={busy}
                  >
                    +<Icon name={LIST_META[k].icon} size={16} />
                  </button>
                ))}
                <button className="primary add-primary" onClick={() => save('main', listAddKind)} disabled={busy}>
                  +{LIST_META[listAddKind].label} <Icon name={LIST_META[listAddKind].icon} size={16} />
                </button>
              </>
            ) : (
              <button className="primary" onClick={() => save()} disabled={busy}>
                {mode === 'add' ? addLabel(addTo) : mode === 'session' ? applyLabel ?? 'Apply' : 'Save'}
              </button>
            )}
          </div>
        )}
      </div>

      {zoomed && cardImage && (
        <CardZoom
          image={shownImage ?? cardImage}
          backImage={cardBackImage}
          onFlip={() => setFlipped((f) => !f)}
          alt={oracleCard.name}
          foil={!!finish && finish !== 'nonfoil'}
          onClose={() => setZoomed(false)}
        />
      )}
      {chartOpen && priceHistory && (
        <PriceChartSheet
          name={oracleCard.name}
          subtitle={printing ? `${printing.setName} · #${printing.collectorNumber}` : undefined}
          oracleId={oracleCard.oracleId}
          scryfallId={shownId}
          history={priceHistory}
          onEventClick={(e) => {
            setChartOpen(false);
            setEventEntry({ kind: 'single', id: e.id, ts: e.ts, event: e });
          }}
          onClose={() => setChartOpen(false)}
        />
      )}
      {sealedOpen && (
        <SealedWithCardSheet
          cardName={oracleCard.name}
          scryfallIds={printings.map((p) => p.scryfallId)}
          onClose={() => setSealedOpen(false)}
        />
      )}
      {allEditions && (
        <EditionGrid
          printings={highlighted.length > 0 ? [...highlighted, ...otherPrintings] : otherPrintings}
          selected={scryfallId}
          anyOption={anyPrefs || basicAny}
          notes={highlightPrintings?.notes}
          ownedIds={ownedIds}
          ownedForTradeIds={ownedForTradeIds}
          onSelect={(id) => {
            setScryfallId(id);
            setAllEditions(false);
          }}
          onClose={() => setAllEditions(false)}
        />
      )}
      {pickingCopy && (
        <CopyPicker
          copies={ownedCopies}
          printings={printings}
          selected={{ scryfallId, condition, finish, lang }}
          onSelect={(copy) => {
            setScryfallId(copy.scryfallId);
            setCondition(copy.condition);
            setFinish(copy.finish);
            setLang(copy.lang);
            setPickingCopy(false);
          }}
          onAddCopy={() => {
            setPickingCopy(false);
            setAddingCopy(true);
          }}
          onClose={() => setPickingCopy(false)}
        />
      )}
      {/* Add the missing copy without losing the slot behind it: the nested
          sheet writes the collection entry, hands it back, and this form ends up
          exactly where picking an existing copy would have left it. */}
      {addingCopy && (
        <CardSheet
          mode="add"
          oracleCard={oracleCard}
          initialScryfallId={scryfallId || oracleCard.defaultScryfallId}
          addTarget={{ kind: 'collection' }}
          onAdded={(copy) => {
            setScryfallId(copy.scryfallId);
            setCondition(copy.condition);
            setFinish(copy.finish);
            setLang(copy.lang);
          }}
          onClose={() => setAddingCopy(false)}
        />
      )}
      {pickingContainer && (
        <ContainerPickerSheet
          title="File this copy"
          label={`Where does your ${oracleCard.name} live?`}
          onPick={(id, kind) => void fileHere(id, kind)}
          onClose={() => setPickingContainer(false)}
        />
      )}
      {eventEntry && (
        <EventSheet
          entry={eventEntry}
          onOpenCard={(oracle, scryfallId) => {
            setEventEntry(null);
            // Same card: just switch this sheet to its history. Different card
            // (a batch line): open a nested sheet on its history tab.
            if (oracle.oracleId === oracleCard.oracleId) setTab('history');
            else setNestedCard({ oracle, scryfallId });
          }}
          onClose={() => setEventEntry(null)}
        />
      )}
      {nestedCard && (
        <CardSheet
          mode="info"
          oracleCard={nestedCard.oracle}
          initialScryfallId={nestedCard.scryfallId}
          initialTab="history"
          onClose={() => setNestedCard(null)}
        />
      )}
      {filingSheet}
    </div>,
    document.body,
  );
}

/** Quantity field as a −/+ stepper: taps cover the common case, so the soft
 *  keyboard (which covers most of the sheet on phones) only appears when the
 *  user really wants to type — and then it's the numeric one. */
function QtyStepper({
  value,
  min,
  max,
  disabled,
  onChange,
  onEnter,
}: {
  value: number;
  min: number;
  max?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
  onEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const clamp = (v: number) => Math.max(min, max !== undefined ? Math.min(max, v) : v);
  return (
    <div className="qty-stepper">
      <button type="button" onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= min} aria-label="One less">
        <Icon name="minus" size={16} />
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={onEnter}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={() => onChange(clamp(value + 1))}
        disabled={disabled || (max !== undefined && value >= max)}
        aria-label="One more"
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

/**
 * The "In your collection (×N)" badge under the card name. When `onOpen` is
 * given it's a button that jumps to that copy's sheet on the Collection screen
 * (chevron included, so it reads as a way out of here) — handy when the deck slot
 * you're looking at says the wrong thing and the fix belongs on the entry.
 */
function OwnedHere({
  qty,
  forTrade,
  ownsExact,
  onOpen,
}: {
  qty: number;
  forTrade: number;
  ownsExact: boolean;
  onOpen?: () => void;
}) {
  const cls = `badge sheet-owned ${forTrade > 0 ? 'own-trade' : 'own-yes'}`;
  const detail = ownsExact ? ' · including this exact printing' : ' · other printing(s)';
  const owned = forTrade > 0 ? `You own ${qty} (${forTrade} for trade)` : `You own ${qty}`;
  const body = (
    <>
      <Icon name={forTrade > 0 ? 'tradelist' : ownsExact ? 'checkDouble' : 'check'} size={13} />
      In your collection (×{qty}
      {forTrade > 0 ? `, ${forTrade} for trade` : ''})
      {onOpen && <Icon name="chevronRight" size={13} />}
    </>
  );
  if (!onOpen) return <div className={cls} title={owned + detail}>{body}</div>;
  return (
    <button type="button" className={`${cls} sheet-owned-link`} title={`${owned}${detail} · open it in your collection`} onClick={onOpen}>
      {body}
    </button>
  );
}

/**
 * Move editions the user owns to the front, keeping the original (newest-first)
 * order within the owned and unowned groups. Returns the input untouched when
 * nothing is owned, so the common case allocates nothing.
 */
function orderByOwned(printings: Priced<Printing>[], ownedIds?: Set<string>): Priced<Printing>[] {
  if (!ownedIds || ownedIds.size === 0) return printings;
  const owned: Priced<Printing>[] = [];
  const rest: Priced<Printing>[] = [];
  for (const p of printings) (ownedIds.has(p.scryfallId) ? owned : rest).push(p);
  return owned.length === 0 ? printings : [...owned, ...rest];
}

/**
 * The card, alone, as big as the screen allows — for when the oracle text on
 * the sheet's thumbnail is too small to actually read. Tap anywhere (or
 * Escape / back) to dismiss; the flip button stays, and shares the sheet's flip
 * state so the face you were looking at is the face you get.
 */
function CardZoom({
  image,
  backImage,
  onFlip,
  alt,
  foil,
  onClose,
}: {
  image: string;
  backImage: string | null;
  onFlip: () => void;
  alt: string;
  foil: boolean;
  onClose: () => void;
}) {
  useDismiss(onClose);
  return (
    <div
      className="card-zoom-backdrop"
      role="dialog"
      aria-label={alt}
      onClick={(e) => {
        // Nested inside the card sheet's own backdrop, whose click handler
        // would otherwise close the sheet underneath us too.
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="card-zoom-frame">
        <img className="card-zoom-img" src={image} alt={alt} />
        {foil && <span className="foil-sheen" aria-hidden />}
        {backImage && (
          <button
            type="button"
            className="sheet-flip card-zoom-flip"
            onClick={(e) => {
              e.stopPropagation();
              onFlip();
            }}
            aria-label="Flip card"
            title="Flip card"
          >
            <Icon name="flip" size={18} />
          </button>
        )}
      </div>
    </div>
  );
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
  useDismiss(onClose);
  // stopPropagation on the backdrop: this overlay nests inside the card
  // sheet's backdrop, whose click handler would otherwise also close the sheet.
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="sheet edition-picker-sheet" role="dialog" aria-label="All editions" onClick={(e) => e.stopPropagation()}>
        <div className="edition-picker-head">
          <h2>All editions</h2>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="edition-grid">
          {anyOption && (
            <button className={selected === ANY_PRINTING ? 'edition-tile edition-tile-selected' : 'edition-tile'} onClick={() => onSelect(ANY_PRINTING)}>
              <span className="edition-tile-ph">Any printing</span>
              <span className="edition-tile-caption">No specific edition</span>
            </button>
          )}
          {printings.map((p) => {
            const img = p.imageSmall ?? p.imageNormal;
            return (
              <button
                key={p.scryfallId}
                className={p.scryfallId === selected ? 'edition-tile edition-tile-selected' : 'edition-tile'}
                onClick={() => onSelect(p.scryfallId)}
              >
                <span className="edition-tile-art">
                  {img ? <img src={img} alt={p.setName} loading="lazy" /> : <span className="edition-tile-ph">{p.setName}</span>}
                  {ownedIds?.has(p.scryfallId) &&
                    (ownedForTradeIds?.has(p.scryfallId) ? (
                      <span className="tile-badge own-trade" title="You own this printing · marked for trade">
                        <Icon name="tradelist" size={13} />
                      </span>
                    ) : (
                      <span className="tile-badge own-yes" title="You own this exact printing">
                        <Icon name="checkDouble" size={13} />
                      </span>
                    ))}
                </span>
                <span className="edition-tile-caption">
                  <SetSymbol set={p.set} title={p.setName} /> {p.set.toUpperCase()} #{p.collectorNumber} · {p.releasedAt.slice(0, 4)}
                </span>
                <span className="edition-tile-sub">{notes?.get(p.scryfallId) ?? formatPrice(p) ?? ''}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

