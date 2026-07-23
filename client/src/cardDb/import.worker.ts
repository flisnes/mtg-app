/// <reference lib="webworker" />
import type { Table } from 'dexie';
import type { PriceMap } from '@mtg/shared';
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
//
// Downloads run a few at a time (chunks are small and numerous — 256 per
// artifact — so a fresh install would otherwise pay hundreds of serial round
// trips). Imports and bookkeeping stay strictly sequential and in order: chunk
// id-ranges are disjoint so order doesn't affect correctness, and serializing
// the writes keeps the resume bookkeeping race-free.

type InstalledChunks = Record<'oracle' | 'printings', Record<string, { sha256: string; count: number }>>;

function post(msg: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

/** Download a .gz artifact, reporting byte deltas, and return decompressed text. */
async function downloadDecompressed(
  url: string,
  compressedBytes: number,
  onDelta: (bytes: number) => void,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${url.split('/').pop()}: HTTP ${res.status}`);

  // Report deltas (not cumulative) so concurrent downloads can share one counter.
  let loaded = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const capped = Math.min(loaded + chunk.byteLength, compressedBytes);
      onDelta(capped - loaded);
      loaded = capped;
      controller.enqueue(chunk);
    },
  });

  // Cast around a DOM-lib variance quirk: DecompressionStream.writable is typed
  // WritableStream<BufferSource>, which pipeThrough won't accept as a Uint8Array sink.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const stream = res.body.pipeThrough(counting).pipeThrough(gunzip);
  return await new Response(stream).text();
}

// How much of a chunk's byte share the download phase covers; the rest is the
// IndexedDB import, which on typical hardware takes about as long again.
const DOWNLOAD_SHARE = 0.6;
const IMPORT_BATCH = 2000;
// How many chunk downloads may run ahead of the (sequential) importer. Bounds
// both the in-flight fetches and the decompressed text held in memory.
const DOWNLOAD_CONCURRENCY = 6;
// Persist resume bookkeeping every this-many chunks rather than after each one
// (there are ~512 on a fresh install; per-chunk writes would be O(n²)).
const PERSIST_EVERY = 16;

/**
 * Atomically replace one chunk's id-range: delete rows with the key prefix,
 * insert the new set. Rows go in batches so progress keeps moving during the
 * write (still one transaction, so interruption can't leave a partial chunk).
 */
async function importChunk(task: ChunkTask, rows: unknown[], onRows: (fraction: number) => void): Promise<void> {
  const replace = <T>(table: Table<T, string>) =>
    db.transaction('rw', table, async () => {
      await table.where(':id').startsWith(task.key).delete();
      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        await table.bulkPut(rows.slice(i, i + IMPORT_BATCH) as T[]);
        onRows(Math.min(1, (i + IMPORT_BATCH) / rows.length));
      }
    });
  if (task.artifact === 'oracle') await replace(db.oracleCards);
  else await replace(db.printings);
}

async function readChunkState(): Promise<InstalledChunks> {
  const stored = await getSetting<InstalledChunks>('cardDbChunks');
  return { oracle: { ...stored?.oracle }, printings: { ...stored?.printings } };
}

self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const req = e.data;
  try {
    const totalBytes = req.chunks.reduce((s, c) => s + c.bytes, 0) + (req.prices?.bytes ?? 0);
    const cardBytes = req.chunks.reduce((s, c) => s + c.bytes, 0);
    const mb = (n: number) => (n / 1e6).toFixed(1);

    // Blended progress: downloaded bytes carry DOWNLOAD_SHARE of each chunk's
    // weight, imported bytes the rest. Both accumulate across the run, so
    // concurrent downloads and the sequential importer each push it forward.
    let downloadedBytes = 0;
    let importedBytes = 0;
    const emit = (label: string) =>
      post({
        type: 'progress',
        fraction: totalBytes ? (downloadedBytes * DOWNLOAD_SHARE + importedBytes * (1 - DOWNLOAD_SHARE)) / totalBytes : 0,
        label,
      });
    // Card-chunk downloads share one counter and a live MB label.
    const onCardDelta = (bytes: number) => {
      downloadedBytes += bytes;
      emit(`Downloading card data (${mb(Math.min(downloadedBytes, cardBytes))}/${mb(cardBytes)} MB)`);
    };

    const chunkState = await readChunkState();

    // Download a bounded window of chunks ahead of the importer; import them in
    // order. Each slot settles to {text} or {err} so a prefetch that fails while
    // the importer is still on an earlier chunk never trips an unhandled
    // rejection — the error is re-thrown when the loop reaches that index.
    const tasks = req.chunks;
    type Fetched = { text: string } | { err: unknown };
    const pending: Array<Promise<Fetched> | undefined> = new Array(tasks.length);
    let started = 0;
    const startUpTo = (limit: number) => {
      while (started < tasks.length && started < limit) {
        const idx = started++;
        const task = tasks[idx]!;
        const url = new URL(task.url, req.baseUrl).href;
        pending[idx] = (async (): Promise<Fetched> => {
          const text = await downloadDecompressed(url, task.bytes, onCardDelta);
          if ((await sha256Hex(text)) !== task.sha256) {
            throw new Error(`${task.artifact} chunk ${task.key} checksum mismatch: download corrupt`);
          }
          return { text };
        })().then(
          (v) => v,
          (err) => ({ err }),
        );
      }
    };
    startUpTo(DOWNLOAD_CONCURRENCY);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const fetched = await pending[i]!;
      pending[i] = undefined; // release the decompressed text
      if ('err' in fetched) throw fetched.err;
      const { text } = fetched;

      const label = `Installing ${task.artifact === 'oracle' ? 'cards' : 'editions'}…`;
      const base = importedBytes;
      const importProgress = (rowFraction: number) => {
        importedBytes = base + task.bytes * rowFraction;
        emit(label);
      };
      await importChunk(task, JSON.parse(text) as unknown[], importProgress);
      importedBytes = base + task.bytes;

      // Persist bookkeeping periodically (not every chunk — there are hundreds)
      // so an interrupted update resumes near where it left off. Re-importing a
      // chunk is idempotent (delete range + insert), so the worst a crash costs
      // is redoing this batch. Counts come from the tables themselves, not the
      // manifest: a duplicate id in a chunk collapses on insert, and a
      // manifest-derived count would then mismatch forever, re-gating the app.
      chunkState[task.artifact][task.key] = { sha256: task.sha256, count: task.count };
      if ((i + 1) % PERSIST_EVERY === 0 || i === tasks.length - 1) {
        await setSetting('cardDbChunks', chunkState);
        await setSetting('cardDbCounts', { oracle: await db.oracleCards.count(), printings: await db.printings.count() });
      }

      // Top up the download window now that a slot has freed.
      startUpTo(i + 1 + DOWNLOAD_CONCURRENCY);
    }

    if (req.prices) {
      const url = new URL(req.prices.url, req.baseUrl).href;
      const text = await downloadDecompressed(url, req.prices.bytes, (bytes) => {
        downloadedBytes += bytes;
        emit('Downloading prices…');
      });
      if ((await sha256Hex(text)) !== req.prices.sha256) throw new Error('prices checksum mismatch: download corrupt');
      importedBytes += req.prices.bytes;
      emit('Updating prices…');
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
