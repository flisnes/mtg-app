/// <reference lib="webworker" />
import type { OracleCard, Printing } from '@mtg/shared';
import { db } from '../db/schema.js';
import { setSetting } from '../db/settings.js';
import type { ImportRequest, WorkerResponse, ImportProgress } from './messages.js';

// Runs off the main thread. Fetches each gzipped artifact, decompresses it with
// the platform DecompressionStream (so we don't depend on server
// Content-Encoding), parses, and bulk-imports into IndexedDB in chunks.

const IMPORT_CHUNK = 5000;

function post(msg: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

function progress(p: ImportProgress): void {
  post({ type: 'progress', progress: p });
}

/** Download a .gz artifact, reporting byte progress, and return decompressed text. */
async function downloadDecompressed(
  url: string,
  compressedBytes: number,
  artifact: 'oracle' | 'printings',
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${artifact}: HTTP ${res.status}`);

  // Count compressed bytes as they arrive for the progress bar, then gunzip.
  let loaded = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      progress({ phase: 'download', artifact, loaded, total: compressedBytes });
      controller.enqueue(chunk);
    },
  });

  // Cast around a DOM-lib variance quirk: DecompressionStream.writable is typed
  // WritableStream<BufferSource>, which pipeThrough won't accept as a Uint8Array sink.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const stream = res.body.pipeThrough(counting).pipeThrough(gunzip);
  return await new Response(stream).text();
}

async function importOracle(cards: OracleCard[]): Promise<void> {
  await db.oracleCards.clear();
  for (let i = 0; i < cards.length; i += IMPORT_CHUNK) {
    await db.oracleCards.bulkPut(cards.slice(i, i + IMPORT_CHUNK));
    progress({ phase: 'import', artifact: 'oracle', done: Math.min(i + IMPORT_CHUNK, cards.length), total: cards.length });
  }
}

async function importPrintings(printings: Printing[]): Promise<void> {
  await db.printings.clear();
  for (let i = 0; i < printings.length; i += IMPORT_CHUNK) {
    await db.printings.bulkPut(printings.slice(i, i + IMPORT_CHUNK));
    progress({
      phase: 'import',
      artifact: 'printings',
      done: Math.min(i + IMPORT_CHUNK, printings.length),
      total: printings.length,
    });
  }
}

self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const req = e.data;
  try {
    const oracleUrl = new URL(req.oracle.url, req.baseUrl).href;
    const printingsUrl = new URL(req.printings.url, req.baseUrl).href;

    const oracleText = await downloadDecompressed(oracleUrl, req.oracle.bytes, 'oracle');
    const oracleCards = JSON.parse(oracleText) as OracleCard[];
    await importOracle(oracleCards);

    const printingsText = await downloadDecompressed(printingsUrl, req.printings.bytes, 'printings');
    const printings = JSON.parse(printingsText) as Printing[];
    await importPrintings(printings);

    // Record version last: if anything above throws, the version stays stale
    // and the next launch retries the whole import.
    await setSetting('cardDbVersion', req.cardDbVersion);
    await setSetting('pricesUpdatedAt', req.pricesUpdatedAt);
    await setSetting('cardDbCounts', { oracle: oracleCards.length, printings: printings.length });

    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
