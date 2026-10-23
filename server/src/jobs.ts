import type { FastifyBaseLogger } from 'fastify';
import type { AdminJobStatus } from '@mtg/shared';

// The shape every in-process background job shares (the daily price archiver,
// the monthly history import): one run shortly after boot, then on an
// interval, never two at once, timers unref'd so they never hold the process
// open. The last outcome is kept in memory for the admin panel, and the panel
// can also ask for a run right now.

export interface PeriodicJob {
  stop(): void;
  /** Run once now (or report 'busy' when a run is already underway). */
  runNow(): Promise<string>;
  status(): AdminJobStatus;
}

export function startPeriodicJob(
  name: string,
  run: () => Promise<string>,
  opts: { delayMs: number; intervalMs: number },
  log: FastifyBaseLogger,
): PeriodicJob {
  let running = false;
  const last: Omit<AdminJobStatus, 'running'> = { lastRunAt: null, lastResult: null, lastError: null };

  const runOnce = async (): Promise<string> => {
    if (running) return 'busy';
    running = true;
    last.lastRunAt = Date.now();
    try {
      const result = await run();
      last.lastResult = result;
      last.lastError = null;
      return result;
    } catch (err) {
      const message = (err as Error).message;
      last.lastResult = 'failed';
      last.lastError = message;
      log.warn({ err: message }, `${name} run failed`);
      throw err;
    } finally {
      running = false;
    }
  };
  const tick = () => {
    runOnce().catch(() => {
      // logged in runOnce; the next tick retries
    });
  };

  const startup = setTimeout(tick, opts.delayMs);
  startup.unref();
  const interval = setInterval(tick, opts.intervalMs);
  interval.unref();

  return {
    stop() {
      clearTimeout(startup);
      clearInterval(interval);
    },
    runNow: runOnce,
    status: () => ({ running, ...last }),
  };
}
