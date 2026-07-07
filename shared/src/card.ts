// Card database types. Read-only on the client, replaced wholesale on version
// change. Sourced from the slimmed Scryfall bulk file (see beta plan §3).
//
// The oracle/printing distinction is load-bearing (ultraplan): search, decks
// and wishlists key off the oracle card; collections and trades reference a
// specific printing (scryfallId).

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic' | 'special' | 'bonus';

export type Finish = 'nonfoil' | 'foil' | 'etched';

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
  /** A representative printing used when the user hasn't picked one. */
  defaultScryfallId: string;
  priceEur: number | null;
  priceUsd: number | null;
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
  priceEur: number | null;
  priceUsd: number | null;
}

/** Served alongside the slim artifacts; drives DB-refresh + app-update prompts (beta plan §3.1). */
export interface CardDbManifest {
  /** Card-DB version = Scryfall bulk `updated_at`. */
  cardDbVersion: string;
  /** Latest published app build version; client compares to its embedded version. */
  latestAppVersion: string;
  /** Optional hard floor: clients below this get the trade view blocked. */
  minSupportedVersion?: string;
  artifacts: {
    oracle: CardDbArtifactMeta;
    printings: CardDbArtifactMeta;
  };
  /** ISO timestamp prices were captured; shown as "prices updated <date>". */
  pricesUpdatedAt: string;
}

export interface CardDbArtifactMeta {
  url: string;
  bytes: number;
  /** Hex sha256 of the uncompressed JSON, for integrity + change detection. */
  sha256: string;
  /** Number of entries, for the download progress bar. */
  count: number;
}
