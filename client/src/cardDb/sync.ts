import type { CardDbManifest } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { CARD_DB_BASE } from './config.js';
import type { ChunkTask, ImportRequest, WorkerResponse } from './messages.js';
import { runScryfallFallback } from './fallback.js';
import { invalidateSearchIndex } from './search.js';
import { invalidatePriceCache } from './prices.js';

// Orchestrates card-DB freshness (beta plan §3). The manifest describes the
// card data as 16 hash-named chunks per artifact plus a separate prices file;
// we download only the pieces whose hash differs from what's installed. Card
// data changes rarely, prices churn daily — so the typical daily update is the
// small prices file, not the full ~14 MB. Offline with a local DB is fine —
// the app just runs on what it has.

export type SyncState =
  | { status: 'checking' }
  | { status: 'progress'; fraction: number; label: string }
  | { status: 'ready' }
  | { status: 'offline-no-db' }
  | { status: 'error'; message: string };

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

/** A local DB is usable if a version is recorded and the row counts still match it. */
function localDbUsable(info: InstalledInfo): boolean {
  if (!info.version || !info.counts) return false;
  return info.actualOracle === info.counts.oracle && info.actualPrintings === info.counts.printings;
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

export async function syncCardDb(onState: (s: SyncState) => void): Promise<void> {
  onState({ status: 'checking' });
  const installed = await readInstalled();
  const haveLocal = localDbUsable(installed);

  // No VM configured: rely on local DB, else the Scryfall fallback.
  if (!CARD_DB_BASE) {
    if (haveLocal) return onState({ status: 'ready' });
    return runFallback(onState, haveLocal);
  }

  let manifest: CardDbManifest;
  try {
    manifest = await fetchManifest(CARD_DB_BASE);
  } catch {
    // Offline or VM down. Run on the local DB if we have one, else fall back.
    if (haveLocal) return onState({ status: 'ready' });
    return runFallback(onState, haveLocal);
  }

  // A manifest without v2 shouldn't occur (our pipeline always emits it), but
  // don't brick the app over it.
  if (!manifest.v2) {
    if (haveLocal) return onState({ status: 'ready' });
    return runFallback(onState, haveLocal);
  }

  const chunks = changedChunks(manifest.v2, haveLocal ? installed.chunks : undefined);
  const pricesChanged = !haveLocal || installed.pricesSha !== manifest.v2.prices.sha256;
  if (!chunks.length && !pricesChanged) return onState({ status: 'ready' });

  try {
    await runImportWorker(
      {
        baseUrl: CARD_DB_BASE,
        dataVersion: manifest.v2.dataVersion,
        cardDbUpdatedAt: manifest.cardDbVersion,
        pricesUpdatedAt: manifest.pricesUpdatedAt,
        chunks,
        prices: pricesChanged ? manifest.v2.prices : null,
      },
      onState,
    );
    invalidateSearchIndex();
    invalidatePriceCache();
    onState({ status: 'ready' });
  } catch (err) {
    // A failed refresh still leaves a usable older DB behind (chunk imports are
    // atomic, so a partial update is a consistent mix of old and new chunks).
    if (haveLocal) return onState({ status: 'ready' });
    onState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

async function runFallback(onState: (s: SyncState) => void, haveLocal: boolean): Promise<void> {
  try {
    await runScryfallFallback((fraction, label) => onState({ status: 'progress', fraction, label }));
    invalidateSearchIndex();
    invalidatePriceCache();
    onState({ status: 'ready' });
  } catch (err) {
    if (haveLocal) return onState({ status: 'ready' });
    // Distinguish "just offline, nothing cached" from a real error.
    if (!navigator.onLine) return onState({ status: 'offline-no-db' });
    onState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}
