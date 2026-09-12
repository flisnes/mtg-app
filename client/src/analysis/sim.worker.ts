/// <reference lib="webworker" />
import { simulate, type SimRequest, type SimResponse } from './simulate.js';

// Twenty thousand games with a matching solve in the loop is a second or two of
// solid arithmetic. On the main thread that is a second or two of a frozen
// sheet, so it happens here instead and reports progress on the way.

function post(msg: SimResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const { deck, opts } = e.data;
  try {
    const result = simulate(deck, opts, (done) => post({ type: 'progress', done, total: opts.games }));
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
