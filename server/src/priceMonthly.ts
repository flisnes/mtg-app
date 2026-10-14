import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import type { MonthlyRow, PriceStore } from './priceStore.js';

// Monthly deep price history (v0.198.0). The daily archive reaches back to
// spring 2026 at best (MTGJSON's window is 90 days), and the only older
// per-printing prices anyone can still download are the few MTGJSON AllPrices
// snapshots the Wayback Machine kept: late 2021, spring 2023 and one day in
// July 2025. Those are hundreds of MB of zip/xz the VM has no tools or memory
// to spare for, so they are boiled down elsewhere (pipeline/src/monthlyPrices.ts,
// run by the "Monthly price history" workflow) into one small file of
// per-month medians, and that file is copied into DATA_DIR.
//
// This module only imports it: every hour it looks at the file, and when its
// size or mtime differs from what was last imported, streams it into the
// `price_monthly` table. A missing file is the normal state on a fresh server.
//
// File format (gzip, one printing per line, tab separated):
//   # mtg-monthly-prices v1
//   <scryfallId> <startMonth YYYY-MM> <eur> <usd> <eurFoil> <usdFoil>
// Each price column is cents per month, comma separated; an empty slot is a
// month with no reading and an empty column a lane with none at all.

const HEADER = '# mtg-monthly-prices v1';
const BATCH = 2_000;
const META_KEY = 'monthly_import';

function cells(s: string | undefined): (number | null)[] | null {
  if (!s) return null;
  return s.split(',').map((v) => (v === '' ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null));
}

/** Import the monthly file if it changed since the last import. */
export async function importMonthlyOnce(
  store: PriceStore,
  log: FastifyBaseLogger,
  file = config.monthlyPricesFile,
): Promise<'missing' | 'unchanged' | 'imported'> {
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'missing';
  }
  if (store.getMeta(META_KEY) === stamp) return 'unchanged';

  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let first = true;
  let rows = 0;
  let batch: MonthlyRow[] = [];
  for await (const line of lines) {
    if (first) {
      first = false;
      if (line.trim() !== HEADER) throw new Error(`monthly prices: unexpected header ${line.slice(0, 40)}`);
      continue;
    }
    const [id, startMonth, ...lanes] = line.split('\t');
    if (!id || !startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) continue;
    batch.push([id, startMonth, [0, 1, 2, 3].map((i) => cells(lanes[i]))]);
    if (batch.length >= BATCH) {
      rows += store.putMonthly(batch);
      batch = [];
      // node:sqlite is synchronous: hand the relay the event loop back.
      await new Promise((r) => setImmediate(r));
    }
  }
  rows += store.putMonthly(batch);
  store.setMeta(META_KEY, stamp);
  log.info({ rows, file }, 'monthly price history imported');
  return 'imported';
}

/** Check for a new monthly file shortly after boot, then hourly. */
export function startMonthlyImport(store: PriceStore, log: FastifyBaseLogger): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    importMonthlyOnce(store, log)
      .catch((err) => log.warn({ err: (err as Error).message }, 'monthly price import failed'))
      .finally(() => {
        running = false;
      });
  };
  const startup = setTimeout(tick, config.priceArchiveDelayMs * 2);
  startup.unref();
  const interval = setInterval(tick, config.priceArchiveIntervalMs);
  interval.unref();
  return () => {
    clearTimeout(startup);
    clearInterval(interval);
  };
}
