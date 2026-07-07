import type { CardDbManifest } from '@mtg/shared';
import { db } from '../db/schema.js';
import { getSetting } from '../db/settings.js';
import { CARD_DB_BASE } from './config.js';
import type { ImportRequest, WorkerResponse } from './messages.js';
import { runScryfallFallback } from './fallback.js';

// Orchestrates card-DB freshness (beta plan §3): compare the served manifest
// version to what's installed, and if they differ (or nothing is installed),
// download + import via the worker. Offline with a local DB is fine — the app
// just runs on what it has.

export type SyncState =
  | { status: 'checking' }
  | { status: 'progress'; fraction: number; label: string }
  | { status: 'ready' }
  | { status: 'offline-no-db' }
  | { status: 'error'; message: string };

interface InstalledInfo {
  version: string | undefined;
  counts: { oracle: number; printings: number } | undefined;
  actualOracle: number;
  actualPrintings: number;
}

async function readInstalled(): Promise<InstalledInfo> {
  const [version, counts, actualOracle, actualPrintings] = await Promise.all([
    getSetting<string>('cardDbVersion'),
    getSetting<{ oracle: number; printings: number }>('cardDbCounts'),
    db.oracleCards.count(),
    db.printings.count(),
  ]);
  return { version, counts, actualOracle, actualPrintings };
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

function runImportWorker(req: ImportRequest, onState: (s: SyncState) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
    const totalBytes = req.oracle.bytes + req.printings.bytes;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const p = msg.progress;
        if (p.phase === 'download') {
          const prior = p.artifact === 'printings' ? req.oracle.bytes : 0;
          const fraction = totalBytes ? (prior + p.loaded) / totalBytes : 0;
          const mb = (n: number) => (n / 1e6).toFixed(1);
          onState({
            status: 'progress',
            fraction: Math.min(0.85, fraction * 0.85),
            label: `Downloading ${p.artifact === 'oracle' ? 'cards' : 'editions'} (${mb(p.loaded)}/${mb(p.total)} MB)`,
          });
        } else {
          const base = p.artifact === 'oracle' ? 0.85 : 0.93;
          onState({
            status: 'progress',
            fraction: base + (p.total ? (p.done / p.total) * 0.07 : 0),
            label: `Preparing ${p.artifact === 'oracle' ? 'cards' : 'editions'}…`,
          });
        }
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

  const upToDate = haveLocal && installed.version === manifest.cardDbVersion;
  if (upToDate) return onState({ status: 'ready' });

  try {
    await runImportWorker(
      {
        baseUrl: CARD_DB_BASE,
        cardDbVersion: manifest.cardDbVersion,
        pricesUpdatedAt: manifest.pricesUpdatedAt,
        oracle: manifest.artifacts.oracle,
        printings: manifest.artifacts.printings,
      },
      onState,
    );
    onState({ status: 'ready' });
  } catch (err) {
    // A failed refresh still leaves a usable older DB behind.
    if (haveLocal) return onState({ status: 'ready' });
    onState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

async function runFallback(onState: (s: SyncState) => void, haveLocal: boolean): Promise<void> {
  try {
    await runScryfallFallback((fraction, label) => onState({ status: 'progress', fraction, label }));
    onState({ status: 'ready' });
  } catch (err) {
    if (haveLocal) return onState({ status: 'ready' });
    // Distinguish "just offline, nothing cached" from a real error.
    if (!navigator.onLine) return onState({ status: 'offline-no-db' });
    onState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}
