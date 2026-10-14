// Build the monthly deep price history the server imports (server/src/
// priceMonthly.ts). Run by the "Monthly price history" workflow, or by hand:
//
//   npm run monthly-prices --workspace pipeline
//
// Where the history comes from: MTGJSON only ever publishes a rolling 90-day
// AllPrices, and TCGCSV took its daily archive offline in 2026. What is left
// are the AllPrices files the Wayback Machine happened to capture, listed in
// SNAPSHOTS below. Each is Cardmarket EUR and TCGplayer USD, plain and foil,
// day by day, keyed by MTGJSON uuid; we map uuids to Scryfall ids through
// MTGJSON's current cardIdentifiers.csv and keep one figure per month: the
// median of that month's daily readings.
//
// Env:
//   MONTHLY_OUT        output file (default pipeline/out-monthly/monthly-prices.tsv.gz)
//   MONTHLY_CACHE_DIR  where the downloaded snapshots are kept between runs
//                      (default pipeline/out-monthly/cache)
//   SEVEN_ZIP          path to 7z, used to unpack every snapshot (Windows);
//                      otherwise `unzip -p` and `xz -dc` (Linux runners)

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as pump } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';
import streamJson from 'stream-json';
import PickMod from 'stream-json/filters/Pick.js';
import streamObjectMod from 'stream-json/streamers/StreamObject.js';
import { USER_AGENT } from './mtgjson.js';

const { parser } = streamJson;
const { pick } = PickMod;
const { streamObject } = streamObjectMod;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = process.env.MONTHLY_OUT ?? join(__dirname, '..', 'out-monthly', 'monthly-prices.tsv.gz');
const CACHE_DIR = process.env.MONTHLY_CACHE_DIR ?? join(__dirname, '..', 'out-monthly', 'cache');
const SEVEN_ZIP = process.env.SEVEN_ZIP;

/**
 * Every AllPrices capture the Wayback Machine holds as of 2026-10 (checked
 * with its CDX API for each compression variant). The `id_` URLs return the
 * file as archived, without the Wayback toolbar.
 */
const SNAPSHOTS: { name: string; url: string; kind: 'zip' | 'xz' }[] = [
  // ~Oct 2021 to Jan 2022, daily.
  { name: 'AllPrices-2022-01-06.json.zip', url: 'https://web.archive.org/web/20220106090512id_/https://mtgjson.com/api/v5/AllPrices.json.zip', kind: 'zip' },
  // ~Mar to May 2023, daily.
  { name: 'AllPrices-2023-05-30.json.xz', url: 'https://web.archive.org/web/20230530051025id_/https://mtgjson.com/api/v5/AllPrices.json.xz', kind: 'xz' },
  // One day, 2025-07-08/09.
  { name: 'AllPricesToday-2025-07-09.json.zip', url: 'https://web.archive.org/web/20250709031922id_/https://mtgjson.com/api/v5/AllPricesToday.json.zip', kind: 'zip' },
];

const IDENTIFIERS_URL = 'https://mtgjson.com/api/v5/csv/cardIdentifiers.csv.gz';

type DaySeries = Record<string, number>;
interface ProviderPrices {
  currency?: string;
  retail?: { normal?: DaySeries; foil?: DaySeries };
}
interface PriceEntry {
  paper?: Record<string, ProviderPrices>;
}

/** Lane order, matching the server: eur, usd, eurFoil, usdFoil. */
const LANES = 4;

/** scryfallId -> month -> four lanes of cents (null = no reading). */
const byCard = new Map<string, Map<string, (number | null)[]>>();

async function download(url: string, to: string): Promise<void> {
  if (existsSync(to) && statSync(to).size > 0) return;
  console.log(`downloading ${url}`);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pump(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(`${to}.part`));
      renameSync(`${to}.part`, to);
      return;
    } catch (err) {
      // The Wayback Machine has bad minutes; give it a few.
      if (attempt >= 4) throw err;
      console.warn(`  attempt ${attempt} failed (${(err as Error).message}), retrying`);
      await new Promise((r) => setTimeout(r, attempt * 15_000));
    }
  }
}

/** The snapshot's JSON as a stream, unpacked by an external tool. */
function unpack(file: string, kind: 'zip' | 'xz'): Readable {
  const [cmd, args] = SEVEN_ZIP
    ? [SEVEN_ZIP, ['e', '-so', file]]
    : kind === 'zip'
      ? ['unzip', ['-p', file]]
      : ['xz', ['-dc', file]];
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  child.on('error', (err) => child.stdout.destroy(err));
  return child.stdout;
}

async function loadIdMap(): Promise<Map<string, string>> {
  const res = await fetch(IDENTIFIERS_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`cardIdentifiers HTTP ${res.status}`);
  const text = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]).pipe(createGunzip());
  text.setEncoding('utf8');
  const map = new Map<string, string>();
  let buf = '';
  let header = true;
  for await (const chunk of text) {
    buf += chunk as string;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (header) {
        header = false;
        if (!line.startsWith('uuid,scryfallId')) throw new Error(`cardIdentifiers.csv columns moved: ${line.slice(0, 60)}`);
        continue;
      }
      // uuid,scryfallId,... both plain UUIDs, so no quoting to unpick.
      const a = line.indexOf(',');
      const b = line.indexOf(',', a + 1);
      if (a > 0 && b > a + 1) map.set(line.slice(0, a), line.slice(a + 1, b));
    }
  }
  return map;
}

function median(values: number[]): number {
  values.sort((x, y) => x - y);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/** Fold one printing's daily series into month medians. */
function addEntry(scryfallId: string, entry: PriceEntry): number {
  const paper = entry.paper ?? {};
  const cm = paper.cardmarket?.currency === 'EUR' ? paper.cardmarket.retail : undefined;
  const tcg = paper.tcgplayer?.currency === 'USD' ? paper.tcgplayer.retail : undefined;
  const lanes: (DaySeries | undefined)[] = [cm?.normal, tcg?.normal, cm?.foil, tcg?.foil];
  let added = 0;
  lanes.forEach((series, lane) => {
    if (!series) return;
    const months = new Map<string, number[]>();
    for (const [day, v] of Object.entries(series)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
      const m = day.slice(0, 7);
      const list = months.get(m);
      if (list) list.push(v);
      else months.set(m, [v]);
    }
    for (const [m, values] of months) {
      let card = byCard.get(scryfallId);
      if (!card) byCard.set(scryfallId, (card = new Map()));
      let cells = card.get(m);
      if (!cells) card.set(m, (cells = new Array<number | null>(LANES).fill(null)));
      // A month two snapshots both cover keeps the first one read.
      if (cells[lane] == null) {
        cells[lane] = Math.round(median(values) * 100);
        added++;
      }
    }
  });
  return added;
}

async function readSnapshot(file: string, kind: 'zip' | 'xz', ids: Map<string, string>): Promise<void> {
  let entries = 0;
  let unmapped = 0;
  let cells = 0;
  const stream = unpack(file, kind).pipe(parser()).pipe(pick({ filter: 'data' })).pipe(streamObject());
  for await (const { key, value } of stream as AsyncIterable<{ key: string; value: PriceEntry }>) {
    entries++;
    const scryfallId = ids.get(key);
    if (!scryfallId) {
      unmapped++;
      continue;
    }
    cells += addEntry(scryfallId, value);
  }
  console.log(`  ${entries} printings, ${unmapped} without a Scryfall id today, ${cells} month cells`);
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

function writeOut(): void {
  const lines = ['# mtg-monthly-prices v1'];
  for (const id of [...byCard.keys()].sort()) {
    const card = byCard.get(id)!;
    const months = [...card.keys()].sort();
    const first = months[0]!;
    const last = months[months.length - 1]!;
    const span: string[] = [];
    for (let m = first; m <= last; m = addMonths(m, 1)) span.push(m);
    const cols: string[] = [];
    for (let lane = 0; lane < LANES; lane++) {
      const cells = span.map((m) => card.get(m)?.[lane] ?? null);
      cols.push(cells.some((c) => c != null) ? cells.map((c) => (c == null ? '' : String(c))).join(',') : '');
    }
    lines.push([id, first, ...cols].join('\t'));
  }
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  const gz = gzipSync(lines.join('\n') + '\n', { level: 9 });
  writeFileSync(OUT_FILE, gz);
  console.log(`wrote ${byCard.size} printings to ${OUT_FILE} (${(gz.byteLength / 1e6).toFixed(1)} MB)`);
}

async function main(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const ids = await loadIdMap();
  console.log(`id map: ${ids.size} uuids`);
  for (const snap of SNAPSHOTS) {
    const file = join(CACHE_DIR, snap.name);
    await download(snap.url, file);
    console.log(`reading ${snap.name}`);
    await readSnapshot(file, snap.kind, ids);
  }
  writeOut();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
