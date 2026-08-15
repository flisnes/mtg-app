import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gzipSync, createGunzip } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// stream-json is CommonJS; default-import the module and pull the factory off.
// Scryfall bulk data is JSONL now, so we use the line parser, not StreamArray.
import jsonlMod from 'stream-json/jsonl/Parser.js';
const { parser: jsonlParser } = jsonlMod;
import type {
  CardDbChunkMeta,
  CardDbManifest,
  OracleCard,
  PriceMap,
  PriceTuple,
  Printing,
  SealedPriceMap,
  SetTypeMap,
} from '@mtg/shared';
import { getBulkEntry, getSetTypes, openBulkStream } from './scryfall.js';
import { slimCard, type RawCard, type SlimResult } from './slimCard.js';
import { buildSealedProducts } from './sealed.js';
import { fetchSealedUsdPrices } from './sealedPrices.js';
import { fetchSealedEurPrices } from './cardmarketPrices.js';

// Nightly card-DB pipeline (beta plan §3). Downloads Scryfall `default_cards`,
// slims each card to ~18 fields, and emits:
//   - 256 chunks per artifact (rows grouped by the first TWO hex chars of their
//     id), each content-hash-named, so clients re-download only chunks that
//     changed. Finer buckets mean a day's handful of card changes drags a few
//     tiny chunks instead of revving all 16 coarse ones (ids are UUIDs, so any
//     change scatters across buckets); the delta stays roughly proportional to
//     what actually moved. See client/src/cardDb/sync.ts.
//   - prices.<hash>.json.gz — all prices, separate because they churn daily
//     while the card data itself changes rarely;
//   - sets.<hash>.json.gz — set code → set_type, for the client's non-promo
//     printing preference (a few KB, fetched lazily);
//   - manifest.json tying it all together.
//
// Superseded artifacts are pruned after each build (one build's grace window),
// so OUT_DIR — which CI caches and the deploy copies into the site verbatim —
// holds what's actually served rather than every chunk ever emitted.
//
// Env knobs:
//   BULK_TYPE   default 'default_cards' (use 'oracle_cards' for a fast dry run)
//   MAX_CARDS   optional cap for quick logic tests (stops the stream early)
//   APP_VERSION latestAppVersion for the update beacon; defaults to client ver.
//   OUT_DIR     output directory (default ./out)

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.OUT_DIR ?? join(__dirname, '..', 'out');
const BULK_TYPE = process.env.BULK_TYPE ?? 'default_cards';
const MAX_CARDS = process.env.MAX_CARDS ? Number(process.env.MAX_CARDS) : Infinity;

const HEX = [...'0123456789abcdef'];
// 256 two-hex-char prefixes ('00'..'ff'). Chunk keys must be id prefixes: the
// client deletes a chunk's id-range with an indexed startsWith(key) before
// re-inserting it (see import.worker.ts).
const CHUNK_KEYS = HEX.flatMap((a) => HEX.map((b) => a + b));

/**
 * Pack a printing's prices into the shard tuple `[eur, usd, eurFoil, usdFoil,
 * usdEtched]`, trimming trailing nulls (min length 2 so nonfoil readers always
 * find [0]/[1]). Returns null when every price is null (entry omitted). A tuple
 * longer than 2 signals to the client that foil slots are authoritative.
 */
function priceTuple(p: {
  eur: number | null;
  usd: number | null;
  eurFoil: number | null;
  usdFoil: number | null;
  usdEtched: number | null;
}): PriceTuple | null {
  if (p.eur == null && p.usd == null && p.eurFoil == null && p.usdFoil == null && p.usdEtched == null) return null;
  const full = [p.eur, p.usd, p.eurFoil, p.usdFoil, p.usdEtched];
  let end = full.length;
  while (end > 2 && full[end - 1] == null) end--;
  return full.slice(0, end) as PriceTuple;
}

function clientVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'client', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Prefer English, then a printing that has an image, then the most recent (id as a deterministic tiebreak). */
function betterRepresentative(a: SlimResult, b: SlimResult): SlimResult {
  const aEn = a.printing.lang === 'en' ? 1 : 0;
  const bEn = b.printing.lang === 'en' ? 1 : 0;
  if (aEn !== bEn) return aEn > bEn ? a : b;
  const aImg = a.printing.imageNormal ? 1 : 0;
  const bImg = b.printing.imageNormal ? 1 : 0;
  if (aImg !== bImg) return aImg > bImg ? a : b;
  if (a.printing.releasedAt !== b.printing.releasedAt) {
    return a.printing.releasedAt > b.printing.releasedAt ? a : b;
  }
  return a.printing.scryfallId <= b.printing.scryfallId ? a : b;
}

function toOracleCard(rep: SlimResult, tokenOracleIds: string[]): OracleCard {
  const { printing, oracle } = rep;
  return {
    oracleId: printing.oracleId,
    name: oracle.name,
    manaCost: oracle.manaCost,
    cmc: oracle.cmc,
    typeLine: oracle.typeLine,
    oracleText: oracle.oracleText,
    colors: oracle.colors,
    colorIdentity: oracle.colorIdentity,
    rarity: oracle.rarity,
    imageSmall: printing.imageSmall,
    imageNormal: printing.imageNormal,
    ...(printing.imageBackSmall != null || printing.imageBackNormal != null
      ? { imageBackSmall: printing.imageBackSmall ?? null, imageBackNormal: printing.imageBackNormal ?? null }
      : {}),
    defaultScryfallId: printing.scryfallId,
    legalities: oracle.legalities,
    ...(oracle.power != null || oracle.toughness != null ? { power: oracle.power, toughness: oracle.toughness } : {}),
    ...(tokenOracleIds.length ? { tokenOracleIds } : {}),
    ...(oracle.layout ? { layout: oracle.layout } : {}),
    ...(oracle.reserved ? { reserved: true } : {}),
    ...(oracle.gameChanger ? { gameChanger: true } : {}),
  };
}

interface Artifact {
  filename: string;
  bytes: number;
  sha256: string;
  count: number;
}

/** Emit with a content-addressed name so chunk URLs are immutable (HTTP-cache safe). */
function emitHashed(prefix: string, data: unknown, count: number): Artifact {
  const json = JSON.stringify(data);
  const sha256 = createHash('sha256').update(json).digest('hex');
  const filename = `${prefix}.${sha256.slice(0, 8)}.json.gz`;
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(join(OUT_DIR, filename), gz);
  return { filename, bytes: gz.length, sha256, count };
}

/** Split rows into the 256 fixed chunks by first two hex chars of their id, sorted for stable hashes. */
function emitChunks<T>(name: string, rows: T[], idOf: (row: T) => string): CardDbChunkMeta[] {
  const byKey = new Map<string, T[]>(CHUNK_KEYS.map((k) => [k, []]));
  for (const row of rows) {
    const key = idOf(row).slice(0, 2);
    (byKey.get(key) ?? byKey.get('00'))!.push(row);
  }
  return CHUNK_KEYS.map((key) => {
    const chunk = byKey.get(key)!;
    chunk.sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
    const a = emitHashed(`${name}.${key}`, chunk, chunk.length);
    return { key, url: a.filename, bytes: a.bytes, sha256: a.sha256, count: a.count };
  });
}

/** Every `.json.gz` filename a manifest points a client at. */
function referenced(m: CardDbManifest | null): Set<string> {
  const out = new Set<string>();
  if (!m) return out;
  for (const a of [m.artifacts?.oracle, m.artifacts?.printings, m.v2?.prices, m.v2?.sealed, m.v2?.sealedPrices, m.v2?.sets]) {
    if (a) out.add(a.url);
  }
  for (const c of [...(m.v2?.chunks.oracle ?? []), ...(m.v2?.chunks.printings ?? [])]) out.add(c.url);
  return out;
}

/**
 * Drop artifacts no longer served. Filenames are content-addressed, so every
 * build that changes a chunk writes a new file and leaves the old one sitting
 * in OUT_DIR — which the CI cache carries forward and the deploy copies wholesale
 * into the site, growing it by the day for files nothing links to.
 *
 * The previous build's files are kept as a grace window: a client that fetched
 * the old manifest minutes before a deploy still finds the chunks it was
 * promised, instead of 404ing mid-import.
 */
function pruneUnreferenced(current: CardDbManifest, previous: CardDbManifest | null): { files: number; bytes: number } {
  const keep = referenced(current);
  for (const url of referenced(previous)) keep.add(url);

  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(OUT_DIR)) {
    if (!name.endsWith('.json.gz') || keep.has(name)) continue;
    const path = join(OUT_DIR, name);
    bytes += statSync(path).size;
    unlinkSync(path);
    files++;
  }
  return { files, bytes };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[pipeline] bulk type: ${BULK_TYPE}`);

  // Read before anything overwrites it — this build's grace window (see pruneUnreferenced).
  let previous: CardDbManifest | null = null;
  try {
    previous = JSON.parse(readFileSync(join(OUT_DIR, 'manifest.json'), 'utf8')) as CardDbManifest;
  } catch {
    /* first build in this OUT_DIR, or an unreadable manifest — nothing to preserve */
  }

  const entry = await getBulkEntry(BULK_TYPE);
  console.log(`[pipeline] ${BULK_TYPE} updated_at=${entry.updated_at} size≈${(entry.compressed_size / 1e6).toFixed(0)}MB`);

  const webStream = await openBulkStream(entry.jsonl_download_uri);
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  // The JSONL file is served as raw gzip (no Content-Encoding), so gunzip it
  // ourselves, then parse line-delimited JSON — each line is one card object.
  const gunzip = createGunzip();
  const pipeline = nodeStream.pipe(gunzip).pipe(jsonlParser());

  const printings: Printing[] = [];
  const prices: PriceMap = {};
  const reps = new Map<string, SlimResult>();
  // Scryfall bulk dumps occasionally contain the same card twice; a duplicate
  // scryfallId would make chunk counts disagree with what survives the
  // client's keyed insert, wedging its freshness check.
  const seenIds = new Set<string>();
  let duplicates = 0;

  let seen = 0;
  let kept = 0;

  await new Promise<void>((resolve, reject) => {
    pipeline.on('data', ({ value }: { value: RawCard }) => {
      seen++;
      const slim = slimCard(value);
      if (slim && seenIds.has(slim.printing.scryfallId)) {
        duplicates++;
      } else if (slim) {
        kept++;
        seenIds.add(slim.printing.scryfallId);
        printings.push(slim.printing);
        const tuple = priceTuple(slim.prices);
        if (tuple) prices[slim.printing.scryfallId] = tuple;
        const existing = reps.get(slim.printing.oracleId);
        reps.set(slim.printing.oracleId, existing ? betterRepresentative(existing, slim) : slim);
      }
      if (seen % 50000 === 0) console.log(`[pipeline] streamed ${seen} cards, kept ${kept}…`);
      if (seen >= MAX_CARDS) {
        nodeStream.destroy();
        resolve();
      }
    });
    pipeline.on('end', () => resolve());
    pipeline.on('error', reject);
    gunzip.on('error', reject);
    nodeStream.on('error', reject);
  });

  console.log(`[pipeline] parsed ${seen} cards, kept ${kept} paper printings, ${reps.size} oracle cards`);
  if (duplicates > 0) console.warn(`[pipeline] dropped ${duplicates} duplicate printings (same scryfallId seen twice in bulk data)`);

  // Resolve each representative's all_parts token references (scryfall ids) to
  // oracle ids, so the client can look up "the tokens this card creates" by
  // oracle card like any other card DB lookup.
  const scryfallToOracle = new Map(printings.map((p) => [p.scryfallId, p.oracleId]));
  const oracleCards: OracleCard[] = [...reps.values()].map((rep) => {
    const tokenIds = new Set<string>();
    for (const tokenScryfallId of rep.tokenPartIds) {
      const oracleId = scryfallToOracle.get(tokenScryfallId);
      if (oracleId && oracleId !== rep.printing.oracleId) tokenIds.add(oracleId);
    }
    return toOracleCard(rep, [...tokenIds].sort());
  });

  // Chunked price-less artifacts (primary path).
  const oracleChunks = emitChunks('oracle-slim', oracleCards, (c) => c.oracleId);
  const printingsChunks = emitChunks('printings-slim', printings, (p) => p.scryfallId);
  const dataVersion = createHash('sha256')
    .update([...oracleChunks, ...printingsChunks].map((c) => c.sha256).join(''))
    .digest('hex');

  // Prices, sorted by id for a stable hash on days prices don't move.
  const sortedPrices: PriceMap = Object.fromEntries(Object.entries(prices).sort(([a], [b]) => (a < b ? -1 : 1)));
  const pricesArtifact = emitHashed('prices', sortedPrices, Object.keys(sortedPrices).length);

  // Sealed products (MTGJSON, expanded against the printings above). Runs
  // before the legacy whole-file arrays below so its MTGJSON streaming peak
  // doesn't coexist with them. Best-effort: a MTGJSON outage must not fail the
  // nightly card-DB build, and a partial-data dry run (oracle_cards / MAX_CARDS)
  // can't resolve cards, so skip it there. Set SKIP_SEALED=1 to opt out.
  let sealedArtifact: Artifact | undefined;
  let sealedPricesArtifact: Artifact | undefined;
  const wantSealed =
    !process.env.SKIP_SEALED && (process.env.ALLPRINTINGS_FILE || (BULK_TYPE === 'default_cards' && MAX_CARDS === Infinity));
  if (wantSealed) {
    try {
      const printingsById = new Map(printings.map((p) => [p.scryfallId, p]));
      const { products, stats } = await buildSealedProducts(printingsById);
      sealedArtifact = emitHashed('sealed', products, products.length);
      console.log(
        `[pipeline]   sealed: ${stats.productsEmitted}/${stats.productsSeen} products from ${stats.setsSeen} sets ` +
          `(${stats.productsRandomOnly} unopened-only, ${stats.cardsUnavailable} card refs unavailable)`,
      );

      // Prices for those products, from two sources because no single one
      // covers both markets: TCGplayer (via TCGCSV) for USD, Cardmarket's
      // published price guide for EUR. Each is independently best-effort
      // *inside* the sealed block, so one going down costs half the prices
      // rather than the catalog. SKIP_SEALED_PRICES=1 opts out of both (they're
      // a couple of minutes and ~30 MB, which a local fixture build doesn't
      // want).
      if (!process.env.SKIP_SEALED_PRICES) {
        const usdByTcg: Record<string, number> = {};
        const eurByMcm: Record<string, number> = {};

        try {
          const wanted = new Set(products.map((p) => p.identifiers?.tcgplayer).filter((v): v is string => !!v));
          const { prices, stats: s } = await fetchSealedUsdPrices(wanted);
          Object.assign(usdByTcg, prices);
          console.log(
            `[pipeline]   sealed USD: ${s.priced}/${s.wanted} products priced ` +
              `(${s.groups - s.groupsFailed}/${s.groups} TCGCSV groups)`,
          );
        } catch (err) {
          console.warn('[pipeline] sealed USD price fetch failed:', (err as Error).message);
        }

        try {
          const wanted = new Set(products.map((p) => p.identifiers?.mcm).filter((v): v is string => !!v));
          const { prices, stats: s } = await fetchSealedEurPrices(wanted);
          Object.assign(eurByMcm, prices);
          console.log(
            `[pipeline]   sealed EUR: ${s.priced}/${s.wanted} products priced ` +
              `(Cardmarket guide of ${s.rows} rows, ${s.createdAt ?? 'undated'})`,
          );
        } catch (err) {
          console.warn('[pipeline] sealed EUR price fetch failed:', (err as Error).message);
        }

        // One map keyed by the product's own id, so the client needs no
        // marketplace ids to price what it owns. Trailing nulls trimmed.
        const merged: SealedPriceMap = {};
        for (const p of products) {
          const usd = p.identifiers?.tcgplayer ? (usdByTcg[p.identifiers.tcgplayer] ?? null) : null;
          const eur = p.identifiers?.mcm ? (eurByMcm[p.identifiers.mcm] ?? null) : null;
          if (usd == null && eur == null) continue;
          merged[p.id] = eur == null ? [usd] : [usd, eur];
        }
        const count = Object.keys(merged).length;
        if (count > 0) {
          const sorted: SealedPriceMap = Object.fromEntries(
            Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)),
          );
          sealedPricesArtifact = emitHashed('sealed-prices', sorted, count);
        }
        console.log(`[pipeline]   sealed prices: ${count}/${products.length} products have a price`);
      }
    } catch (err) {
      console.warn('[pipeline] sealed-product build failed; shipping without it:', (err as Error).message);
    }
  }

  // Set types (code → set_type), so the client can tell a normal release from a
  // promo product, Secret Lair or token sheet — the bulk card rows don't say.
  // Tiny and best-effort: without it the "latest non-promo printing" preference
  // just falls back to the plain latest printing.
  let setsArtifact: Artifact | undefined;
  try {
    const setTypes = await getSetTypes();
    const sorted: SetTypeMap = Object.fromEntries(Object.entries(setTypes).sort(([a], [b]) => (a < b ? -1 : 1)));
    setsArtifact = emitHashed('sets', sorted, Object.keys(sorted).length);
    console.log(`[pipeline]   sets: ${setsArtifact.count} set types (${setsArtifact.bytes} B)`);
  } catch (err) {
    console.warn('[pipeline] set-type fetch failed; shipping without it:', (err as Error).message);
  }

  const meta = (a: Artifact) => ({ url: a.filename, bytes: a.bytes, sha256: a.sha256, count: a.count });
  const manifest: CardDbManifest = {
    cardDbVersion: entry.updated_at,
    latestAppVersion: process.env.APP_VERSION ?? clientVersion(),
    pricesUpdatedAt: entry.updated_at,
    v2: {
      dataVersion,
      chunks: { oracle: oracleChunks, printings: printingsChunks },
      prices: meta(pricesArtifact),
      ...(sealedArtifact ? { sealed: meta(sealedArtifact) } : {}),
      ...(sealedPricesArtifact ? { sealedPrices: meta(sealedPricesArtifact) } : {}),
      ...(setsArtifact ? { sets: meta(setsArtifact) } : {}),
    },
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const pruned = pruneUnreferenced(manifest, previous);

  const mb = (n: number) => (n / 1e6).toFixed(1);
  const chunkCount = oracleChunks.length + printingsChunks.length;
  const chunkTotal = [...oracleChunks, ...printingsChunks].reduce((s, c) => s + c.bytes, 0);
  console.log(`[pipeline] wrote artifacts to ${OUT_DIR}`);
  console.log(`[pipeline]   card data (${chunkCount} chunks)  ${mb(chunkTotal)}MB  dataVersion=${dataVersion.slice(0, 8)}`);
  console.log(`[pipeline]   ${pricesArtifact.filename}  ${mb(pricesArtifact.bytes)}MB  (${pricesArtifact.count} priced printings)`);
  if (pruned.files) console.log(`[pipeline]   pruned ${pruned.files} superseded artifacts (${mb(pruned.bytes)}MB)`);
}

void main().catch((err) => {
  console.error('[pipeline] failed:', err);
  process.exit(1);
});
