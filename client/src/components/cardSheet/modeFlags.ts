import type { OracleCard } from '@mtg/shared';
import { boardOptions, type BoardOption } from '../../deck/boards.js';
import { isBasicLand, isNonDeckCard } from '../../deck/legality.js';
import type { AddTarget, DeckSlotEdit, ListKind, SessionCardValues, SheetMode } from './types.js';

/** What the sheet was opened as, plus the two things that change it in place:
 *  stepping sideways into an add form, and the Edit toggle on an owned copy. */
export interface ModeInput {
  /** The mode the caller named. */
  propsMode: SheetMode;
  /** The list an add form was stepped into from another mode, if any. */
  addFlow: ListKind | null;
  addTarget?: AddTarget;
  editMode: boolean;
  deckCard?: DeckSlotEdit;
  sessionCard?: SessionCardValues;
  /** Someone else's wish being viewed (info mode only). */
  hasWishView: boolean;
}

/** Where an add goes: the stepped-into list, the caller's target, or the collection. */
export function resolveAddTo(input: Pick<ModeInput, 'propsMode' | 'addFlow' | 'addTarget'>): AddTarget {
  if (input.addFlow) return { kind: input.addFlow };
  return (input.propsMode === 'add' && input.addTarget) || { kind: 'collection' };
}

/** Adding into a real deck (not a binder or box): only then are the sideboard
 *  and command-zone buttons meaningful. */
function addsToDeck(mode: SheetMode, addTo: AddTarget): boolean {
  return mode === 'add' && addTo.kind === 'deck' && (addTo.containerKind ?? 'deck') === 'deck';
}

/** The deck whose command zone the sheet needs to read, if any: the slot's own
 *  Commander deck, or the Commander deck an add is going into. Separate from
 *  modeFlags because the zone is a live read that modeFlags then takes in. */
export function commandZoneDeckId(input: ModeInput): string | undefined {
  const mode = input.addFlow ? 'add' : input.propsMode;
  const addTo = resolveAddTo(input);
  if (input.deckCard?.commanderDeck && input.deckCard.deckId) return input.deckCard.deckId;
  if (addsToDeck(mode, addTo) && addTo.kind === 'deck' && addTo.format === 'commander') return addTo.deckId;
  return undefined;
}

export interface ModeFlags {
  mode: SheetMode;
  addTo: AddTarget;
  /** The fields are inputs, not lines of text. */
  formEditable: boolean;
  wishAdd: boolean;
  deckAdd: boolean;
  deckAddIsDeck: boolean;
  /** A token, emblem or art card: only ever goes in a deck's token board. */
  cardIsToken: boolean;
  /** A basic land that may sit on "any printing" (from the lands box). */
  basicAny: boolean;
  basicAnyDefault: boolean;
  /** The zones a deck slot could move to (empty outside deck mode). */
  zones: BoardOption[];
  canSetCompanion: boolean;
  /** Viewing someone else's wish (Community). */
  wishInfo: boolean;
  /** Condition/finish/lang are optional and lead with "Any". */
  wishMode: boolean;
  /** A container slot: says what the deck wants of the copy filling it. */
  deckPrefs: boolean;
  anyPrefs: boolean;
  /** Add mode into a personal list: which list leads (the primary button). */
  listAddKind: ListKind | null;
  /** The form is about a collection copy: for trade and special conditions apply. */
  collectionFields: boolean;
  showCondition: boolean;
  showFinish: boolean;
  showLang: boolean;
  /** The owned badge may jump to a Collection search. */
  canOpenInCollection: boolean;
  /** The edition picker and the all-printings grid are on offer. */
  editionPickable: boolean;
}

/**
 * Every mode-dependent switch the sheet reads, from the mode and its props. Pure,
 * so the many ways the modes overlap (a deck add is "any"-able like a wish, a
 * stepped-into add is an add whatever the caller opened) live in one place.
 */
export function modeFlags(input: ModeInput, oracleCard: OracleCard, commandZone: readonly OracleCard[]): ModeFlags {
  const { propsMode, addFlow, editMode, deckCard, sessionCard, hasWishView } = input;
  const mode: SheetMode = addFlow ? 'add' : propsMode;
  const addTo = resolveAddTo(input);
  // An owned collection entry opens read-only with an Edit toggle; add/wish/
  // deck/session are always a form; info is never editable.
  const formEditable =
    mode === 'add' || mode === 'wish' || mode === 'deck' || mode === 'session' || (mode === 'edit' && editMode);
  // Wishlist adds default to "any printing"; deck slots don't store an edition
  // at all, so those variants drop the collection-specific fields below.
  const wishAdd = mode === 'add' && addTo.kind === 'wishlist';
  const deckAdd = mode === 'add' && addTo.kind === 'deck';
  const deckAddIsDeck = addsToDeck(mode, addTo);
  const cardIsToken = isNonDeckCard(oracleCard);
  // Basic lands in a container can be "any printing": whatever's on top of the
  // lands box. Offered when filing a basic into a container or editing such a
  // slot; the default when the container is a deck, since nobody sleeves 24
  // specific Islands. Binders and boxes hold real cardboard, so they opt in.
  const basicAny = (deckAdd || mode === 'deck') && isBasicLand(oracleCard);
  const basicAnyDefault = basicAny && (deckAddIsDeck || !!deckCard?.anyBasic);
  // Only a deck has zones (storage is one pile), and the command zone check must
  // not count the slot being moved as someone it has to pair with.
  const zones =
    mode === 'deck' && (deckCard?.containerKind ?? 'deck') === 'deck'
      ? boardOptions({
          cards: [oracleCard],
          commanderDeck: !!deckCard?.commanderDeck,
          commandZone: commandZone.filter((o) => o.oracleId !== oracleCard.oracleId),
          from: deckCard?.board,
        })
      : [];
  const canSetCompanion =
    mode === 'deck' && deckCard?.board !== 'companion' && zones.some((z) => z.board === 'companion' && !z.refusal);
  const wishInfo = mode === 'info' && hasWishView;
  const wishMode = mode === 'wish' || wishAdd || wishInfo;
  const deckPrefs = mode === 'deck' || deckAdd;
  const anyPrefs = wishMode || deckPrefs;
  // The other two lists ride along as compact quick-adds, so a card found while
  // searching one list can still be filed anywhere.
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
  // Condition/finish/lang show for collection entries, and for wishes and slots
  // as "Any"-able preferences. Session lines only edit what their scan tracks.
  const showCfl = collectionFields || wishMode || deckPrefs;
  return {
    mode,
    addTo,
    formEditable,
    wishAdd,
    deckAdd,
    deckAddIsDeck,
    cardIsToken,
    basicAny,
    basicAnyDefault,
    zones,
    canSetCompanion,
    wishInfo,
    wishMode,
    deckPrefs,
    anyPrefs,
    listAddKind,
    collectionFields,
    showCondition: mode === 'session' ? sessionCard?.condition !== undefined : showCfl,
    showFinish: mode === 'session' ? sessionCard?.finish !== undefined : showCfl,
    showLang: mode === 'session' ? sessionCard?.lang !== undefined : showCfl,
    // Never from a scan session (leaving mid-scan throws the session away), nor
    // edit mode, which already shows the entry itself.
    canOpenInCollection: mode !== 'session' && mode !== 'edit',
    // Picking an edition is not editing: in info mode it only changes which
    // printing you're looking at. Except a wish you're only reading, where the
    // edition is that person's answer, not yours to flip through.
    editionPickable: formEditable || (mode === 'info' && !wishInfo),
  };
}
