// Expand MTGJSON sealed products into concrete Scryfall printings (see
// sealed-products feature). Deterministic products — precon decks, Secret
// Lairs, gift boxes — resolve to every card they contain. Randomised
// components (booster packs, "variable" choose-N) can't be expanded, so they
// are counted into `omittedRandom` and the UI says "also contains N booster
// pack(s), not added" rather than dropping the whole product (a Commander deck
// bundled with a booster still contributes its full, known decklist).
//
// Products with NO deterministic contents at all — a plain booster box, a
// display, a single pack — used to be dropped here. They are kept now: you
// can't add their cards, but you can own the unopened box, and that's the
// whole point of the sealed collection. They arrive with `cards: []` and a
// non-zero `omittedRandom`, which is exactly how the client tells the two
// kinds apart.

import type { Finish, Printing, SealedCardRef, SealedIdentifiers, SealedProduct } from '@mtg/shared';
import {
  streamSets,
  type MtgjsonDeck,
  type MtgjsonDeckCard,
  type MtgjsonSealedProduct,
} from './mtgjson.js';

const deckKey = (set: string, name: string) => `${set.toLowerCase()}::${name.toLowerCase()}`;

/** Pick the closest available finish for a printing given MTGJSON's foil flag. */
function resolveFinish(wantFoil: boolean, finishes: Finish[]): Finish {
  const want: Finish = wantFoil ? 'foil' : 'nonfoil';
  if (finishes.includes(want)) return want;
  // Foil wanted but only etched exists (etched cards ship in place of foil), and vice-versa.
  if (want === 'foil' && finishes.includes('etched')) return 'etched';
  return finishes[0] ?? 'nonfoil';
}

interface Accumulated {
  uuidToScry: Map<string, string>;
  products: MtgjsonSealedProduct[];
  productByUuid: Map<string, MtgjsonSealedProduct>;
  deckByKey: Map<string, MtgjsonDeck>;
  /** Per-product set name, keyed by product uuid (MTGJSON doesn't repeat it inside the product). */
  setNameByProduct: Map<string, string>;
}

export interface SealedStats {
  setsSeen: number;
  productsSeen: number;
  productsEmitted: number;
  /** Of those emitted, how many are pure-random (unopened-only). */
  productsRandomOnly: number;
  cardsUnavailable: number;
}

/**
 * Stream AllPrintings, then expand each sealed product against `printingsById`
 * (the Scryfall-built printings the pipeline already holds) to validate cards
 * exist in this build and to pick a real finish. Returns every product with
 * something to offer: resolvable cards, random contents, or both.
 */
export async function buildSealedProducts(
  printingsById: Map<string, Printing>,
): Promise<{ products: SealedProduct[]; stats: SealedStats }> {
  const acc: Accumulated = {
    uuidToScry: new Map(),
    products: [],
    productByUuid: new Map(),
    deckByKey: new Map(),
    setNameByProduct: new Map(),
  };
  const stats: SealedStats = {
    setsSeen: 0,
    productsSeen: 0,
    productsEmitted: 0,
    productsRandomOnly: 0,
    cardsUnavailable: 0,
  };

  await streamSets((code, set) => {
    stats.setsSeen++;
    for (const card of set.cards ?? []) {
      const scry = card.identifiers?.scryfallId;
      if (card.uuid && scry) acc.uuidToScry.set(card.uuid, scry);
    }
    for (const deck of set.decks ?? []) {
      acc.deckByKey.set(deckKey(deck.code ?? code, deck.name), deck);
    }
    for (const product of set.sealedProduct ?? []) {
      product.setCode = (product.setCode ?? code).toLowerCase();
      acc.products.push(product);
      acc.productByUuid.set(product.uuid, product);
      if (set.name) acc.setNameByProduct.set(product.uuid, set.name);
    }
  });

  const products: SealedProduct[] = [];
  for (const raw of acc.products) {
    stats.productsSeen++;
    const built = expandProduct(raw, acc, printingsById);
    stats.cardsUnavailable += built.unresolved ?? 0;
    // Everything MTGJSON lists is a real product somebody can own, so nothing
    // is filtered out here. What varies is which of the two add paths the
    // client can offer, and `cards.length` answers that.
    products.push(built);
    stats.productsEmitted++;
    if (built.cards.length === 0) stats.productsRandomOnly++;
  }

  products.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { products, stats };
}

function expandProduct(
  raw: MtgjsonSealedProduct,
  acc: Accumulated,
  printingsById: Map<string, Printing>,
): SealedProduct {
  // Aggregate slots by scryfallId+finish; count random omissions and misses.
  const slots = new Map<string, SealedCardRef>();
  let omittedRandom = 0;
  let unresolved = 0;

  const addCard = (uuid: string | undefined, count: number, foil: boolean) => {
    if (!uuid) {
      unresolved += count;
      return;
    }
    const scry = acc.uuidToScry.get(uuid);
    const printing = scry ? printingsById.get(scry) : undefined;
    if (!scry || !printing) {
      unresolved += count;
      return;
    }
    const finish = resolveFinish(foil, printing.finishes);
    const key = `${scry}|${finish}`;
    const existing = slots.get(key);
    if (existing) existing.qty += count;
    else slots.set(key, { scryfallId: scry, qty: count, finish });
  };

  const addDeckCards = (cards: MtgjsonDeckCard[] | undefined, multiplier: number) => {
    for (const c of cards ?? []) addCard(c.uuid, (c.count ?? 1) * multiplier, c.isFoil === true);
  };

  // Recursively walk contents. `visited` guards against sealed-references-sealed cycles.
  const walk = (product: MtgjsonSealedProduct, multiplier: number, visited: Set<string>) => {
    const c = product.contents;
    if (!c) return;

    for (const card of c.card ?? []) addCard(card.uuid, multiplier, card.foil === true);

    for (const ref of c.deck ?? []) {
      const deck = acc.deckByKey.get(deckKey(ref.set, ref.name));
      if (!deck) continue;
      addDeckCards(deck.commander, multiplier);
      addDeckCards(deck.mainBoard, multiplier);
      addDeckCards(deck.sideBoard, multiplier);
      addDeckCards(deck.tokens, multiplier); // best-effort; often empty (tokens live in `other` free text)
    }

    for (const ref of c.sealed ?? []) {
      const inner = ref.uuid ? acc.productByUuid.get(ref.uuid) : undefined;
      if (!inner || visited.has(inner.uuid)) {
        // Unknown/cyclic inner product — treat as opaque, don't guess its contents.
        continue;
      }
      visited.add(inner.uuid);
      walk(inner, multiplier * (ref.count ?? 1), visited);
    }

    // Randomised components: not expandable, but flagged for the UI.
    if (c.pack?.length) omittedRandom += c.pack.length * multiplier;
    if (c.variable) omittedRandom += multiplier;
    // `other` = free-text descriptions (life wheels, "10 Double Sided Tokens"): ignored.
  };

  walk(raw, 1, new Set([raw.uuid]));

  const cards = [...slots.values()].sort((a, b) =>
    a.scryfallId < b.scryfallId ? -1 : a.scryfallId > b.scryfallId ? 1 : a.finish < b.finish ? -1 : 1,
  );

  const product: SealedProduct = {
    id: raw.uuid,
    name: raw.name,
    set: raw.setCode ?? '',
    cards,
  };
  if (raw.category) product.category = raw.category;
  if (raw.subtype) product.subtype = raw.subtype;
  const setName = acc.setNameByProduct.get(raw.uuid);
  if (setName) product.setName = setName;
  if (raw.releaseDate) product.releaseDate = raw.releaseDate;
  if (omittedRandom > 0) product.omittedRandom = omittedRandom;
  if (unresolved > 0) product.unresolved = unresolved;
  const identifiers = pickIdentifiers(raw);
  if (identifiers) product.identifiers = identifiers;
  return product;
}

/** Keep the three marketplace ids we can actually use; drop the other half-dozen. */
function pickIdentifiers(raw: MtgjsonSealedProduct): SealedIdentifiers | undefined {
  const src = raw.identifiers;
  if (!src) return undefined;
  const out: SealedIdentifiers = {};
  if (src.tcgplayerProductId) out.tcgplayer = String(src.tcgplayerProductId);
  if (src.cardKingdomId) out.cardKingdom = String(src.cardKingdomId);
  if (src.mcmId) out.mcm = String(src.mcmId);
  return Object.keys(out).length ? out : undefined;
}
