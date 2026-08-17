import { createGunzip } from 'node:zlib';
import { totalmem } from 'node:os';
import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { config } from './config.js';
import type { HistoricalReading, PriceStore } from './priceStore.js';

// One-shot history backfill from MTGJSON. Our own archive only knows the days
// since the archiver went live; MTGJSON's AllPrices carries a rolling 90-day
// window of the same two series we store (Cardmarket EUR, TCGplayer USD), so
// one pass buys every printing roughly two extra months of chart before the
// archive's own first day. Nothing else public goes back further for EUR, so
// this runs once and then the daily appender takes over for good.
//
// Runs in-process on a delay after boot, like the archiver: a deploy stays "scp
// index.js + restart" and a crashed run just retries on the next restart
// (splicing only fills empty days, so a partial run is safe to repeat).

/** MTGJSON's day-keyed price series, e.g. `{"2026-05-18": 11.23}`. */
type DaySeries = Record<string, number>;

interface ProviderPrices {
  currency?: string;
  retail?: { normal?: DaySeries; foil?: DaySeries };
}

interface PriceEntry {
  paper?: Record<string, ProviderPrices>;
}

/**
 * Cards handed to the store per transaction, and the log cadence. Kept small
 * deliberately: node:sqlite is synchronous, so a batch is a stretch where the
 * relay can't answer anyone, and 90k rows of catch-up is not worth a stutter.
 */
const BATCH = 500;
const LOG_EVERY = 25_000;

const DONE_KEY = 'backfill_mtgjson';
const ATTEMPTS_KEY = 'backfill_mtgjson_attempts';

/**
 * Give up after this many starts. The attempt is banked *before* the work, so
 * even a run the kernel OOM-kills counts: without that, a restart loop on a
 * memory-tight VM would retry the same 165 MB of downloads forever.
 */
const MAX_ATTEMPTS = 3;

export interface BackfillResult {
  status: 'disabled' | 'already-done' | 'gave-up' | 'backfilled';
  /** MTGJSON build date the history came from. */
  date?: string;
  cards?: number;
  rows?: number;
  attempts?: number;
}

/**
 * Fill the pre-archive gap once. Records the MTGJSON build it used in `meta`
 * so later boots skip it; `PRICE_BACKFILL_FORCE=1` re-runs anyway.
 */
export async function backfillFromMtgjson(
  store: PriceStore,
  log: FastifyBaseLogger,
): Promise<BackfillResult> {
  if (!config.priceBackfill) return { status: 'disabled' };
  const done = store.getMeta(DONE_KEY);
  if (done && !config.priceBackfillForce) return { status: 'already-done', date: done };
  const attempts = Number(store.getMeta(ATTEMPTS_KEY) || '0') + 1;
  if (attempts > MAX_ATTEMPTS && !config.priceBackfillForce) {
    log.warn({ attempts: attempts - 1 }, 'price backfill: gave up, set PRICE_BACKFILL_FORCE=1 to retry');
    return { status: 'gave-up', attempts: attempts - 1 };
  }
  store.setMeta(ATTEMPTS_KEY, String(attempts));

  // uuid -> scryfallId. The full identifier dump is 228 MB; this CSV is the
  // same mapping at a fifteenth of the size, and its first two columns are
  // exactly the two ids we need.
  log.info({ attempt: attempts, totalMemMb: Math.round(totalmem() / 1e6) }, 'price backfill: fetching MTGJSON id map');
  const byUuid = await fetchIdMap();
  log.info({ printings: byUuid.size }, 'price backfill: id map ready');

  let date = '';
  let cards = 0;
  let rows = 0;
  let batch: [string, HistoricalReading[]][] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    rows += store.spliceHistories(batch);
    batch = [];
    // node:sqlite is synchronous, so hand the relay the event loop back
    // between transactions the way the daily append does.
    await new Promise((r) => setImmediate(r));
  };

  for await (const chunk of streamAllPrices()) {
    if (chunk.kind === 'meta') {
      date = chunk.date;
      log.info({ date }, 'price backfill: reading AllPrices');
      continue;
    }
    const scryfallId = byUuid.get(chunk.uuid);
    if (!scryfallId) continue; // MTGJSON knows a printing Scryfall does not
    const readings = toReadings(chunk.entry);
    if (readings.length === 0) continue;
    batch.push([scryfallId, readings]);
    cards++;
    if (batch.length >= BATCH) await flush();
    if (cards % LOG_EVERY === 0) log.info({ cards, rows }, 'price backfill: progress');
  }
  await flush();

  store.setMeta(DONE_KEY, date || 'unknown');
  const stats = store.stats();
  log.info({ date, cards, rows, printings: stats.printings }, 'price backfill: done');
  return { status: 'backfilled', date, cards, rows, attempts };
}

/**
 * Pull the Cardmarket EUR and TCGplayer USD retail series for a printing and
 * zip them into one reading per day. Nonfoil only, matching what the daily
 * append stores (the archive keeps a single pair per printing).
 */
function toReadings(entry: PriceEntry): HistoricalReading[] {
  const paper = entry.paper ?? {};
  // Guard the currency: the store's two columns are EUR and USD by definition,
  // so a provider that ever changed denomination must be skipped, not trusted.
  const eur = paper.cardmarket?.currency === 'EUR' ? (paper.cardmarket.retail?.normal ?? {}) : {};
  const usd = paper.tcgplayer?.currency === 'USD' ? (paper.tcgplayer.retail?.normal ?? {}) : {};
  const days = new Set([...Object.keys(eur), ...Object.keys(usd)]);
  const out: HistoricalReading[] = [];
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out.push([day, eur[day] ?? null, usd[day] ?? null]);
  }
  return out;
}

async function fetchIdMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let header = true;
  let buf = '';
  let pos = 0;
  for await (const text of gunzippedText(`${config.mtgjsonUrl}/csv/cardIdentifiers.csv.gz`)) {
    buf = pos > 0 ? buf.slice(pos) + text : buf + text;
    pos = 0;
    for (;;) {
      const nl = buf.indexOf('\n', pos);
      if (nl < 0) break;
      const from = pos;
      pos = nl + 1;
      if (header) {
        header = false;
        if (!buf.startsWith('uuid,scryfallId', from)) {
          throw new Error(`cardIdentifiers.csv columns moved: ${buf.slice(from, from + 60)}`);
        }
        continue;
      }
      // uuid,scryfallId,... both are plain UUIDs, so no CSV quoting to unpick.
      const a = buf.indexOf(',', from);
      if (a < 0 || a > nl) continue;
      const b = buf.indexOf(',', a + 1);
      if (b < 0 || b > nl) continue;
      const scryfallId = buf.slice(a + 1, b);
      if (scryfallId) map.set(buf.slice(from, a), scryfallId);
    }
  }
  if (map.size === 0) throw new Error('cardIdentifiers.csv had no rows');
  return map;
}

type PriceChunk = { kind: 'meta'; date: string } | { kind: 'card'; uuid: string; entry: PriceEntry };

/**
 * Walk AllPrices one printing at a time. The file is ~1.5 GB decompressed, far
 * past what JSON.parse will take, but its shape is a flat `{"data": {uuid:
 * {...}}}` map, so we scan for each key and brace-match just its value.
 */
async function* streamAllPrices(): AsyncGenerator<PriceChunk> {
  // `pos` walks the buffer and the buffer is compacted once per chunk rather
  // than once per printing: slicing 90k times instead makes this the heaviest
  // allocator in the process, which a 1 GB VM shares with the live relay.
  let buf = '';
  let pos = 0;
  let inData = false;
  for await (const text of gunzippedText(`${config.mtgjsonUrl}/AllPrices.json.gz`)) {
    buf = pos > 0 ? buf.slice(pos) + text : buf + text;
    pos = 0;
    if (!inData) {
      const at = buf.indexOf('"data"');
      if (at < 0) {
        // Keep a tail in case `"data"` straddles two chunks.
        if (buf.length > 1 << 16) buf = buf.slice(-16);
        continue;
      }
      const meta = /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(buf.slice(0, at));
      yield { kind: 'meta', date: meta?.[1] ?? '' };
      const open = buf.indexOf('{', at + 6);
      if (open < 0) continue;
      pos = open + 1;
      inData = true;
    }
    for (;;) {
      const keyStart = buf.indexOf('"', pos);
      if (keyStart < 0) break;
      const keyEnd = buf.indexOf('"', keyStart + 1);
      if (keyEnd < 0) break;
      const open = buf.indexOf('{', keyEnd + 1);
      if (open < 0) break;
      const close = matchBrace(buf, open);
      if (close < 0) break; // value spans past this chunk
      const uuid = buf.slice(keyStart + 1, keyEnd);
      const entry = JSON.parse(buf.slice(open, close + 1)) as PriceEntry;
      pos = close + 1;
      yield { kind: 'card', uuid, entry };
    }
  }
}

/** Index of the `}` closing the `{` at `open`, or -1 if it isn't in `s` yet. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Decompressed text chunks of a gzipped URL, decoded across chunk boundaries. */
async function* gunzippedText(url: string): AsyncGenerator<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`fetch ${url} failed (${res.status})`);
  const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]).pipe(
    createGunzip(),
  );
  stream.setEncoding('utf8');
  for await (const chunk of stream) yield chunk as string;
}

/**
 * Kick the backfill off once, a while after boot so it never competes with
 * startup or the archiver's first check. Fire and forget: a failure is logged
 * and retried on the next restart.
 */
export function startPriceBackfill(store: PriceStore, log: FastifyBaseLogger): () => void {
  const timer = setTimeout(() => {
    backfillFromMtgjson(store, log).catch((err) =>
      log.warn({ err: (err as Error).message }, 'price backfill failed'),
    );
  }, config.priceBackfillDelayMs);
  timer.unref();
  return () => clearTimeout(timer);
}
