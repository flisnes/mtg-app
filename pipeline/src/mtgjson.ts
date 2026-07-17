// MTGJSON source access for the sealed-products build (see sealed-products
// feature). We stream MTGJSON's `AllPrintings.json.gz` — a single ~175 MB gz
// file that embeds, per set: `cards[]` (each with `identifiers.scryfallId`),
// `sealedProduct[]`, and `decks[]`. That's everything needed to expand a named
// sealed product into concrete Scryfall printings, so no second file / no
// per-set fetching is required.
//
// The top-level shape is `{ meta, data: { "<SETCODE>": <Set>, … } }` — an
// object keyed by set code, so we Pick `data` then streamObject its entries,
// keeping only one set materialised at a time.

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import streamJson from 'stream-json';
import PickMod from 'stream-json/filters/Pick.js';
import streamObjectMod from 'stream-json/streamers/StreamObject.js';

const { parser } = streamJson;
const { pick } = PickMod;
const { streamObject } = streamObjectMod;

const ALL_PRINTINGS_URL = 'https://mtgjson.com/api/v5/AllPrintings.json.gz';
const USER_AGENT = 'mtg-pwa-minimal/0.1 (collection & trading beta)';

/** A card as MTGJSON serialises it (only the fields we read). */
export interface MtgjsonCard {
  uuid: string;
  name: string;
  number?: string;
  setCode?: string;
  identifiers?: { scryfallId?: string };
}

/** One card slot inside a precon deck (mainBoard / commander / sideBoard / tokens). */
export interface MtgjsonDeckCard {
  uuid: string;
  count: number;
  isFoil?: boolean;
}

export interface MtgjsonDeck {
  name: string;
  code?: string;
  commander?: MtgjsonDeckCard[];
  mainBoard?: MtgjsonDeckCard[];
  sideBoard?: MtgjsonDeckCard[];
  tokens?: MtgjsonDeckCard[];
  sealedProductUuids?: string[] | null;
}

/** A `contents` block on a sealed product. All keys optional; each is an array. */
export interface MtgjsonSealedContents {
  card?: Array<{ uuid?: string; name?: string; number?: string; set?: string; foil?: boolean }>;
  deck?: Array<{ name: string; set: string }>;
  sealed?: Array<{ uuid?: string; name?: string; set?: string; count?: number }>;
  pack?: Array<{ code?: string; set?: string }>;
  variable?: unknown;
  other?: Array<{ name?: string }>;
}

export interface MtgjsonSealedProduct {
  uuid: string;
  name: string;
  category?: string;
  subtype?: string;
  setCode?: string;
  releaseDate?: string;
  cardCount?: number;
  contents?: MtgjsonSealedContents;
}

export interface MtgjsonSet {
  code?: string;
  name?: string;
  cards?: MtgjsonCard[];
  decks?: MtgjsonDeck[];
  sealedProduct?: MtgjsonSealedProduct[];
}

/** Open AllPrintings as a decompressed byte stream. */
async function openAllPrintings(): Promise<Readable> {
  // Local fixture override for dev/tests: ALLPRINTINGS_FILE=<path.json|.json.gz>.
  const local = process.env.ALLPRINTINGS_FILE;
  if (local) {
    const fileStream = createReadStream(local);
    return local.endsWith('.gz') ? (fileStream.pipe(createGunzip()) as unknown as Readable) : fileStream;
  }
  const res = await fetch(ALL_PRINTINGS_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`AllPrintings download HTTP ${res.status}`);
  const gz = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  return gz.pipe(createGunzip()) as unknown as Readable;
}

/**
 * Stream every set from AllPrintings, invoking `onSet` for each. Resolves when
 * the whole file has been consumed. Sets are handed over one at a time; nothing
 * accumulates here — the caller decides what to keep.
 */
export async function streamSets(onSet: (code: string, set: MtgjsonSet) => void): Promise<void> {
  const source = await openAllPrintings();
  const pipeline = source.pipe(parser()).pipe(pick({ filter: 'data' })).pipe(streamObject());
  await new Promise<void>((resolve, reject) => {
    pipeline.on('data', ({ key, value }: { key: string; value: MtgjsonSet }) => onSet(key, value));
    pipeline.on('end', () => resolve());
    pipeline.on('error', reject);
    source.on('error', reject);
  });
}
