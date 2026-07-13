// Card database types. Read-only on the client, replaced wholesale on version
// change. Sourced from the slimmed Scryfall bulk file (see beta plan §3).
//
// The oracle/printing distinction is load-bearing (ultraplan): search, decks
// and wishlists key off the oracle card; collections and trades reference a
// specific printing (scryfallId).

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';

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
  imageSmall: string | null;
  imageNormal: string | null;
  /** Back-face images for double-faced cards (absent for single-faced ones and on card DBs built before this field). */
  imageBackSmall?: string | null;
  imageBackNormal?: string | null;
}

// Prices are versioned and shipped separately from the card data: they churn
// daily (which used to force a full 14 MB re-download + re-import), while the
// card data itself only changes when Scryfall's underlying data does.

/** A card row enriched with its current prices (joined at read time on the client). */
export type Priced<T> = T & { priceEur: number | null; priceUsd: number | null };

/** scryfallId → [eur, usd]. Entries with both prices null are omitted. */
export type PriceMap = Record<string, [number | null, number | null]>;

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
  /** Legacy whole-file artifacts (prices embedded), kept for pre-chunking clients. */
  artifacts: {
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
  };
}

/** One chunk of an artifact: all rows whose id starts with `key` (one hex char). */
export interface CardDbChunkMeta extends CardDbArtifactMeta {
  key: string;
}

export interface CardDbArtifactMeta {
  url: string;
  bytes: number;
  /** Hex sha256 of the uncompressed JSON, for integrity + change detection. */
  sha256: string;
  /** Number of entries, for the download progress bar. */
  count: number;
}
