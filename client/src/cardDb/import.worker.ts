/// <reference lib="webworker" />
import type { OracleCard, PriceMap, Printing } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { sha256Hex } from '../util/sha256.js';
import { buildPriceShards } from './prices.js';
import type { ChunkTask, ImportRequest, WorkerResponse } from './messages.js';

// Runs off the main thread. Fetches each changed chunk (gzipped), decompresses
// it with the platform DecompressionStream (so we don't depend on server
// Content-Encoding), and replaces just that chunk's id-range in IndexedDB.
// Bookkeeping (chunk hashes, counts) is persisted after every chunk, so an
// interrupted update resumes where it left off instead of starting over.

type InstalledChunks = Record<'oracle' | 'printings', Record<string, { sha256: string; count: number }>>;

function post(msg: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

/** Download a .gz artifact, reporting byte progress, and return decompressed text. */
async function downloadDecompressed(
  url: string,
  compressedBytes: number,
  onBytes: (loaded: number) => void,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${url.split('/').pop()}: HTTP ${res.status}`);

  let loaded = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      onBytes(Math.min(loaded, compressedBytes));
      controller.enqueue(chunk);
    },
  });

  // Cast around a DOM-lib variance quirk: DecompressionStream.writable is typed
  // WritableStream<BufferSource>, which pipeThrough won't accept as a Uint8Array sink.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const stream = res.body.pipeThrough(counting).pipeThrough(gunzip);
  return await new Response(stream).text();
}

/** Atomically replace one chunk's id-range: delete rows with the key prefix, insert the new set. */
async function importChunk(task: ChunkTask, rows: unknown[]): Promise<void> {
  if (task.artifact === 'oracle') {
    await db.transaction('rw', db.oracleCards, async () => {
      await db.oracleCards.where(':id').startsWith(task.key).delete();
      await db.oracleCards.bulkPut(rows as OracleCard[]);
    });
  } else {
    await db.transaction('rw', db.printings, async () => {
      await db.printings.where(':id').startsWith(task.key).delete();
      await db.printings.bulkPut(rows as Printing[]);
    });
  }
}

async function readChunkState(): Promise<InstalledChunks> {
  const stored = await getSetting<InstalledChunks>('cardDbChunks');
  return { oracle: { ...stored?.oracle }, printings: { ...stored?.printings } };
}

self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const req = e.data;
  try {
    const totalBytes = req.chunks.reduce((s, c) => s + c.bytes, 0) + (req.prices?.bytes ?? 0);
    let doneBytes = 0;
    const mb = (n: number) => (n / 1e6).toFixed(1);
    const downloadProgress = (label: string) => (loaded: number) =>
      post({
        type: 'progress',
        // A chunk's byte share is 85% download, 15% import.
        fraction: totalBytes ? (doneBytes + loaded * 0.85) / totalBytes : 0,
        label: `${label} (${mb(doneBytes + loaded)}/${mb(totalBytes)} MB)`,
      });

    const chunkState = await readChunkState();

    for (const task of req.chunks) {
      const url = new URL(task.url, req.baseUrl).href;
      const text = await downloadDecompressed(url, task.bytes, downloadProgress('Downloading card data'));
      if ((await sha256Hex(text)) !== task.sha256) {
        throw new Error(`${task.artifact} chunk ${task.key} checksum mismatch — download corrupt`);
      }
      post({
        type: 'progress',
        fraction: totalBytes ? (doneBytes + task.bytes * 0.85) / totalBytes : 0,
        label: `Preparing ${task.artifact === 'oracle' ? 'cards' : 'editions'}…`,
      });
      await importChunk(task, JSON.parse(text) as unknown[]);

      // Persist bookkeeping after every chunk so an interrupted update resumes.
      chunkState[task.artifact][task.key] = { sha256: task.sha256, count: task.count };
      const sum = (m: Record<string, { count: number }>) => Object.values(m).reduce((s, c) => s + c.count, 0);
      await setSetting('cardDbChunks', chunkState);
      await setSetting('cardDbCounts', { oracle: sum(chunkState.oracle), printings: sum(chunkState.printings) });

      doneBytes += task.bytes;
    }

    if (req.prices) {
      const url = new URL(req.prices.url, req.baseUrl).href;
      const text = await downloadDecompressed(url, req.prices.bytes, downloadProgress('Downloading prices'));
      if ((await sha256Hex(text)) !== req.prices.sha256) throw new Error('prices checksum mismatch — download corrupt');
      post({ type: 'progress', fraction: totalBytes ? (doneBytes + req.prices.bytes * 0.85) / totalBytes : 0, label: 'Updating prices…' });
      await db.priceShards.bulkPut(buildPriceShards(JSON.parse(text) as PriceMap));
      await setSetting('pricesSha256', req.prices.sha256);
      await setSetting('pricesUpdatedAt', req.pricesUpdatedAt);
    }

    // Record the data version last: if anything above throws, the version stays
    // stale and the next launch picks up the remaining chunks.
    await setSetting('cardDbVersion', req.dataVersion);
    await setSetting('cardDbUpdatedAt', req.cardDbUpdatedAt);

    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
