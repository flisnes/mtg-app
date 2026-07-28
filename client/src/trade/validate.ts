import { MAX_PUBLIC_LINES, sanitizeTradeLines, sanitizeWishLines, type TradeLine, type WishLine } from '@mtg/shared';

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

// A whole published Community list is far bigger than a single in-person offer,
// so it gets the publish-side cap (MAX_PUBLIC_LINES), not the 500-line offer
// bound above. Reusing the offer sanitizer here silently truncated big lists to
// 500 even though the server stored and returned all of them.
const PUBLIC_LIMITS = { maxQty: 9999, maxLines: MAX_PUBLIC_LINES };

export function sanitizePublicTradelist(lines: unknown): TradeLine[] {
  return sanitizeTradeLines(lines, PUBLIC_LIMITS);
}

export function sanitizePublicWishlist(lines: unknown): WishLine[] {
  return sanitizeWishLines(lines, PUBLIC_LIMITS);
}
