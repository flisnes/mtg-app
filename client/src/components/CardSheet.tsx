import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CollectionEntry, Condition, ContainerKind, DeckBoard, DeckFormat, Finish, OracleCard, Priced, PriceHistory, Printing, UserEvent, WishLine, WishlistEntry } from '@mtg/shared';
import { CONDITIONS, FINISHES } from '@mtg/shared';
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
import { canJoinCommandZone, isBasicLand } from '../deck/legality.js';
import { CONTAINER_META } from '../deck/containers.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { PlacementPills } from './PlacementBadge.js';
import { db } from '../db/schema.js';
import { getPriceHistory } from '../price/tracking.js';
import { getMergedPriceHistory } from '../price/serverHistory.js';
import { historyChange, type HistoryChange } from '../price/history.js';
import { fmtPriceIn } from '../price/rates.js';
import { preferredScryfallId } from '../cardDb/preferredPrinting.js';
import { CardHistory } from './CardHistory.js';
import { EventSheet } from './EventSheet.js';
import { Icon, type IconName } from './icons.js';
import { OptionsMenu } from './OptionsMenu.js';
import type { HistoryEntry } from '../history/useHistoryEntries.js';
import { formatPrice, pricedForFinish } from './CardSorting.js';
import { ManaCost, SymbolText } from './ManaCost.js';
import { SetSymbol } from './SetSymbol.js';
import { Sparkline } from './Sparkline.js';
import { useDismiss } from './useDismiss.js';

// Bottom-sheet for a card's details, in six modes:
//  - add (default): add the card somewhere new — where depends on addTarget
//    (collection with edition/condition/qty/…, wishlist, tradelist, or a deck)
//  - edit (entry): edit an existing collection entry — covers the tradelist
//    via the "for trade" quantity (beta plan §4/§6)
//  - wish (wishEntry): edit a wishlist line — edition (incl. "any printing")
//    and quantity
//  - deck (deckCard): edit a deck slot's quantity
//  - session (sessionCard): edit a scan-session line in memory — Apply reports
//    the values through onApply instead of writing to Dexie
//  - info (readOnly): app-wide card info — image, printings, price + history

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

export const FINISH_LABELS: Record<Finish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };
export const LANGS = ['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht'];

/** One Edition dropdown entry, optionally annotated (e.g. "×2, 1 for trade"). */
function printingOption(p: Priced<Printing>, note?: string) {
  return (
    <option key={p.scryfallId} value={p.scryfallId}>
      {p.setName} · #{p.collectorNumber} · {p.releasedAt.slice(0, 4)}
      {note ? ` · ${note}` : ''}
    </option>
  );
}

export function CardSheet({
  oracleCard,
  entry,
  wishEntry,
  wishView,
  deckCard,
  sessionCard,
  onApply,
  applyLabel,
  hideRemove = false,
  initialScryfallId,
  initialTab,
  addTarget,
  readOnly = false,
  onEditionChange,
  highlightPrintings,
  onClose,
}: {
  oracleCard: Priced<OracleCard>;
  entry?: CollectionEntry;
  /** Edit this wishlist line (edition + quantity) instead of the collection. */
  wishEntry?: WishlistEntry;
  /** Read-only view of someone else's wish (Community): show their edition
   *  (incl. "any printing"), minimum condition, finish and language as a
   *  disabled form. Only meaningful in info mode. */
  wishView?: WishLine;
  /** Edit this deck slot's quantity + printing instead of the collection.
   *  Commander context (only set from a commander-format deck) adds the
   *  move-to/from-command-zone action to the sheet. */
  deckCard?: {
    id: string;
    quantity: number;
    scryfallId?: string;
    /** The slot is an "any printing" basic (see DeckCard.anyBasic). */
    anyBasic?: boolean;
    /** What the slot wants of the copy filling it; undefined = any. */
    condition?: Condition;
    finish?: Finish;
    lang?: string;
    board?: DeckBoard;
    /** The deck this slot lives in, so the sheet can read its command zone. */
    deckId?: string;
    commanderDeck?: boolean;
  };
  /** Edit this scan-session line in memory; Apply reports through onApply. */
  sessionCard?: SessionCardValues;
  /** Session mode: called with the edited values instead of writing to Dexie. */
  onApply?: (values: SessionCardValues) => void;
  /** Session mode: label for the primary commit button (defaults to "Apply"). */
  applyLabel?: string;
  /** Session mode: hide the Remove button (e.g. when composing a brand-new line). */
  hideRemove?: boolean;
  /** Preselect a specific printing (e.g. the one named in a trade line). */
  initialScryfallId?: string;
  /** Open on a specific tab (e.g. deep-link to History from the edit history). */
  initialTab?: 'details' | 'history';
  /** Add mode only: where the add goes (defaults to the collection). */
  addTarget?: AddTarget;
  /** Info-only: show the card and its printings, no collection editing. */
  readOnly?: boolean;
  /**
   * When set, the Edition dropdown stays editable even in info mode and every
   * change is reported here — the trade board uses this to re-print an offer
   * line in place without leaving the sheet.
   */
  onEditionChange?: (scryfallId: string) => void;
  /**
   * Printings to group first in the Edition dropdown, each with a short note
   * (e.g. "×2, 1 for trade") — the trade board uses this to surface the
   * editions the relevant person actually has.
   */
  highlightPrintings?: { label: string; notes: Map<string, string> };
  onClose: () => void;
}) {
  const mode = wishEntry ? 'wish' : deckCard ? 'deck' : entry ? 'edit' : sessionCard ? 'session' : readOnly ? 'info' : 'add';
  const editing = mode === 'edit';
  const navigate = useNavigate();
  // An owned collection entry opens read-only with an Edit toggle; add/wish/
  // deck/session are always a form; info is never editable.
  const [editMode, setEditMode] = useState(false);
  const canToggleEdit = mode === 'edit';
  const formEditable = mode === 'add' || mode === 'wish' || mode === 'deck' || mode === 'session' || (mode === 'edit' && editMode);
  const addTo: AddTarget = (mode === 'add' && addTarget) || { kind: 'collection' };
  // Wishlist adds default to "any printing"; deck slots don't store an edition
  // at all, so those variants drop the collection-specific fields below.
  const wishAdd = mode === 'add' && addTo.kind === 'wishlist';
  const deckAdd = mode === 'add' && addTo.kind === 'deck';
  // Adding into a real deck (not a binder or box): only then are the sideboard
  // and command-zone buttons meaningful.
  const deckAddIsDeck = deckAdd && (addTo.kind !== 'deck' || (addTo.containerKind ?? 'deck') === 'deck');
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
  const [busy, setBusy] = useState(false);
  const [trend, setTrend] = useState<HistoryChange | null>(null);
  const [priceHistory, setPriceHistory] = useState<PriceHistory | null>(null);
  const [tab, setTab] = useState<'details' | 'history'>(initialTab ?? 'details');
  // Visual "view all editions" grid, layered over the sheet.
  const [allEditions, setAllEditions] = useState(false);
  // "Pick one from my collection" (container slots): the owned-copies overlay.
  const [pickingCopy, setPickingCopy] = useState(false);
  // Filter the (often very long) Edition dropdown by set name or set code.
  const [editionQuery, setEditionQuery] = useState('');
  // Event info modal opened from the History tab (out of edit mode), plus a
  // nested card sheet when the user drills from that event into another card.
  const [eventEntry, setEventEntry] = useState<HistoryEntry | null>(null);
  const [nestedCard, setNestedCard] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);
  useDismiss(busy ? null : onClose);

  useEffect(() => {
    void getPrintingsForOracle(oracleCard.oracleId).then(setPrintings);
  }, [oracleCard.oracleId]);

  // Nothing tied this sheet to an edition (adding a card the caller didn't
  // resolve a printing for), so honour the printing preference rather than
  // silently landing on the card DB's representative one. Skipped in wish mode,
  // where "any printing" is the point (a lands-box basic sits on the same empty
  // sentinel, which the setter below leaves alone).
  useEffect(() => {
    if (recordedId || wishMode || mode === 'deck') return;
    let live = true;
    void preferredScryfallId(oracleCard).then((id) => {
      // Don't stomp a choice the user made in the edition picker meanwhile.
      if (live && id !== oracleCard.defaultScryfallId) {
        setScryfallId((cur) => (cur === oracleCard.defaultScryfallId ? id : cur));
      }
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
  // name. Follows the edition picker: switch editions and the pills follow.
  const placements = usePlacementIndex();
  const placement = placements?.lookup(oracleCard.oracleId, shownId);
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
  // The copy the "In your collection" badge taps through to: the shown printing
  // if you own it, else whatever you do own. Gives the user a one-tap route from
  // a deck slot (or a search hit) to the entry itself, where quantity, condition
  // and the rest can be corrected. Never from a scan session — leaving that sheet
  // mid-scan would throw the session away.
  const collectionTarget =
    mode === 'session' || mode === 'edit'
      ? undefined
      : ownedCopies.find((e) => e.scryfallId === shownId) ?? ownedCopies[0];
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
  // Dropdown filter: match set name or set code. Always keep the current
  // selection visible so the native <select> displays the right value.
  const editionQ = editionQuery.trim().toLowerCase();
  const matchesQuery = (p: Priced<Printing>) =>
    p.scryfallId === scryfallId ||
    !editionQ ||
    p.setName.toLowerCase().includes(editionQ) ||
    p.set.toLowerCase().includes(editionQ);
  const visibleHighlighted = highlighted.filter(matchesQuery);
  const visibleOther = otherPrintings.filter(matchesQuery);
  const showEditionSearch = (formEditable || !!onEditionChange) && printings.length > 6;
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
    if (sessionCard) {
      onApply?.(sessionValues(quantity));
    } else if (wishEntry) {
      await updateWishlistEntry(wishEntry.id, { scryfallId: scryfallId || null, ...wishPrefs, quantity });
    } else if (deckCard) {
      await updateDeckCard(deckCard.id, { quantity, scryfallId, anyBasic: anyBasicPicked, wants: wishPrefs });
    } else if (editing && entry) {
      await updateCollectionEntry(entry.id, {
        scryfallId,
        ...concrete,
        quantity,
        quantityForTrade: clampedForTrade,
      });
    } else if (addTo.kind === 'deck') {
      await addDeckCard({
        deckId: addTo.deckId,
        oracleId: oracleCard.oracleId,
        ...(anyBasicPicked ? { anyBasic: true } : { scryfallId, wants: wishPrefs }),
        board,
        quantity,
      });
    } else {
      // Add mode into one of the three personal lists. An explicit button
      // (dest) wins; otherwise the sheet's own scope decides, and a
      // context-free ('default') search files to the collection.
      const where: ListKind = dest ?? (addTo.kind === 'wishlist' || addTo.kind === 'tradelist' ? addTo.kind : 'collection');
      if (where === 'wishlist') {
        await addToWishlist({ oracleId: oracleCard.oracleId, scryfallId: scryfallId || null, ...wishPrefs, quantity });
      } else {
        // Collection and tradelist both write a collection entry (the latter
        // starts with copies marked for trade). A wishlist-origin sheet can
        // sit on "any printing", so fall back to a concrete edition here.
        await addToCollection({
          oracleId: oracleCard.oracleId,
          scryfallId: scryfallId || oracleCard.defaultScryfallId,
          ...concrete,
          quantity,
          quantityForTrade: where === 'tradelist' ? clampedForTrade || 1 : clampedForTrade,
        });
      }
    }
    onClose();
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

  /** File a card into the user's own collection/wishlist from a sheet that
   *  otherwise offers no such action — a deck slot (own deck), a wishlist line
   *  ("got it"), or any card you're only viewing (info mode). One tap:
   *  collection takes the shown printing (NM/nonfoil/en); a wish stays "any
   *  printing" like the normal wishlist add. */
  async function quickAdd(dest: 'collection' | 'wishlist') {
    setBusy(true);
    if (dest === 'collection') {
      await addToCollection({
        oracleId: oracleCard.oracleId,
        scryfallId: scryfallId || oracleCard.defaultScryfallId,
        condition: 'NM',
        finish: 'nonfoil',
        lang: 'en',
        quantity: 1,
      });
    } else {
      await addToWishlist({ oracleId: oracleCard.oracleId, quantity: 1 });
    }
    onClose();
  }

  // Portal to <body>: the sheet must escape any stacking context its opener
  // lives in (e.g. the search overlay), or the tab bar can cover its buttons.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={mode === 'info' ? oracleCard.name : `${mode === 'add' ? 'Add' : 'Edit'} ${oracleCard.name}`}
      >
        <div className="sheet-head">
          {cardImage ? (
            <div className="sheet-card-wrap">
              <img className="sheet-card" src={shownImage ?? cardImage} alt={oracleCard.name} />
              {finish && finish !== 'nonfoil' && <span className="foil-sheen" aria-hidden />}
              {cardBackImage && (
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
          <div className="sheet-info">
            <div className="sheet-name">{oracleCard.name}</div>
            {mode !== 'edit' && ownedQty > 0 && (
              <OwnedHere
                qty={ownedQty}
                forTrade={ownedForTrade}
                ownsExact={ownsExact}
                onOpen={
                  collectionTarget
                    ? () => {
                        onClose();
                        navigate(`/collection?entry=${encodeURIComponent(collectionTarget.id)}`);
                      }
                    : undefined
                }
              />
            )}
            {oracleCard.manaCost && (
              <div className="result-sub">
                <ManaCost cost={oracleCard.manaCost} />
              </div>
            )}
            <div className="result-sub">{oracleCard.typeLine}</div>
            <div className="result-price">{cardPrice}</div>
            {trend && trend.points > 1 && <PriceTrend trend={trend} />}
          </div>
        </div>

        {/* Where the copies live. Full width under the head, since a binder or
            box name is longer than the info column beside the art. */}
        {placement && placement.places.length > 0 && (
          <div className="sheet-places">
            <span className="sheet-places-label">Filed in</span>
            <PlacementPills info={placement} onNavigate={onClose} />
          </div>
        )}

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

        {tab === 'history' ? (
          <>
            <CardHistory
              oracleCard={oracleCard}
              scryfallId={shownId}
              printings={printings}
              priceHistory={priceHistory}
              editMode={editMode}
              onEventClick={(e: UserEvent) => setEventEntry({ kind: 'single', id: e.id, ts: e.ts, event: e })}
            />
            <div className="sheet-actions">
              {canToggleEdit && (
                <button onClick={() => setEditMode((v) => !v)}>{editMode ? 'Done' : 'Edit'}</button>
              )}
              <button className="primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
        <>
        {oracleCard.oracleText && (
          <SymbolText className="oracle-text" text={oracleCard.oracleText} />
        )}

        <label className="field">
          <span>Edition</span>
          {showEditionSearch && (
            <input
              type="text"
              className="edition-search"
              value={editionQuery}
              onChange={(e) => setEditionQuery(e.target.value)}
              placeholder="Filter by set name or code (e.g. MH2)"
              aria-label="Filter editions by set name or code"
            />
          )}
          <div className="edition-row">
            <div className={`edition-select${printing ? ' with-symbol' : ''}`}>
              {printing && <SetSymbol set={printing.set} className="edition-symbol" title={printing.setName} />}
              <select
                value={scryfallId}
                onChange={(e) => {
                  setScryfallId(e.target.value);
                  onEditionChange?.(e.target.value);
                }}
                disabled={!formEditable && !onEditionChange}
              >
                {/* A basic in a container spends its "any" on the lands box (the
                    slot is detached from the collection entirely); everything
                    else means "any edition of this card that I own". */}
                {basicAny ? (
                  <option value={ANY_PRINTING}>Any printing (from your lands box)</option>
                ) : (
                  anyPrefs && <option value={ANY_PRINTING}>Any printing</option>
                )}
                {highlighted.length > 0 ? (
                  <>
                    {visibleHighlighted.length > 0 && (
                      <optgroup label={highlightPrintings!.label}>
                        {visibleHighlighted.map((p) => printingOption(p, highlightPrintings!.notes.get(p.scryfallId)))}
                      </optgroup>
                    )}
                    {visibleOther.length > 0 && (
                      <optgroup label="Other printings">{visibleOther.map((p) => printingOption(p))}</optgroup>
                    )}
                  </>
                ) : (
                  visibleOther.map((p) => printingOption(p))
                )}
              </select>
            </div>
            {(formEditable || !!onEditionChange) && printings.length > 0 && (
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
        </label>

        {/* The shortcut that makes a slot concrete: point it at a copy you
            actually have and the edition, finish, condition and language all come
            along, so the double check means "this very card". */}
        {deckPrefs && formEditable && ownedCopies.length > 0 && (
          <button type="button" className="linklike pick-copy-btn" onClick={() => setPickingCopy(true)}>
            <Icon name="collection" size={14} /> Pick one from my collection
          </button>
        )}

        {/* A lands-box basic never claims a copy of yours, so it prefers nothing. */}
        {(showCondition || showFinish || showLang) && !anyBasicPicked && (
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

        {(mode !== 'info' || wishInfo) && (
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

        {/* File-into-your-lists affordance. In your own deck both lists lead as
            buttons; on your own wishlist "got it" → collection leads; everywhere
            you're only viewing a card (info mode) it tucks into a ⋯ menu so the
            sheet stays uncluttered. */}
        {mode === 'deck' && (
          <div className="sheet-quickadd">
            <span className="sheet-quickadd-label">Add to your</span>
            <div className="sheet-quickadd-btns">
              <button onClick={() => quickAdd('collection')} disabled={busy} title="Add to collection">
                <Icon name="collection" size={16} /> Collection
              </button>
              <button onClick={() => quickAdd('wishlist')} disabled={busy} title="Add to wishlist">
                <Icon name="wishlist" size={16} /> Wishlist
              </button>
            </div>
          </div>
        )}
        {mode === 'wish' && (
          <div className="sheet-quickadd">
            <span className="sheet-quickadd-label">Got it?</span>
            <div className="sheet-quickadd-btns">
              <button onClick={() => quickAdd('collection')} disabled={busy} title="Add to collection">
                <Icon name="collection" size={16} /> Add to collection
              </button>
            </div>
          </div>
        )}
        {mode === 'info' && (
          <div className="sheet-quickadd">
            <span className="sheet-quickadd-label">Add to your lists</span>
            <div className="sheet-quickadd-btns">
              <OptionsMenu
                openUp
                label="Add to your lists"
                actions={[
                  { label: 'Add to collection', icon: 'collection', onClick: () => quickAdd('collection') },
                  { label: 'Add to wishlist', icon: 'wishlist', onClick: () => quickAdd('wishlist') },
                ]}
              />
            </div>
          </div>
        )}

        {mode === 'info' ? (
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
            <button onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {deckCard?.commanderDeck &&
              (deckCard.board === 'commander' ? (
                <button
                  onClick={async () => {
                    setBusy(true);
                    await moveDeckCard(deckCard.id, 'main');
                    onClose();
                  }}
                  disabled={busy}
                >
                  Move to mainboard
                </button>
              ) : canJoinCommandZone(oracleCard, commandZone) ? (
                <button
                  onClick={async () => {
                    setBusy(true);
                    await moveDeckCard(deckCard.id, 'commander');
                    onClose();
                  }}
                  disabled={busy}
                >
                  {commandZone.length === 1 ? 'Make second commander' : 'Make commander'}
                </button>
              ) : null)}
            {deckAdd && addTo.kind === 'deck' && deckAddIsDeck && addTo.format === 'commander' && canJoinCommandZone(oracleCard, commandZone) && (
              <button onClick={() => save('commander')} disabled={busy}>
                {commandZone.length === 1 ? 'Add as second commander' : 'Add as commander'}
              </button>
            )}
            {deckAdd && deckAddIsDeck && (
              <button onClick={() => save('side')} disabled={busy}>
                Add to sideboard
              </button>
            )}
            {listAddKind ? (
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
        </>
        )}
      </div>

      {allEditions && (
        <EditionPicker
          printings={highlighted.length > 0 ? [...highlighted, ...otherPrintings] : otherPrintings}
          selected={scryfallId}
          anyOption={anyPrefs || basicAny}
          notes={highlightPrintings?.notes}
          ownedIds={ownedIds}
          ownedForTradeIds={ownedForTradeIds}
          onSelect={(id) => {
            setScryfallId(id);
            onEditionChange?.(id);
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
          onClose={() => setPickingCopy(false)}
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
          oracleCard={nestedCard.oracle}
          initialScryfallId={nestedCard.scryfallId}
          initialTab="history"
          readOnly
          onClose={() => setNestedCard(null)}
        />
      )}
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

/** Every printing as an image tile — pick an edition by looking at it. */
export function EditionPicker({
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
                {img ? <img src={img} alt={p.setName} loading="lazy" /> : <span className="edition-tile-ph">{p.setName}</span>}
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

/** How a copy reads in the picker: "NM · Foil · ja". */
function copyDetail(e: CollectionEntry): string {
  const bits: string[] = [e.condition];
  if (e.finish !== 'nonfoil') bits.push(FINISH_LABELS[e.finish]);
  if (e.lang !== 'en') bits.push(e.lang);
  return bits.join(' · ');
}

/**
 * The copies of one card you actually own, as pickable tiles — the container
 * slot's "pick one from my collection". Picking a copy fills in the slot's
 * edition, finish, condition and language in one tap, which is what turns a
 * vague "I need a Lightning Bolt" into "this Beta one, lightly played".
 */
function CopyPicker({
  copies,
  printings,
  selected,
  onSelect,
  onClose,
}: {
  copies: CollectionEntry[];
  printings: Priced<Printing>[];
  /** What the sheet currently asks for, so the matching tile reads as selected. */
  selected: { scryfallId: string; condition: Condition | ''; finish: Finish | ''; lang: string };
  onSelect: (copy: CollectionEntry) => void;
  onClose: () => void;
}) {
  useDismiss(onClose);
  const byId = new Map(printings.map((p) => [p.scryfallId, p]));
  const isSelected = (e: CollectionEntry) =>
    e.scryfallId === selected.scryfallId &&
    e.condition === selected.condition &&
    e.finish === selected.finish &&
    e.lang === selected.lang;
  return (
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="sheet edition-picker-sheet" role="dialog" aria-label="Your copies" onClick={(e) => e.stopPropagation()}>
        <div className="edition-picker-head">
          <h2>Your copies</h2>
          <button onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="edition-grid">
          {copies.map((e) => {
            const p = byId.get(e.scryfallId);
            const img = p?.imageSmall ?? p?.imageNormal;
            return (
              <button
                key={e.id}
                className={isSelected(e) ? 'edition-tile edition-tile-selected' : 'edition-tile'}
                onClick={() => onSelect(e)}
              >
                <span className={`tile-badge ${e.quantityForTrade > 0 ? 'own-trade' : 'own-yes'}`} title={`You own ${e.quantity}`}>
                  ×{e.quantity}
                </span>
                {img ? <img src={img} alt={p?.setName ?? ''} loading="lazy" /> : <span className="edition-tile-ph">{p?.setName ?? 'Unknown set'}</span>}
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
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Recorded price movement of the shown printing: sparkline + change since tracking began. */
function PriceTrend({ trend }: { trend: HistoryChange }) {
  const dir = trend.delta > 0.001 ? 'up' : trend.delta < -0.001 ? 'down' : 'flat';
  return (
    <div className="sheet-price-trend">
      <Sparkline values={trend.series} />
      <div className={`price-change price-${dir}`}>
        {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {fmtPriceIn(Math.abs(trend.delta), trend.cur)}
        {trend.pct != null && ` (${trend.pct >= 0 ? '+' : '−'}${Math.abs(trend.pct).toFixed(1)}%)`}
        <span className="fine-print"> · {trend.points} pts</span>
      </div>
    </div>
  );
}
