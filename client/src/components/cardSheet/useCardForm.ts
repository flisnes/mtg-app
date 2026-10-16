import { useState } from 'react';
import type { CollectionEntry, Condition, DeckBoard, Finish, Printing, SpecialCondition, WishLine, WishlistEntry } from '@mtg/shared';
import { ANY_PRINTING, type CopyTraits, type DeckSlotEdit, type SessionCardValues } from './types.js';
import type { ModeFlags } from './modeFlags.js';

/** Every value the sheet's form holds. '' is the "Any" sentinel for condition,
 *  finish, language and edition, used where the form is a preference (a wish, a
 *  container slot) rather than a real copy. */
export interface CardForm {
  scryfallId: string;
  condition: Condition | '';
  finish: Finish | '';
  lang: string;
  quantity: number;
  forTrade: number;
  /** Altered, signed, …: collection copies only. */
  special: SpecialCondition[];
  /** Slot tags: ride along with Save/Cancel like every other field. */
  tags: string[];
  /** Which zone the slot sits in; saving with another one moves it. */
  zone: DeckBoard;
}

/** The form for one copy or slot, as it's stored. Used when the sheet opens on
 *  one, and again when the copy strip steps to another. */
export function formFrom(source: CollectionEntry | DeckSlotEdit): CardForm {
  if ('quantityForTrade' in source) {
    return {
      scryfallId: source.scryfallId,
      condition: source.condition,
      finish: source.finish,
      lang: source.lang,
      quantity: source.quantity,
      forTrade: source.quantityForTrade,
      special: source.special ?? [],
      tags: [],
      zone: 'main',
    };
  }
  return {
    // A slot that pins no edition means it: "any printing" is a real answer here.
    scryfallId: source.anyBasic ? ANY_PRINTING : source.scryfallId ?? ANY_PRINTING,
    condition: source.condition ?? '',
    finish: source.finish ?? '',
    lang: source.lang ?? '',
    quantity: source.quantity,
    forTrade: 0,
    special: [],
    tags: source.tags ?? [],
    zone: source.board ?? 'main',
  };
}

/** The form the sheet opens with, for the modes that don't open on a stored copy. */
export function initialForm(
  flags: Pick<ModeFlags, 'mode' | 'addTo' | 'anyPrefs' | 'wishMode' | 'basicAnyDefault'>,
  src: {
    entry?: CollectionEntry;
    deckCard?: DeckSlotEdit;
    sessionCard?: SessionCardValues;
    wishEntry?: WishlistEntry;
    wishView?: WishLine;
    /** The printing the card is already tied to, if any. */
    recordedId?: string;
    defaultScryfallId: string;
  },
): CardForm {
  if (src.entry) return formFrom(src.entry);
  if (src.deckCard) return formFrom(src.deckCard);
  const { sessionCard, wishEntry, wishView } = src;
  const pref = flags.anyPrefs ? wishEntry ?? wishView : undefined;
  return {
    // In wish mode (and for a lands-box basic) the empty string means "any printing".
    scryfallId: flags.wishMode
      ? wishEntry?.scryfallId ?? wishView?.scryfallId ?? ANY_PRINTING
      : flags.basicAnyDefault
        ? ANY_PRINTING
        : src.recordedId ?? src.defaultScryfallId,
    condition: sessionCard?.condition ?? (flags.anyPrefs ? pref?.condition ?? '' : 'NM'),
    finish: sessionCard?.finish ?? (flags.anyPrefs ? pref?.finish ?? '' : 'nonfoil'),
    lang: sessionCard?.lang ?? (flags.anyPrefs ? pref?.lang ?? '' : 'en'),
    quantity: wishEntry?.quantity ?? wishView?.quantity ?? sessionCard?.quantity ?? 1,
    forTrade: flags.addTo.kind === 'tradelist' ? 1 : 0,
    special: [],
    tags: [],
    zone: 'main',
  };
}

/** A concrete finish must be one the chosen printing comes in. Read-time rather
 *  than an effect, so stepping to a nonfoil-only edition and back keeps the foil.
 *  A wish's finish (and "Any") is a preference, not a copy, so it's left alone. */
export function clampFinish(finish: Finish | '', printing: Printing | undefined, wishMode: boolean): Finish | '' {
  if (wishMode || !printing || !finish || printing.finishes.includes(finish)) return finish;
  return printing.finishes[0] ?? 'nonfoil';
}

/** The sheet's form state, with the two whole-form moves it makes: load another
 *  copy, and take on a real copy's identity (picked or just added). */
export function useCardForm(initial: () => CardForm) {
  const [form, setForm] = useState(initial);
  const patch = (p: Partial<CardForm>) => setForm((f) => ({ ...f, ...p }));
  const setCopy = (copy: CopyTraits) =>
    patch({ scryfallId: copy.scryfallId, condition: copy.condition, finish: copy.finish, lang: copy.lang });
  return { form, setForm, patch, setCopy };
}
