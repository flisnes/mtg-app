import { traitsLine, type CollectionEntry, type ContainerKind, type DeckBoard, type OracleCard, type Printing, type WishlistEntry } from '@mtg/shared';
import {
  addDeckCard,
  addToCollection,
  addToWishlist,
  moveDeckCard,
  newId,
  removeDeckCard,
  removeFromCollection,
  removeFromWishlist,
  updateCollectionEntry,
  updateDeckCard,
  updateWishlistEntry,
} from '../../db/dataAccess.js';
import { db } from '../../db/schema.js';
import { CONTAINER_META } from '../../deck/containers.js';
import { claimKeyOf, rowToFilingCopy, type FilingCopy } from '../../deck/filing.js';
import { describeFilingResult, type useFiling } from '../../deck/useFiling.js';
import type { ModeFlags } from './modeFlags.js';
import type { CardForm } from './useCardForm.js';
import type { CopyTraits, DeckSlotEdit, ListKind, Overlay, SessionCardValues } from './types.js';

/** Everything the sheet's writes read and the few things they set. */
interface SaveContext {
  oracleCard: OracleCard;
  flags: Pick<ModeFlags, 'mode' | 'addTo'>;
  /** The form as shown: finish clamped, for trade clamped to the quantity. */
  form: CardForm;
  printing: Printing | undefined;
  /** The edition picker is on "any printing" for a lands-box basic. */
  anyBasicPicked: boolean;
  entry?: CollectionEntry;
  wishEntry?: WishlistEntry;
  deckCard?: DeckSlotEdit;
  sessionCard?: SessionCardValues;
  onApply?: (values: SessionCardValues) => void;
  onAdded?: (copy: CopyTraits) => void;
  /** Copies owned of the card, any printing. */
  ownedQty: number;
  file: ReturnType<typeof useFiling>['file'];
  toast: (message: string) => void;
  setBusy: (busy: boolean) => void;
  /** The add landed on one of the three lists: the sheet says so, then closes. */
  setAdded: (added: { list: ListKind; eventId: string }) => void;
  setOverlay: (overlay: Overlay | null) => void;
  patch: (patch: Partial<CardForm>) => void;
  setAddFlow: (list: ListKind) => void;
  onClose: () => void;
}

/** The sheet's writes: save, remove, add, file. Built per render from the
 *  sheet's current state, so each reads the form as it stands. */
export function cardSheetActions(ctx: SaveContext) {
  const { oracleCard, flags, form, printing, anyBasicPicked, entry, wishEntry, deckCard, sessionCard } = ctx;
  const { mode, addTo } = flags;
  const { scryfallId, condition, finish, lang, quantity, forTrade, special, tags, zone } = form;
  // A wish (and a container slot) stores its preferences as-is ('' → undefined =
  // "any"); a collection entry needs a concrete condition/finish/lang, so fall
  // back to the defaults.
  const wishPrefs = { condition: condition || undefined, finish: finish || undefined, lang: lang || undefined };
  const concrete = { condition: condition || 'NM', finish: finish || 'nonfoil', lang: lang || 'en' };

  /** Session mode: the edited line as reported back, mirroring the hidden fields.
   *  Session mode is never wish mode, so these are always concrete values. */
  function sessionValues(qty: number): SessionCardValues {
    return {
      scryfallId,
      quantity: qty,
      lang: sessionCard?.lang !== undefined ? lang : undefined,
      finish: sessionCard?.finish !== undefined ? concrete.finish : undefined,
      condition: sessionCard?.condition !== undefined ? concrete.condition : undefined,
    };
  }

  /** Which of the three personal lists an add lands on. An explicit button
   *  (dest) wins; otherwise the sheet's own scope decides, and a context-free
   *  ('default') search files to the collection. */
  function listDest(dest?: ListKind): ListKind {
    return dest ?? (addTo.kind === 'wishlist' || addTo.kind === 'tradelist' ? addTo.kind : 'collection');
  }

  /** This sheet's card as cardboard being filed somewhere, for the prompt. */
  function filingCopy(board: DeckBoard = 'main'): FilingCopy {
    return rowToFilingCopy({ oracleId: oracleCard.oracleId, scryfallId, quantity, ...wishPrefs }, board, {
      label: oracleCard.name,
      sub: traitsLine(form, { lead: printing?.setName }),
    });
  }

  /** The add half of `save`. Returns false when the user backed out of the
   *  filing prompt, so the sheet stays open on the form they were filling. */
  async function saveAdd(board: DeckBoard, dest: ListKind | undefined, eventId: string): Promise<boolean> {
    if (addTo.kind === 'deck') {
      // A slot naming a real copy of yours (edition + all three traits) is
      // cardboard being filed, so it goes through the filing flow and may offer
      // to take the card out of wherever it was. Anything vaguer is a brew line
      // that claims no copy — straight in, merging by card and board as ever.
      const claims = !anyBasicPicked && !!claimKeyOf({ ...wishPrefs, scryfallId });
      if (claims) {
        const filed = await ctx.file(addTo.deckId, [filingCopy(board)]);
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
      await addToWishlist({ oracleId: oracleCard.oracleId, scryfallId: scryfallId || null, ...wishPrefs, quantity, eventId });
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
        quantityForTrade: where === 'tradelist' ? forTrade || 1 : forTrade,
        special,
        eventId,
      });
      ctx.onAdded?.({ scryfallId: addedId, ...concrete });
    }
    return true;
  }

  /** In add mode `dest` names the list a button chose; when omitted the add
   *  follows the sheet's own scope (collection for a context-free search). */
  async function save(board: DeckBoard = 'main', dest?: ListKind) {
    ctx.setBusy(true);
    // Add mode first: the sheet may have stepped into it from a wish, a deck
    // slot or a card it's only showing, and those props are all still set.
    if (mode === 'add') {
      const eventId = newId();
      if (!(await saveAdd(board, dest, eventId))) {
        ctx.setBusy(false);
        return;
      }
      // Onto one of the three lists: flash which one, and let the timer close.
      if (addTo.kind !== 'deck') {
        ctx.setAdded({ list: listDest(dest), eventId });
        return;
      }
    } else if (sessionCard) {
      ctx.onApply?.(sessionValues(quantity));
    } else if (wishEntry) {
      await updateWishlistEntry(wishEntry.id, { scryfallId: scryfallId || null, ...wishPrefs, quantity });
    } else if (deckCard) {
      await updateDeckCard(deckCard.id, { quantity, scryfallId, anyBasic: anyBasicPicked, wants: wishPrefs, tags });
      // The move goes last so the slot carries this form's quantity and tags
      // into whatever it merges with on the far side.
      if (zone !== (deckCard.board ?? 'main')) await moveDeckCard(deckCard.id, zone);
    } else if (mode === 'edit' && entry) {
      await updateCollectionEntry(entry.id, { scryfallId, ...concrete, quantity, quantityForTrade: forTrade, special });
    }
    ctx.onClose();
  }

  /** Save the slot's form, then seat it as the deck's companion (the one
   *  already there, if any, moves to Considering). */
  async function saveAsCompanion() {
    if (!deckCard) return;
    ctx.setBusy(true);
    await updateDeckCard(deckCard.id, { quantity: 1, scryfallId, anyBasic: anyBasicPicked, wants: wishPrefs, tags });
    await moveDeckCard(deckCard.id, 'companion');
    ctx.onClose();
  }

  async function del() {
    ctx.setBusy(true);
    // A session line isn't stored anywhere yet — quantity 0 tells the scan
    // list to drop it.
    if (sessionCard) ctx.onApply?.(sessionValues(0));
    else if (wishEntry) await removeFromWishlist(wishEntry.id);
    else if (deckCard) await removeDeckCard(deckCard.id);
    else if (entry) await removeFromCollection(entry.id);
    ctx.onClose();
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
    ctx.patch({
      ...(dest !== 'wishlist'
        ? { scryfallId: scryfallId || oracleCard.defaultScryfallId, ...concrete }
        : {}),
      forTrade: dest === 'tradelist' ? Math.max(1, forTrade) : 0,
    });
    ctx.setAddFlow(dest);
  }

  async function fileCopies(containerId: string, kind: ContainerKind, copies: FilingCopy[]) {
    ctx.setOverlay(null);
    ctx.setBusy(true);
    const filed = await ctx.file(containerId, copies);
    if (filed === null) {
      ctx.setBusy(false);
      return;
    }
    ctx.toast(describeFilingResult(filed, CONTAINER_META[kind].noun));
    ctx.onClose();
  }

  /** Put this copy in a deck, binder or box, straight from the entry that owns
   *  it — the same filing flow (and move-or-both question) the collection's
   *  bulk "File away" runs, for the one card in front of you.
   *
   *  Own more than one copy and *which* of them goes in is a real question (the
   *  loose one, usually, not the one already in another deck), so it gets asked
   *  rather than guessed: FileCopiesSheet counts them out, and its answer lands
   *  back here as the copies to file. */
  async function fileHere(containerId: string, kind: ContainerKind) {
    ctx.setOverlay(null);
    if (ctx.ownedQty > 1) {
      const row = await db.decks.get(containerId);
      ctx.setOverlay({ kind: 'fileCopies', id: containerId, name: row?.name ?? CONTAINER_META[kind].noun, containerKind: kind });
      return;
    }
    await fileCopies(containerId, kind, [filingCopy()]);
  }

  return { save, saveAsCompanion, del, startAdd, fileHere, fileCopies };
}

export type CardSheetActionFns = ReturnType<typeof cardSheetActions>;
