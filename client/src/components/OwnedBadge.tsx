import { Icon } from './icons.js';
import type { OwnedStatus } from '../db/useOwnership.js';

// The one ownership checkmark, so every card looks the same wherever it shows
// (search, scan, wishlist, decks, trade, the card sheet). Feeds the generic
// `badge` slot on CardItem / the ResultBadge on CardSearchView.
//
//   double check (green)  — you own this exact printing
//   single check (green)  — you own another printing of this card
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

export function ownedBadge(status: OwnedStatus | undefined, size = 13): OwnedBadgeSpec | null {
  if (!status || status.qty === 0) return null;
  const trade = status.forTrade > 0;
  const name = trade ? 'tradelist' : status.ownsExact ? 'checkDouble' : 'check';
  const title =
    (trade ? `You have ${status.qty} (${status.forTrade} for trade)` : `You own ${status.qty}`) +
    (status.ownsExact ? ' · including this exact printing' : ' · other printing(s)');
  return { icon: <Icon name={name} size={size} />, cls: trade ? 'own-trade' : 'own-yes', title };
}
