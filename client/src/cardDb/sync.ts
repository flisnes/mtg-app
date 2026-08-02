import type { CardDbArtifactMeta, CardDbManifest } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getSetting, setSetting } from '../db/settings.js';
import { CARD_DB_BASE } from './config.js';
import type { ChunkTask, ImportRequest, WorkerResponse } from './messages.js';
import { runScryfallFallback } from './fallback.js';
import { invalidateSearchIndex } from './search.js';
import { invalidatePriceCache } from './prices.js';

// Orchestrates card-DB freshness (beta plan §3). The manifest describes the
// card data as 256 hash-named chunks per artifact plus a separate prices file;
// we download only the pieces whose hash differs from what's installed. Card
// data changes rarely, prices churn daily — so the typical daily update is the
// small prices file, not the full ~14 MB. Fine buckets keep even a card-data
// update proportional to what actually changed, rather than revving everything.
// Offline with a local DB is fine — the app just runs on what it has.

export type SyncState =
  | { status: 'checking' }
  | { status: 'progress'; fraction: number; label: string }
  | { status: 'ready' }
  | { status: 'offline-no-db' }
  | { status: 'error'; message: string };

/** Executes one download+import, relaying progress; caller decides ready/error. */
export type RunSync = (onState: (s: SyncState) => void) => Promise<void>;

/** What the blocking first-run path needs to do (no usable local DB yet). */
export type InitialPlan =
  | {
      kind: 'download';
      sizeBytes?: number;
      run: RunSync;
      /** Picking up an interrupted install: some chunks are already on disk. */
      resuming?: boolean;
    }
  | { kind: 'offline-no-db' }
  | { kind: 'error'; message: string };

/** What a background refresh should do when a usable local DB already exists. */
export type BgUpdate =
  | { kind: 'none' }
  | { kind: 'prices'; sizeBytes: number; run: RunSync }
  | {
      kind: 'card-data';
      sizeBytes: number;
      run: RunSync;
      /**
       * Prices ride along inside `run`, but they're two separate user choices —
       * someone who declines a 14 MB card-data update may still want the small
       * daily price file. Present when prices also changed.
       */
      prices?: { sizeBytes: number; run: RunSync };
    };

type InstalledChunks = Record<'oracle' | 'printings', Record<string, { sha256: string; count: number }>>;

interface InstalledInfo {
  version: string | undefined;
  counts: { oracle: number; printings: number } | undefined;
  chunks: InstalledChunks | undefined;
  pricesSha: string | undefined;
  actualOracle: number;
  actualPrintings: number;
}

async function readInstalled(): Promise<InstalledInfo> {
  const [version, counts, chunks, pricesSha, actualOracle, actualPrintings] = await Promise.all([
    getSetting<string>('cardDbVersion'),
    getSetting<{ oracle: number; printings: number }>('cardDbCounts'),
    getSetting<InstalledChunks>('cardDbChunks'),
    getSetting<string>('pricesSha256'),
    db.oracleCards.count(),
    db.printings.count(),
  ]);
  return { version, counts, chunks, pricesSha, actualOracle, actualPrintings };
}

/**
 * A local DB is usable once an install has run to completion (a version is
 * stamped, last of all) and the card tables actually hold rows.
 *
 * Row counts are deliberately NOT part of this test. Chunk imports are atomic,
 * but the counts bookkeeping is only checkpointed every N chunks, so any
 * interruption — an app-update reload, a backgrounded PWA, a chunk URL that
 * 404s — routinely leaves the recorded counts a few rows behind the tables.
 * The database in that state is perfectly coherent (a mix of old and new
 * chunks), yet the old equality check called it broken and sent the client back
 * through the first-run gate for all ~17 MB. Per-chunk hashes are the real
 * freshness signal; the background delta check picks up whatever was left.
 */
function localDbUsable(info: InstalledInfo): boolean {
  return !!info.version && info.actualOracle > 0 && info.actualPrintings > 0;
}

async function fetchManifest(base: string): Promise<CardDbManifest> {
  const res = await fetch(new URL('manifest.json', base).href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return (await res.json()) as CardDbManifest;
}

/** Chunks whose served hash differs from the installed one (all of them on a fresh/unusable DB). */
function changedChunks(manifest: NonNullable<CardDbManifest['v2']>, installed: InstalledChunks | undefined): ChunkTask[] {
  const out: ChunkTask[] = [];
  for (const artifact of ['oracle', 'printings'] as const) {
    for (const chunk of manifest.chunks[artifact]) {
      if (installed?.[artifact]?.[chunk.key]?.sha256 !== chunk.sha256) out.push({ artifact, ...chunk });
    }
  }
  return out;
}

function runImportWorker(req: ImportRequest, onState: (s: SyncState) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onState({ status: 'progress', fraction: Math.min(1, msg.fraction), label: msg.label });
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve();
      } else {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'import worker crashed'));
    };
    worker.postMessage(req);
  });
}

/** Total download bytes for a set of chunks plus (optionally) the prices file. */
function totalBytes(chunks: ChunkTask[], prices: CardDbArtifactMeta | null): number {
  return chunks.reduce((s, c) => s + c.bytes, 0) + (prices?.bytes ?? 0);
}

/** Build a run that imports the given chunks + prices via the worker, then refreshes caches. */
function workerRun(
  manifest: NonNullable<CardDbManifest['v2']>,
  meta: Pick<CardDbManifest, 'cardDbVersion' | 'pricesUpdatedAt'>,
  chunks: ChunkTask[],
  prices: CardDbArtifactMeta | null,
  stampVersion = true,
): RunSync {
  return async (onState) => {
    await runImportWorker(
      {
        baseUrl: CARD_DB_BASE!,
        dataVersion: manifest.dataVersion,
        cardDbUpdatedAt: meta.cardDbVersion,
        pricesUpdatedAt: meta.pricesUpdatedAt,
        chunks,
        prices,
        stampVersion,
      },
      onState,
    );
    invalidateSearchIndex();
    invalidatePriceCache();
  };
}

/** Build a run that rebuilds the DB from Scryfall directly (degraded, main-thread). */
function fallbackRun(): RunSync {
  return async (onState) => {
    await runScryfallFallback((fraction, label) => onState({ status: 'progress', fraction, label }));
    invalidateSearchIndex();
    invalidatePriceCache();
  };
}

/** Cheap, network-free check: is there a complete local DB we can run the app on right now? */
export async function hasUsableLocalDb(): Promise<boolean> {
  const info = await readInstalled();
  if (!localDbUsable(info)) return false;
  // Counts no longer gate the app, but About still shows them — reconcile a
  // checkpoint the last run didn't reach rather than leaving a stale figure.
  if (info.counts?.oracle !== info.actualOracle || info.counts?.printings !== info.actualPrintings) {
    await setSetting('cardDbCounts', { oracle: info.actualOracle, printings: info.actualPrintings });
  }
  return true;
}

/**
 * Plan the first-run download (call only when there's no usable local DB — the
 * app can't run without card data). Fetches the manifest to size the download,
 * but does NOT start it: the caller confirms before spending data.
 */
export async function prepareInitialDownload(): Promise<InitialPlan> {
  // No VM configured, or VM/manifest unreachable → Scryfall fallback (size unknown).
  const fallback = (): InitialPlan =>
    navigator.onLine ? { kind: 'download', run: fallbackRun() } : { kind: 'offline-no-db' };

  if (!CARD_DB_BASE) return fallback();

  let manifest: CardDbManifest;
  try {
    manifest = await fetchManifest(CARD_DB_BASE);
  } catch {
    return fallback();
  }
  // A manifest without v2 shouldn't occur (our pipeline always emits it), but
  // don't brick the app over it — degrade to the fallback.
  if (!manifest.v2) return fallback();

  // Resume rather than restart. An install interrupted before it stamped a
  // version still left rows and per-chunk bookkeeping behind, so only the
  // chunks it never got are actually owed. Empty tables mean there's nothing to
  // trust (fresh install, or the browser cleared us out) — take the lot.
  const installed = await readInstalled();
  const resuming = installed.actualOracle > 0 && installed.actualPrintings > 0;
  const chunks = changedChunks(manifest.v2, resuming ? installed.chunks : undefined);
  const prices = resuming && installed.pricesSha === manifest.v2.prices.sha256 ? null : manifest.v2.prices;
  return {
    kind: 'download',
    sizeBytes: totalBytes(chunks, prices),
    run: workerRun(manifest.v2, manifest, chunks, prices),
    resuming,
  };
}

/**
 * Plan a background refresh (call only when a usable local DB exists). Returns
 * silently ('none') on any error/offline — the app keeps running on current
 * data. Prices-only changes are meant to run silently; card-data changes are
 * meant to be confirmed first (prices ride along in the same download).
 */
export async function checkForBackgroundUpdate(): Promise<BgUpdate> {
  if (!CARD_DB_BASE) return { kind: 'none' };

  let manifest: CardDbManifest;
  try {
    manifest = await fetchManifest(CARD_DB_BASE);
  } catch {
    return { kind: 'none' }; // offline / VM down → stay on what we have
  }
  if (!manifest.v2) return { kind: 'none' };

  const installed = await readInstalled();
  const chunks = changedChunks(manifest.v2, installed.chunks);
  const pricesChanged = installed.pricesSha !== manifest.v2.prices.sha256;
  if (!chunks.length && !pricesChanged) return { kind: 'none' };

  const prices = pricesChanged ? manifest.v2.prices : null;
  if (chunks.length) {
    return {
      kind: 'card-data',
      sizeBytes: totalBytes(chunks, prices),
      run: workerRun(manifest.v2, manifest, chunks, prices),
      // A prices-only run while card chunks are still outstanding must not claim
      // the new card-data version — About would then report a date the card rows
      // don't have. Hence stampVersion: false.
      ...(prices
        ? { prices: { sizeBytes: prices.bytes, run: workerRun(manifest.v2, manifest, [], prices, false) } }
        : {}),
    };
  }
  return {
    kind: 'prices',
    sizeBytes: manifest.v2.prices.bytes,
    run: workerRun(manifest.v2, manifest, [], manifest.v2.prices),
  };
}
