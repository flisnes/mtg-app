import { db } from '../db/schema.js';
import { sha256Hex } from '../util/sha256.js';
import { SCAN_DATA_BASE } from './config.js';
import { BLOB_FORMAT_VERSION, parseHashBlob } from './blob.js';

// Scan-data lifecycle (handover §S2): the VM's scanjob publishes
// cardhashes2.bin + manifest2.json (its own version beacon — the card-DB
// manifest is built by CI on Pages, which the VM can't touch). We keep one
// installed copy in IndexedDB and re-download when the beacon version moves.
//
// The v2 filenames are deliberate: the blob's meaning changed (see
// blob.ts BLOB_FORMAT_VERSION) but not its byte layout, so an old build
// pointed at a new blob would parse it happily and match nothing. Publishing
// under new names leaves the v1 pair in place for builds that have not
// updated yet.
const BLOB_FILE = 'cardhashes2.bin';
const MANIFEST_FILE = 'manifest2.json';

/** manifest2.json written by scanjob/hashgen.py. */
export interface ScanDataManifest {
  version: number;
  /** Absent on v1 manifests. */
  formatVersion?: number;
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
  /** Blob format the stored bytes are in; absent on rows written before v2. */
  formatVersion?: number;
  algo: 1 | 2;
  count: number;
  generatedAt: string;
  /** Raw cardhashes2.bin, parsed into a ScanIndex at scan-session start. */
  blob: ArrayBuffer;
}

export async function getInstalledScanData(): Promise<ScanDataRow | undefined> {
  return db.scanData.get('current');
}

/**
 * The installed blob, but only if this build can actually parse it. A device
 * that scanned before the v2 crop change still has a v1 row; parseHashBlob
 * rejects it, so callers must fall through to the download path rather than
 * treating "something is installed" as "scanning is ready".
 */
export async function getUsableScanData(): Promise<ScanDataRow | undefined> {
  const row = await getInstalledScanData();
  return row?.formatVersion === BLOB_FORMAT_VERSION ? row : undefined;
}

export async function fetchScanManifest(): Promise<ScanDataManifest> {
  if (!SCAN_DATA_BASE) throw new Error('no scan-data endpoint configured');
  const res = await fetch(new URL(MANIFEST_FILE, SCAN_DATA_BASE).href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`scan manifest HTTP ${res.status}`);
  return (await res.json()) as ScanDataManifest;
}

/** Download + verify + install the blob the manifest describes. */
export async function downloadScanData(manifest: ScanDataManifest): Promise<ScanDataRow> {
  if (!SCAN_DATA_BASE) throw new Error('no scan-data endpoint configured');
  // ?v= busts HTTP/SW caches when the beacon moves.
  const url = new URL(`${BLOB_FILE}?v=${manifest.version}`, SCAN_DATA_BASE).href;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`scan blob HTTP ${res.status}`);
  const blob = await res.arrayBuffer();
  const sha = await sha256Hex(blob);
  if (sha !== manifest.sha256) throw new Error('scan blob hash mismatch');
  return installScanBlob(blob, manifest.version);
}

/** Validate + store a blob (also used by the test harness's load-from-file). */
export async function installScanBlob(blob: ArrayBuffer, version: number): Promise<ScanDataRow> {
  const index = parseHashBlob(blob); // throws on malformed data / wrong format
  const row: ScanDataRow = {
    key: 'current',
    version,
    formatVersion: BLOB_FORMAT_VERSION,
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
    // A row left over from an older blob format is unusable even when its
    // beacon version happens to line up — parseHashBlob would reject it at
    // scan-session start, so treat it as missing and re-download.
    const usable = installed?.formatVersion === BLOB_FORMAT_VERSION;
    if (installed && usable && installed.version === manifest.version) return { kind: 'none' };
    return { kind: 'update', manifest, installedVersion: usable ? installed!.version : null };
  } catch {
    return { kind: 'none' };
  }
}
