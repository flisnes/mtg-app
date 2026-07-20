import { db } from '../db/schema.js';
import { sha256Hex } from '../util/sha256.js';
import { SCAN_DATA_BASE } from './config.js';
import { parseHashBlob } from './blob.js';

// Scan-data lifecycle (handover §S2): the VM's scanjob publishes
// cardhashes.bin + manifest.json (its own version beacon — the card-DB
// manifest is built by CI on Pages, which the VM can't touch). We keep one
// installed copy in IndexedDB and re-download when the beacon version moves.

/** manifest.json written by scanjob/hashgen.py. */
export interface ScanDataManifest {
  version: number;
  algo: 1 | 2;
  count: number;
  bytes: number;
  sha256: string;
  generatedAt: string;
  bulkUpdatedAt?: string;
}

export interface ScanDataRow {
  key: 'current';
  version: number;
  algo: 1 | 2;
  count: number;
  generatedAt: string;
  /** Raw cardhashes.bin, parsed into a ScanIndex at scan-session start. */
  blob: ArrayBuffer;
}

export async function getInstalledScanData(): Promise<ScanDataRow | undefined> {
  return db.scanData.get('current');
}

export async function fetchScanManifest(): Promise<ScanDataManifest> {
  if (!SCAN_DATA_BASE) throw new Error('no scan-data endpoint configured');
  const res = await fetch(new URL('manifest.json', SCAN_DATA_BASE).href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`scan manifest HTTP ${res.status}`);
  return (await res.json()) as ScanDataManifest;
}

/** Download + verify + install the blob the manifest describes. */
export async function downloadScanData(manifest: ScanDataManifest): Promise<ScanDataRow> {
  if (!SCAN_DATA_BASE) throw new Error('no scan-data endpoint configured');
  // ?v= busts HTTP/SW caches when the beacon moves.
  const url = new URL(`cardhashes.bin?v=${manifest.version}`, SCAN_DATA_BASE).href;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`scan blob HTTP ${res.status}`);
  const blob = await res.arrayBuffer();
  const sha = await sha256Hex(blob);
  if (sha !== manifest.sha256) throw new Error('scan blob hash mismatch');
  return installScanBlob(blob, manifest.version);
}

/** Validate + store a blob (also used by the test harness's load-from-file). */
export async function installScanBlob(blob: ArrayBuffer, version: number): Promise<ScanDataRow> {
  const index = parseHashBlob(blob); // throws on malformed data
  const row: ScanDataRow = {
    key: 'current',
    version,
    algo: index.algo,
    count: index.count,
    generatedAt: new Date().toISOString(),
    blob,
  };
  await db.scanData.put(row);
  return row;
}

/**
 * Beacon check: is there a newer blob than the installed one? Errors and
 * missing config resolve to 'none' — scanning just runs on what it has.
 */
export async function checkScanDataUpdate(): Promise<
  { kind: 'none' } | { kind: 'update'; manifest: ScanDataManifest; installedVersion: number | null }
> {
  if (!SCAN_DATA_BASE) return { kind: 'none' };
  try {
    const [manifest, installed] = await Promise.all([fetchScanManifest(), getInstalledScanData()]);
    if (installed && installed.version === manifest.version) return { kind: 'none' };
    return { kind: 'update', manifest, installedVersion: installed?.version ?? null };
  } catch {
    return { kind: 'none' };
  }
}
