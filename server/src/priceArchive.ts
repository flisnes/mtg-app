import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { FastifyBaseLogger } from 'fastify';
import type { CardDbManifest, PriceMap } from '@mtg/shared';
import { config } from './config.js';
import type { PriceStore } from './priceStore.js';

// The daily price appender (sync plan Phase E). Runs inside the server process
// instead of a separate systemd timer so deploying stays "scp index.js +
// restart" with no extra VM setup: every hour it peeks at the published card
// -DB manifest (the same artifact clients download), and when the prices there
// carry a day newer than the archive tip it fetches the price shard and
// appends one day per printing. A failed run (Pages outage, mid-publish
// manifest) just waits for the next hourly tick.

/** One archive attempt. Returns what happened, for logs/tests. */
export async function archiveOnce(
  store: PriceStore,
  log: FastifyBaseLogger,
): Promise<'disabled' | 'up-to-date' | 'appended'> {
  if (!config.cardDbUrl) return 'disabled';

  const manifest = (await fetchJson(`${config.cardDbUrl}/manifest.json`)) as CardDbManifest;
  const day = typeof manifest.pricesUpdatedAt === 'string' ? manifest.pricesUpdatedAt.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('manifest has no usable pricesUpdatedAt');
  if (day <= store.lastDay()) return 'up-to-date';

  const meta = manifest.v2?.prices;
  if (!meta?.url) throw new Error('manifest has no v2 prices artifact');

  const res = await fetch(`${config.cardDbUrl}/${meta.url}`);
  if (!res.ok) throw new Error(`price shard fetch failed (${res.status})`);
  const json = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
  // The manifest hashes the uncompressed JSON; a mismatch means we raced a
  // publish (manifest and shard from different builds) — retry next tick.
  const sha256 = createHash('sha256').update(json).digest('hex');
  if (sha256 !== meta.sha256) throw new Error('price shard hash mismatch (publish in progress?)');

  const prices = JSON.parse(json) as PriceMap;
  const { appended } = await store.appendDay(day, prices);
  const stats = store.stats();
  log.info({ day, appended, printings: stats.printings }, 'price archive appended');
  return 'appended';
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`fetch ${url} failed (${res.status})`);
  return res.json();
}

/**
 * Kick off the periodic archiver: one check shortly after boot (so a restart
 * never misses a day), then hourly. Timers are unref'd — they never hold the
 * process open. Returns a stop function for tests/shutdown.
 */
export function startPriceArchiver(store: PriceStore, log: FastifyBaseLogger): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    archiveOnce(store, log)
      .catch((err) => log.warn({ err: (err as Error).message }, 'price archive run failed'))
      .finally(() => {
        running = false;
      });
  };
  const startup = setTimeout(tick, config.priceArchiveDelayMs);
  startup.unref();
  const interval = setInterval(tick, config.priceArchiveIntervalMs);
  interval.unref();
  return () => {
    clearTimeout(startup);
    clearInterval(interval);
  };
}
