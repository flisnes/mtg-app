import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// stream-json is CommonJS; default-import the modules and pull the factories off.
import streamJson from 'stream-json';
import streamArrayMod from 'stream-json/streamers/StreamArray.js';
const { parser } = streamJson;
const { streamArray } = streamArrayMod;
import type { CardDbChunkMeta, CardDbManifest, OracleCard, PriceMap, Priced, Printing } from '@mtg/shared';
import { getBulkEntry, openBulkStream } from './scryfall.js';
import { slimCard, type RawCard, type SlimResult } from './slimCard.js';
import { buildSealedProducts } from './sealed.js';

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
//   - legacy whole-file artifacts (prices embedded) for pre-chunking clients;
//   - manifest.json tying it all together.
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

function toOracleCard(rep: SlimResult): OracleCard {
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
  };
}

interface Artifact {
  filename: string;
  bytes: number;
  sha256: string;
  count: number;
}

function emit(filename: string, json: string, count: number): Artifact {
  const sha256 = createHash('sha256').update(json).digest('hex');
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(join(OUT_DIR, filename), gz);
  return { filename, bytes: gz.length, sha256, count };
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

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[pipeline] bulk type: ${BULK_TYPE}`);

  const entry = await getBulkEntry(BULK_TYPE);
  console.log(`[pipeline] ${BULK_TYPE} updated_at=${entry.updated_at} size≈${(entry.size / 1e6).toFixed(0)}MB`);

  const webStream = await openBulkStream(entry.download_uri);
  const nodeStream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  const pipeline = nodeStream.pipe(parser()).pipe(streamArray());

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
        if (slim.prices.eur != null || slim.prices.usd != null) {
          prices[slim.printing.scryfallId] = [slim.prices.eur, slim.prices.usd];
        }
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
    nodeStream.on('error', reject);
  });

  console.log(`[pipeline] parsed ${seen} cards, kept ${kept} paper printings, ${reps.size} oracle cards`);
  if (duplicates > 0) console.warn(`[pipeline] dropped ${duplicates} duplicate printings (same scryfallId seen twice in bulk data)`);

  const oracleCards: OracleCard[] = [...reps.values()].map(toOracleCard);

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
  const wantSealed =
    !process.env.SKIP_SEALED && (process.env.ALLPRINTINGS_FILE || (BULK_TYPE === 'default_cards' && MAX_CARDS === Infinity));
  if (wantSealed) {
    try {
      const printingsById = new Map(printings.map((p) => [p.scryfallId, p]));
      const { products, stats } = await buildSealedProducts(printingsById);
      sealedArtifact = emitHashed('sealed', products, products.length);
      console.log(
        `[pipeline]   sealed: ${stats.productsEmitted}/${stats.productsSeen} products from ${stats.setsSeen} sets ` +
          `(${stats.cardsUnavailable} card refs unavailable)`,
      );
    } catch (err) {
      console.warn('[pipeline] sealed-product build failed; shipping without it:', (err as Error).message);
    }
  }

  // Legacy whole-file artifacts with prices embedded, for pre-chunking clients.
  const priceOf = (id: string): { priceEur: number | null; priceUsd: number | null } => {
    const p = prices[id];
    return { priceEur: p?.[0] ?? null, priceUsd: p?.[1] ?? null };
  };
  const legacyOracle: Priced<OracleCard>[] = oracleCards.map((c) => ({ ...c, ...priceOf(c.defaultScryfallId) }));
  const legacyPrintings: Priced<Printing>[] = printings.map((p) => ({ ...p, ...priceOf(p.scryfallId) }));
  const oracleArtifact = emit('oracle-slim.json.gz', JSON.stringify(legacyOracle), legacyOracle.length);
  const printingsArtifact = emit('printings-slim.json.gz', JSON.stringify(legacyPrintings), legacyPrintings.length);

  const meta = (a: Artifact) => ({ url: a.filename, bytes: a.bytes, sha256: a.sha256, count: a.count });
  const manifest: CardDbManifest = {
    cardDbVersion: entry.updated_at,
    latestAppVersion: process.env.APP_VERSION ?? clientVersion(),
    artifacts: {
      oracle: meta(oracleArtifact),
      printings: meta(printingsArtifact),
    },
    pricesUpdatedAt: entry.updated_at,
    v2: {
      dataVersion,
      chunks: { oracle: oracleChunks, printings: printingsChunks },
      prices: meta(pricesArtifact),
      ...(sealedArtifact ? { sealed: meta(sealedArtifact) } : {}),
    },
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const mb = (n: number) => (n / 1e6).toFixed(1);
  const chunkCount = oracleChunks.length + printingsChunks.length;
  const chunkTotal = [...oracleChunks, ...printingsChunks].reduce((s, c) => s + c.bytes, 0);
  console.log(`[pipeline] wrote artifacts to ${OUT_DIR}`);
  console.log(`[pipeline]   card data (${chunkCount} chunks)  ${mb(chunkTotal)}MB  dataVersion=${dataVersion.slice(0, 8)}`);
  console.log(`[pipeline]   ${pricesArtifact.filename}  ${mb(pricesArtifact.bytes)}MB  (${pricesArtifact.count} priced printings)`);
  console.log(`[pipeline]   legacy oracle-slim.json.gz   ${mb(oracleArtifact.bytes)}MB  (${oracleArtifact.count} cards)`);
  console.log(`[pipeline]   legacy printings-slim.json.gz ${mb(printingsArtifact.bytes)}MB  (${printingsArtifact.count} printings)`);
}

void main().catch((err) => {
  console.error('[pipeline] failed:', err);
  process.exit(1);
});
