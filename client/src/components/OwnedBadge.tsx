import { Icon } from './icons.js';
import type { OwnedStatus } from '../db/useOwnership.js';

// The one ownership checkmark, so every card looks the same wherever it shows
// (search, scan, wishlist, decks, trade, the card sheet). Feeds the generic
// `badge` slot on CardItem / the ResultBadge on CardSearchView.
//
//   double check (green)  — you own this exact printing (for a deck slot: a copy
//                           matching everything the slot asks for)
//   single check (green)  — you own another printing of this card (for a slot:
//                           you own it, but nothing that matches)
//   tag (purple)          — you have copies marked for trade
//   nothing               — you don't own it
//
// For-trade wins the icon (matching the card sheet's long-standing behavior):
// the tag says "I can trade this" at a glance, which is what a partner cares
// about. The title spells out the exact-vs-other detail either way.

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
): OwnedBadgeSpec | null {
  if (!status || status.qty === 0) return null;
  const trade = status.forTrade > 0;
  const name = trade ? 'tradelist' : status.ownsExact ? 'checkDouble' : 'check';
  const title =
    (trade ? `You have ${status.qty} (${status.forTrade} for trade)` : `You own ${status.qty}`) +
    ` · ${status.ownsExact ? terms.yes : terms.no}`;
  return { icon: <Icon name={name} size={size} />, cls: trade ? 'own-trade' : 'own-yes', title };
}
