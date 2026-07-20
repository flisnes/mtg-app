import { sanitizeTradeLines, sanitizeWishLines, type TradeLine, type WishLine } from '@mtg/shared';

// A trade partner is untrusted (no auth on the relay). Sanitize every incoming
// offer line before it's displayed or written to the collection. The field
// rules and condition/finish enums live in @mtg/shared; here we only fix the
// bounds for a live trade offer (a single in-person exchange, not a whole list).

const LIMITS = { maxQty: 999, maxLines: 500 };

export function sanitizeOffer(lines: unknown): TradeLine[] {
  return sanitizeTradeLines(lines, LIMITS);
}

export function sanitizeWishlist(lines: unknown): WishLine[] {
  return sanitizeWishLines(lines, LIMITS);
}
