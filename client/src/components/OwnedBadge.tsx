import { Icon } from './icons.js';
import type { OwnedStatus } from '../db/useOwnership.js';

// The one ownership checkmark, so every card looks the same wherever it shows
// (search, scan, wishlist, decks, trade, the card sheet). Feeds the generic
// `badge` slot on CardItem / the ResultBadge on CardSearchView.
//
//   box (green fill)      — this *is* your copy, and it's filed right here. The
//                           top rung: a card can only be in one place, and this
//                           is the place (see usePlacements' claiming rules).
//   double check (green)  — you own this exact printing (for a deck slot: the
//                           exact card it names, down to finish/condition/language)
//   single check (green)  — you own another printing of this card (for a slot:
//                           you own it, but not the exact card — or the slot
//                           hasn't named one yet)
//   tag (purple)          — you have copies marked for trade
//   nothing               — you don't own it
//
// "Filed here" outranks everything: you're looking at the deck, binder or box the
// card lives in, and that's the most specific thing we can say about it. Below
// that, for-trade wins the icon (matching the card sheet's long-standing
// behavior): the tag says "I can trade this" at a glance, which is what a partner
// cares about. The title spells out the detail either way.

export interface OwnedBadgeSpec {
  icon: React.ReactNode;
  cls: string;
  title: string;
}

/** How the title spells out `ownsExact`. A deck slot asks for more than an
 *  edition (finish, condition, language), so it words the two cases its way. */
export interface OwnedBadgeTerms {
  yes: string;
  no: string;
}

const PRINTING_TERMS: OwnedBadgeTerms = { yes: 'including this exact printing', no: 'other printing(s)' };

export function ownedBadge(
  status: OwnedStatus | undefined,
  size = 13,
  terms: OwnedBadgeTerms = PRINTING_TERMS,
  /** This row is the slot holding one of your copies — the top rung. */
  filedHere = false,
): OwnedBadgeSpec | null {
  if (!status || status.qty === 0) return null;
  const trade = status.forTrade > 0;
  const name = filedHere ? 'collection' : trade ? 'tradelist' : status.ownsExact ? 'checkDouble' : 'check';
  const title = filedHere
    ? `Your copy is filed here${trade ? ` · ${status.forTrade} of your ${status.qty} are for trade` : ''}`
    : (trade ? `You have ${status.qty} (${status.forTrade} for trade)` : `You own ${status.qty}`) +
      ` · ${status.ownsExact ? terms.yes : terms.no}`;
  return {
    icon: <Icon name={name} size={size} />,
    cls: filedHere ? 'own-filed' : trade ? 'own-trade' : 'own-yes',
    title,
  };
}
