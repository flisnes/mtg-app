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
import type { CardDbManifest, OracleCard, Printing } from '@mtg/shared';
import { getBulkEntry, openBulkStream } from './scryfall.js';
import { slimCard, type RawCard, type SlimResult } from './slimCard.js';

// Nightly card-DB pipeline (beta plan §3). Downloads Scryfall `default_cards`,
// slims each card to ~18 fields, and emits two gzipped artifacts + a manifest
// that Caddy serves as static files.
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

function clientVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'client', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Prefer English, then a printing that has an image, then the most recent. */
function betterRepresentative(a: SlimResult, b: SlimResult): SlimResult {
  const aEn = a.printing.lang === 'en' ? 1 : 0;
  const bEn = b.printing.lang === 'en' ? 1 : 0;
  if (aEn !== bEn) return aEn > bEn ? a : b;
  const aImg = a.printing.imageNormal ? 1 : 0;
  const bImg = b.printing.imageNormal ? 1 : 0;
  if (aImg !== bImg) return aImg > bImg ? a : b;
  return a.printing.releasedAt >= b.printing.releasedAt ? a : b;
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
    defaultScryfallId: printing.scryfallId,
    priceEur: printing.priceEur,
    priceUsd: printing.priceUsd,
  };
}

interface Artifact {
  filename: string;
  bytes: number;
  sha256: string;
  count: number;
}

function emit(filename: string, data: unknown[]): Artifact {
  const json = JSON.stringify(data);
  const sha256 = createHash('sha256').update(json).digest('hex');
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(join(OUT_DIR, filename), gz);
  return { filename, bytes: gz.length, sha256, count: data.length };
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
  const reps = new Map<string, SlimResult>();

  let seen = 0;
  let kept = 0;

  await new Promise<void>((resolve, reject) => {
    pipeline.on('data', ({ value }: { value: RawCard }) => {
      seen++;
      const slim = slimCard(value);
      if (slim) {
        kept++;
        printings.push(slim.printing);
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

  const oracleCards: OracleCard[] = [...reps.values()].map(toOracleCard);

  const oracleArtifact = emit('oracle-slim.json.gz', oracleCards);
  const printingsArtifact = emit('printings-slim.json.gz', printings);

  const manifest: CardDbManifest = {
    cardDbVersion: entry.updated_at,
    latestAppVersion: process.env.APP_VERSION ?? clientVersion(),
    artifacts: {
      oracle: {
        url: oracleArtifact.filename,
        bytes: oracleArtifact.bytes,
        sha256: oracleArtifact.sha256,
        count: oracleArtifact.count,
      },
      printings: {
        url: printingsArtifact.filename,
        bytes: printingsArtifact.bytes,
        sha256: printingsArtifact.sha256,
        count: printingsArtifact.count,
      },
    },
    pricesUpdatedAt: entry.updated_at,
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`[pipeline] wrote artifacts to ${OUT_DIR}`);
  console.log(
    `[pipeline]   oracle-slim.json.gz   ${(oracleArtifact.bytes / 1e6).toFixed(1)}MB  (${oracleArtifact.count} cards)`,
  );
  console.log(
    `[pipeline]   printings-slim.json.gz ${(printingsArtifact.bytes / 1e6).toFixed(1)}MB  (${printingsArtifact.count} printings)`,
  );
}

void main().catch((err) => {
  console.error('[pipeline] failed:', err);
  process.exit(1);
});
