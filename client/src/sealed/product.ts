import type { SealedItem, SealedPriceMap, SealedProduct } from '@mtg/shared';
import { formatPrice } from '../components/CardSorting.js';
import { getPrefs } from '../prefs.js';

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

/** MTGJSON ships snake_case categories ('booster_box', 'limited_aid_tool'). */
export function categoryLabel(category: string): string {
  const words = category.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function subtitle(p: SealedProduct): string {
  const bits = [p.setName ?? p.set.toUpperCase()];
  if (p.releaseDate) bits.push(p.releaseDate.slice(0, 4));
  return bits.join(' · ');
}

// --- Prices ----------------------------------------------------------------
// Sealed products are priced in both currencies — TCGplayer market for USD,
// Cardmarket's price guide for EUR — so they go through the same machinery as
// cards: prefer the user's base currency, fall back to the other, then convert
// to whatever they display in. The two markets genuinely disagree on sealed
// (a Bloomburrow collector box is ~$1173 but ~€783), so picking the right side
// matters more here than it does for singles.

/** A sealed price in the shape the shared price helpers expect. */
export interface SealedPriceSource {
  priceUsd: number | null;
  priceEur: number | null;
}

/** This product's prices, or undefined when neither market quotes it. */
export function sealedPriceOf(prices: SealedPriceMap, productId: string | undefined): SealedPriceSource | undefined {
  if (!productId) return undefined;
  const tuple = prices[productId];
  if (!tuple) return undefined;
  return { priceUsd: tuple[0] ?? null, priceEur: tuple[1] ?? null };
}

/** Formatted for display, in the user's currency. Undefined when unpriced. */
export function fmtSealedPrice(src: SealedPriceSource | undefined): string | undefined {
  return formatPrice(src);
}

/**
 * Which market a shown price came from, for the label beside it. The price
 * helpers prefer the base currency and fall back, so this has to reproduce that
 * choice rather than assume one source.
 */
export function sealedPriceSourceLabel(src: SealedPriceSource | undefined): string | undefined {
  if (!src) return undefined;
  const base = getPrefs().baseCurrency;
  const first = base === 'EUR' ? src.priceEur : src.priceUsd;
  if (first != null) return base === 'EUR' ? 'Cardmarket' : 'TCGplayer';
  const other = base === 'EUR' ? src.priceUsd : src.priceEur;
  if (other != null) return base === 'EUR' ? 'TCGplayer' : 'Cardmarket';
  return undefined;
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
