// Card database types. Read-only on the client, replaced wholesale on version
// change. Sourced from the slimmed Scryfall bulk file (see beta plan §3).
//
// The oracle/printing distinction is load-bearing (ultraplan): search, decks
// and wishlists key off the oracle card; collections and trades reference a
// specific printing (scryfallId).

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';

/** The five colors in canonical WUBRG order. */
export const COLORS: readonly Color[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * Valid colors only, deduplicated, in WUBRG order. Double-faced cards have no
 * top-level `colors`, so we union their faces — and a mono-green werewolf then
 * comes out as ['G','G'], which every "colors.length > 1" check reads as
 * multicolor. Producers and consumers of `colors` both go through this, so old
 * card DBs built before the fix still group and filter correctly.
 */
export function normalizeColors(values: readonly string[] | undefined): Color[] {
  if (!values || values.length === 0) return [];
  const seen = new Set(values);
  return COLORS.filter((c) => seen.has(c));
}

export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus';

export type Finish = 'nonfoil' | 'foil' | 'etched';

/** Formats we track legality for (a curated subset of Scryfall's ~20). */
export type Format = 'standard' | 'pioneer' | 'modern' | 'legacy' | 'vintage' | 'pauper' | 'commander';

export type LegalityStatus = 'legal' | 'not_legal' | 'banned' | 'restricted';

export const FORMATS: readonly Format[] = [
  'standard',
  'pioneer',
  'modern',
  'legacy',
  'vintage',
  'pauper',
  'commander',
];

/** One functional card (one Scryfall oracle_id). Drives search / decks / wishlist. */
export interface OracleCard {
  oracleId: string;
  name: string;
  manaCost: string | null;
  cmc: number;
  typeLine: string;
  oracleText: string | null;
  colors: Color[];
  colorIdentity: Color[];
  rarity: Rarity;
  imageSmall: string | null;
  imageNormal: string | null;
  /** Back-face images for double-faced cards (absent for single-faced ones and on card DBs built before this field). */
  imageBackSmall?: string | null;
  imageBackNormal?: string | null;
  /** A representative printing used when the user hasn't picked one. */
  defaultScryfallId: string;
  /** Legality per tracked format (oracle-invariant). May be absent on card DBs imported before this field existed. */
  legalities?: Partial<Record<Format, LegalityStatus>>;
  /** Power/toughness for creatures (incl. token creatures); absent for non-creatures and on card DBs built before this field. */
  power?: string | null;
  toughness?: string | null;
  /**
   * Oracle ids of tokens this card is known to create (Scryfall's `all_parts`,
   * component `token`), deduplicated. Absent/empty when the card creates none,
   * or on card DBs built before this field existed. Drives the deck view's
   * "tokens you'll need" suggestions.
   */
  tokenOracleIds?: string[];
  /**
   * Scryfall's card `layout` (e.g. 'normal', 'transform', 'split', 'saga').
   * Absent on card DBs built before this field existed. Drives the `is:`
   * structural keywords (is:transform, is:mdfc, is:saga, ...).
   */
  layout?: string;
  /** On the Reserved List. Omitted (not false) when not reserved — nearly every card. */
  reserved?: boolean;
  /** A Commander Game Changer (per the Commander Rules Committee list). Omitted when not one. */
  gameChanger?: boolean;
}

/** One physical printing (one Scryfall card id). Drives the edition picker + collection editing. */
export interface Printing {
  scryfallId: string;
  oracleId: string;
  set: string;
  setName: string;
  collectorNumber: string;
  lang: string;
  finishes: Finish[];
  releasedAt: string; // ISO date
  /**
   * Scryfall's `promo` flag: prerelease/buy-a-box/promo-pack stampings and the
   * like. Omitted (not false) for the overwhelming majority of printings, which
   * aren't promos — same sparse convention as the back-face images. Absent on
   * card DBs built before this field, so treat missing as "not known to be a
   * promo" rather than "definitely normal". Set-wide promo products are better
   * identified by set type (see SetTypeMap); this covers the handful of promos
   * that live inside an ordinary set's own numbering.
   */
  promo?: boolean;
  imageSmall: string | null;
  imageNormal: string | null;
  /** Back-face images for double-faced cards (absent for single-faced ones and on card DBs built before this field). */
  imageBackSmall?: string | null;
  imageBackNormal?: string | null;
}

// Prices are versioned and shipped separately from the card data: they churn
// daily (which used to force a full 14 MB re-download + re-import), while the
// card data itself only changes when Scryfall's underlying data does.

/**
 * A card row enriched with its current prices (joined at read time on the
 * client). `priceEur`/`priceUsd` are the nonfoil prices; the foil/etched
 * variants are present when the price artifact carries them (`priceHasFoil`),
 * and consumers pick the right one for an entry's finish via `pricedForFinish`.
 */
export type Priced<T> = T & {
  priceEur: number | null;
  priceUsd: number | null;
  priceEurFoil?: number | null;
  priceUsdFoil?: number | null;
  priceUsdEtched?: number | null;
  /** True when the price artifact this row was joined against carried foil slots. */
  priceHasFoil?: boolean;
};

/**
 * scryfallId → price tuple `[eur, usd, eurFoil, usdFoil, usdEtched]`. Trailing
 * nulls are trimmed, so a nonfoil-only card is just `[eur, usd]`; a tuple
 * longer than 2 means foil/etched prices are authoritative (a null slot then
 * means "no such price", not "unknown"). Scryfall has no EUR etched price, so
 * etched EUR reuses the foil EUR. Entries with every price null are omitted.
 */
export type PriceMap = Record<string, PriceTuple>;

/** `[eur, usd, eurFoil?, usdFoil?, usdEtched?]` — see PriceMap. */
export type PriceTuple =
  | [number | null, number | null]
  | [number | null, number | null, number | null]
  | [number | null, number | null, number | null, number | null]
  | [number | null, number | null, number | null, number | null, number | null];

/** One stored shard of the price map (sharded by first hex char of scryfallId). */
export interface PriceShard {
  key: string;
  prices: PriceMap;
}

/** Served alongside the slim artifacts; drives DB-refresh + app-update prompts (beta plan §3.1). */
export interface CardDbManifest {
  /**
   * Legacy card-DB version = Scryfall bulk `updated_at`. Pre-chunking clients
   * key their full re-download off this; new clients use `v2`.
   */
  cardDbVersion: string;
  /** Latest published app build version; client compares to its embedded version. */
  latestAppVersion: string;
  /** Optional hard floor: clients below this get the trade view blocked. */
  minSupportedVersion?: string;
  /**
   * Legacy whole-file artifacts (prices embedded), for clients older than the
   * chunked scheme (v0.45). No longer emitted: prices ride inside them, so they
   * churned in full every night — ~14 MB republished daily for a client
   * generation that no longer exists.
   */
  artifacts?: {
    oracle: CardDbArtifactMeta;
    printings: CardDbArtifactMeta;
  };
  /** ISO timestamp prices were captured; shown as "prices updated <date>". */
  pricesUpdatedAt: string;
  /** Chunked artifacts + separate prices: clients download only what changed. */
  v2?: {
    /** Identity of the price-less card data (hash over the chunk hashes). */
    dataVersion: string;
    chunks: {
      oracle: CardDbChunkMeta[];
      printings: CardDbChunkMeta[];
    };
    prices: CardDbArtifactMeta;
    /**
     * Sealed products expanded against this build's printings. Lazily fetched
     * by the client only when the "Add sealed product" UI opens. Absent on
     * builds made before the feature (and on runs where the MTGJSON fetch fails).
     */
    sealed?: CardDbArtifactMeta;
    /**
     * USD market prices for the sealed products above, keyed by product id.
     * Split out because it churns daily while the catalog doesn't. Absent when
     * the TCGplayer price fetch fails — the catalog still works, just priceless.
     */
    sealedPrices?: CardDbArtifactMeta;
    /**
     * Set code → Scryfall set type, for telling a normal set apart from a promo
     * product, Secret Lair, token sheet or memorabilia set. Tiny (~4 KB gzipped
     * for every set ever printed) and fetched lazily like `sealed`. Absent on
     * builds made before the preferred-printing setting existed.
     */
    sets?: CardDbArtifactMeta;
  };
}

/**
 * Set code → Scryfall `set_type`. The client uses this to resolve the "latest
 * non-promo printing" preference; see PROMO_SET_TYPES.
 */
export type SetTypeMap = Record<string, string>;

/**
 * Set types whose printings are promos or novelties rather than a normal
 * release: promo packs and judge/FNM foils (`promo`), Secret Lair and other
 * boxed oddities (`box`), token sheets, oversized/art-series memorabilia,
 * premium inserts like Kaladesh Inventions (`masterpiece`), Un-sets (`funny`),
 * and the digital-only or novelty remainder.
 *
 * A denylist rather than an allowlist on purpose: if Scryfall adds a set type we
 * haven't seen, treating it as a normal set is the safer failure — the user
 * still gets a real printing, just possibly a promo one.
 */
export const PROMO_SET_TYPES: ReadonlySet<string> = new Set([
  'promo',
  'token',
  'memorabilia',
  'box',
  'funny',
  'masterpiece',
  'minigame',
  'vanguard',
  'treasure_chest',
  'arsenal',
  'spellbook',
  'alchemy',
]);

/** One chunk of an artifact: all rows whose id starts with `key` (one hex char). */
export interface CardDbChunkMeta extends CardDbArtifactMeta {
  key: string;
}

// --- Sealed products (see sealed-products feature) -------------------------
// Every sealed product MTGJSON knows: precon decks, Secret Lairs and gift boxes
// (whose contents are fixed, so the client can add "one of everything in this
// product" to a collection) *and* booster boxes, displays and packs (whose
// contents are random, so all the client can do is record that you own the
// unopened box). Shipped as a lazily-fetched artifact keyed off the card-DB
// `dataVersion` — the scryfallIds only make sense against that build's
// printings. Prices ride in a separate artifact; see SealedPriceMap.

/** One resolved card slot in a sealed product. */
export interface SealedCardRef {
  scryfallId: string;
  qty: number;
  finish: Finish;
}

/**
 * Marketplace ids for a sealed product, straight from MTGJSON. `tcgplayer` is
 * both the box shot (their CDN serves product photos off it, keylessly) and the
 * USD price key; the others are kept for future price sources. Coverage is
 * uneven — cases and oddities often carry only one or two.
 */
export interface SealedIdentifiers {
  tcgplayer?: string;
  cardKingdom?: string;
  /** Cardmarket. */
  mcm?: string;
}

/** A sealed product and whatever of its contents we can pin down. */
export interface SealedProduct {
  /** MTGJSON product uuid — stable id for caching/selection. */
  id: string;
  name: string;
  /** MTGJSON category (e.g. 'deck', 'box_set', 'bundle') — for grouping/labels. */
  category?: string;
  /** MTGJSON subtype (e.g. 'commander', 'planeswalker') — for labels. */
  subtype?: string;
  /** Set code (lowercased) the product belongs to. */
  set: string;
  setName?: string;
  /** ISO release date, when known. */
  releaseDate?: string;
  /**
   * Deterministic cards this product contains (deduped by scryfallId+finish).
   * Empty for a pure booster box or pack — everything in it is random, so the
   * only thing the client can offer is adding it unopened.
   */
  cards: SealedCardRef[];
  /** Count of random components (booster packs / variable) omitted from `cards`. */
  omittedRandom?: number;
  /** Count of referenced cards that could not be matched to a printing in this build. */
  unresolved?: number;
  /** Marketplace ids; absent when MTGJSON lists none. */
  identifiers?: SealedIdentifiers;
}

/**
 * `[usd, eur]` for one sealed product; a trailing null is trimmed, so a
 * USD-only product is just `[usd]`. Mirrors PriceTuple's shape and reason.
 */
export type SealedPriceTuple = [number | null] | [number | null, number | null];

/**
 * Sealed product id (the MTGJSON uuid, i.e. `SealedProduct.id`) → its prices.
 * Shipped separately from the catalog for the same reason card prices are:
 * prices churn daily while the product list barely moves, and a combined
 * artifact would re-download in full every night.
 *
 * Two sources, because no single one covers both markets: TCGplayer market
 * prices via TCGCSV for USD, and Cardmarket's own published price guide for
 * EUR. Neither MTGJSON nor Scryfall prices sealed product at all — MTGJSON's
 * feed is singles-only and Scryfall has no sealed object. A product may have
 * one, both or neither, so consumers must handle a missing side.
 */
export type SealedPriceMap = Record<string, SealedPriceTuple>;

export interface CardDbArtifactMeta {
  url: string;
  bytes: number;
  /** Hex sha256 of the uncompressed JSON, for integrity + change detection. */
  sha256: string;
  /** Number of entries, for the download progress bar. */
  count: number;
}
