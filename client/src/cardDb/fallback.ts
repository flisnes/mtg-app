import { normalizeColors, type Finish, type OracleCard, type PriceMap, type PriceTuple, type Printing, type Rarity } from '@mtg/shared';
import { db } from '../db/schema.js';
import { deleteSetting, setSetting } from '../db/settings.js';
import { SCRYFALL_BULK_INDEX } from './config.js';
import { buildPriceShards } from './prices.js';

// Documented fallback (beta plan §3): if our VM is unreachable and there's no
// local DB yet, fetch Scryfall's `oracle_cards` bulk directly and slim it
// client-side. This is a degraded path — `oracle_cards` has one printing per
// card, so the edition picker is limited until the VM is reachable again.
// Runs on the main thread (rare path); the primary path uses the worker.

const FINISHES = new Set(['nonfoil', 'foil', 'etched']);
const RARITIES = new Set(['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus']);

interface RawCard {
  id: string;
  oracle_id?: string;
  name: string;
  lang: string;
  released_at: string;
  set: string;
  set_name: string;
  collector_number: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  rarity: string;
  finishes?: string[];
  digital?: boolean;
  games?: string[];
  image_uris?: { small?: string; normal?: string };
  card_faces?: Array<{
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    colors?: string[];
    image_uris?: { small?: string; normal?: string };
  }>;
  prices?: {
    eur?: string | null;
    usd?: string | null;
    eur_foil?: string | null;
    usd_foil?: string | null;
    usd_etched?: string | null;
  };
}

const asFinishes = (v?: string[]): Finish[] => {
  const f = (v ?? []).filter((x): x is Finish => FINISHES.has(x));
  return f.length ? f : ['nonfoil'];
};
const asRarity = (v: string): Rarity => (RARITIES.has(v) ? v : 'common') as Rarity;
/** Nonfoil + foil/etched tuple, trailing nulls trimmed (min length 2). Mirrors the pipeline. */
const priceTuple = (card: RawCard): PriceTuple => {
  const full = [
    asPrice(card.prices?.eur),
    asPrice(card.prices?.usd),
    asPrice(card.prices?.eur_foil),
    asPrice(card.prices?.usd_foil),
    asPrice(card.prices?.usd_etched),
  ];
  let end = full.length;
  while (end > 2 && full[end - 1] == null) end--;
  return full.slice(0, end) as PriceTuple;
};
const asPrice = (v?: string | null): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function image(card: RawCard): { small: string | null; normal: string | null } {
  const u = card.image_uris ?? card.card_faces?.find((f) => f.image_uris)?.image_uris;
  return { small: u?.small ?? null, normal: u?.normal ?? null };
}

function slim(card: RawCard): { oracle: OracleCard; printing: Printing; prices: PriceTuple } | null {
  if (!card.oracle_id || !card.name || card.digital) return null;
  if (card.games && !card.games.includes('paper')) return null;
  const faces = card.card_faces ?? [];
  const img = image(card);
  const printing: Printing = {
    scryfallId: card.id,
    oracleId: card.oracle_id,
    set: card.set,
    setName: card.set_name,
    collectorNumber: card.collector_number,
    lang: card.lang,
    finishes: asFinishes(card.finishes),
    releasedAt: card.released_at,
    imageSmall: img.small,
    imageNormal: img.normal,
  };
  const oracle: OracleCard = {
    oracleId: card.oracle_id,
    name: card.name,
    manaCost: card.mana_cost || faces.map((f) => f.mana_cost).filter(Boolean).join(' // ') || null,
    cmc: card.cmc ?? 0,
    typeLine: card.type_line || faces.map((f) => f.type_line).filter(Boolean).join(' // ') || '',
    oracleText: card.oracle_text ?? (faces.length ? faces.map((f) => f.oracle_text ?? '').join('\n//\n') : null),
    // DFCs have no top-level `colors`, only per-face ones (mirrors the pipeline).
    colors: normalizeColors(card.colors ?? faces.flatMap((f) => f.colors ?? [])),
    colorIdentity: normalizeColors(card.color_identity),
    rarity: asRarity(card.rarity),
    imageSmall: img.small,
    imageNormal: img.normal,
    defaultScryfallId: card.id,
  };
  return { oracle, printing, prices: priceTuple(card) };
}

/** One entry of Scryfall's bulk-data index (only the fields we read). */
interface BulkEntry {
  type: string;
  /**
   * Scryfall migrated bulk data to gzipped JSONL in 2026-07: the old
   * `download_uri` (a JSON array) and `size` are gone. Same migration
   * pipeline/src/scryfall.ts and scanjob/hashgen.py already carry.
   */
  jsonl_download_uri: string;
  updated_at: string;
  compressed_size?: number;
}

export async function runScryfallFallback(onProgress: (fraction: number, label: string) => void): Promise<void> {
  onProgress(0.02, 'Contacting Scryfall…');
  const idx = await fetch(SCRYFALL_BULK_INDEX, { headers: { Accept: 'application/json' } });
  if (!idx.ok) throw new Error(`Scryfall bulk index HTTP ${idx.status}`);
  const entry = ((await idx.json()) as { data: BulkEntry[] }).data.find((d) => d.type === 'oracle_cards');
  if (!entry) throw new Error('no oracle_cards bulk entry');
  if (!entry.jsonl_download_uri) throw new Error('oracle_cards bulk entry has no jsonl_download_uri');

  onProgress(0.08, 'Downloading cards from Scryfall…');
  const res = await fetch(entry.jsonl_download_uri);
  if (!res.ok || !res.body) throw new Error(`Scryfall download HTTP ${res.status}`);

  // Slim each line as it arrives rather than buffering the file. The JSONL is
  // ~25 MB gzipped and several times that decoded, which is a lot of string to
  // hold on the main thread — and every raw card is discarded immediately
  // anyway. The bulk file is served as raw gzip with no Content-Encoding, so
  // fetch does not decompress it for us; DecompressionStream does.
  const oracle: OracleCard[] = [];
  const printings: Printing[] = [];
  const prices: PriceMap = {};
  // Cast around the same DOM-lib variance quirk import.worker.ts documents:
  // both transforms type `writable` as WritableStream<BufferSource>, which
  // pipeThrough won't accept as a Uint8Array sink.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const decode = new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>;
  const reader = res.body.pipeThrough(gunzip).pipeThrough(decode).getReader();

  const take = (line: string): void => {
    const trimmed = line.trim();
    // JSONL has one object per line, but tolerate a stray array-wrapper comma
    // or bracket rather than failing the whole rebuild over punctuation.
    if (!trimmed || trimmed === '[' || trimmed === ']' || trimmed === ',') return;
    let card: RawCard;
    try {
      card = JSON.parse(trimmed.replace(/,$/, '')) as RawCard;
    } catch {
      return; // a single unparseable line shouldn't cost the user the whole DB
    }
    const s = slim(card);
    if (!s) return;
    oracle.push(s.oracle);
    printings.push(s.printing);
    if (s.prices.some((v) => v != null)) prices[s.printing.scryfallId] = s.prices;
  };

  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    // Keep the trailing partial line in the buffer for the next chunk.
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      take(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
    // 0.08 → 0.85 across the download; card count is the only progress signal
    // we have (the decoded length is unknown up front), so scale off it loosely.
    onProgress(Math.min(0.85, 0.08 + oracle.length / 60_000), 'Downloading cards from Scryfall…');
  }
  if (buffer.trim()) take(buffer);
  if (oracle.length === 0) throw new Error('Scryfall bulk file yielded no cards');

  onProgress(0.85, 'Saving…');
  // One transaction so an interrupted rebuild can't leave the tables cleared
  // but unfilled (the worker path replaces chunks transactionally too).
  await db.transaction('rw', [db.oracleCards, db.printings, db.priceShards], async () => {
    await db.oracleCards.clear();
    await db.printings.clear();
    await db.oracleCards.bulkPut(oracle);
    await db.printings.bulkPut(printings);
    await db.priceShards.bulkPut(buildPriceShards(prices));
  });

  await setSetting('cardDbVersion', `${entry.updated_at} (scryfall-fallback)`);
  await setSetting('cardDbUpdatedAt', entry.updated_at);
  await setSetting('pricesUpdatedAt', entry.updated_at);
  // Actual table counts, not array lengths: duplicate ids collapse on insert
  // and a mismatch here would re-gate the app on every launch.
  await setSetting('cardDbCounts', { oracle: await db.oracleCards.count(), printings: await db.printings.count() });
  // Reset chunk/price bookkeeping so the next successful VM sync replaces everything.
  await deleteSetting('cardDbChunks');
  await setSetting('pricesSha256', '(scryfall-fallback)');
  onProgress(1, 'Done');
}
