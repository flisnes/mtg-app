import type { SealedItem, SealedPriceMap, SealedProduct } from '@mtg/shared';
import { fmtMoney } from '../price/rates.js';

// Shared helpers for sealed products: box shots, prices, labels, and the
// "which products contain this card?" lookup.

/**
 * Box shots come from TCGplayer's product CDN, keyed by the `tcgplayer`
 * identifier MTGJSON ships. No API key, and it answers with
 * `Access-Control-Allow-Origin: *`, so the service worker can cache it exactly
 * like Scryfall card art. Neither Scryfall nor MTGJSON has a sealed image of
 * any kind, and Card Kingdom's URLs embed an internal image id that can't be
 * derived from anything we hold.
 *
 * A product id that doesn't exist answers **403, not 404**, so callers must
 * treat any failure as "no image" rather than checking for a status code.
 */
const TCG_CDN = 'https://tcgplayer-cdn.tcgplayer.com/product';

export function sealedImageUrl(tcgplayerId: string | undefined, size: 'thumb' | 'full'): string | null {
  if (!tcgplayerId) return null;
  return `${TCG_CDN}/${tcgplayerId}${size === 'thumb' ? '_200w.jpg' : '_in_1000x1000.jpg'}`;
}

/** A product's box shot, or null when MTGJSON lists no TCGplayer id for it. */
export function productImage(p: SealedProduct, size: 'thumb' | 'full'): string | null {
  return sealedImageUrl(p.identifiers?.tcgplayer, size);
}

/** An owned item's box shot (its tcgplayer id is denormalized onto the row). */
export function itemImage(item: SealedItem, size: 'thumb' | 'full'): string | null {
  return sealedImageUrl(item.tcgplayerId, size);
}

/**
 * A product with no deterministic contents — a booster box, a display, a loose
 * pack. Everything inside is random, so the only thing you can do with it is
 * own it unopened.
 */
export function isRandomOnly(p: SealedProduct): boolean {
  return p.cards.length === 0;
}

/** Total deterministic cards in one copy of the product. */
export function cardCount(p: SealedProduct): number {
  return p.cards.reduce((s, c) => s + c.qty, 0);
}

export function subtitle(p: SealedProduct): string {
  const bits = [p.setName ?? p.set.toUpperCase()];
  if (p.releaseDate) bits.push(p.releaseDate.slice(0, 4));
  return bits.join(' · ');
}

// --- Prices ----------------------------------------------------------------
// Sealed prices are USD-only for now: TCGplayer market via TCGCSV. Cardmarket
// publishes a keyless EUR dump but sends no CORS header and its redistribution
// terms are unread, so there is no EUR quote to fall back to. Rather than
// convert a US market price into the user's currency and let it pass for a
// local one, sealed prices are shown as USD and labelled.

export function sealedPrice(prices: SealedPriceMap, tcgplayerId: string | undefined): number | null {
  if (!tcgplayerId) return null;
  const v = prices[tcgplayerId];
  return typeof v === 'number' ? v : null;
}

/** Format a sealed price. Always USD — see the note above. */
export function fmtSealedPrice(usd: number): string {
  return fmtMoney(usd, 'USD');
}

// --- Reverse lookup --------------------------------------------------------

/** A product that contains a given card, with how many copies per product. */
export interface ProductWithCard {
  product: SealedProduct;
  qty: number;
}

/**
 * Every product whose deterministic contents include any of `scryfallIds` —
 * "which precon was this card in?". Callers pass every printing of the card's
 * oracle id, not just the one on screen: the Commander deck that introduced a
 * card and the set booster reprint are different printings, and a player
 * looking for "the deck this came in" wants both.
 *
 * Random-only products never match: nobody knows what's in an unopened pack.
 */
export function productsContaining(products: SealedProduct[], scryfallIds: Set<string>): ProductWithCard[] {
  const out: ProductWithCard[] = [];
  for (const product of products) {
    let qty = 0;
    for (const card of product.cards) if (scryfallIds.has(card.scryfallId)) qty += card.qty;
    if (qty > 0) out.push({ product, qty });
  }
  // Newest first: a card reprinted for years is most useful as "the latest one
  // you can still buy", and undated products sort last rather than first.
  out.sort((a, b) => (b.product.releaseDate ?? '').localeCompare(a.product.releaseDate ?? ''));
  return out;
}
