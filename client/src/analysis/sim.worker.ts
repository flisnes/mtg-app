/// <reference lib="webworker" />
import { QUICK_GAMES, simulate, type SimRequest, type SimResponse } from './simulate.js';

// Twenty thousand games with a matching solve in the loop is a second or two of
// solid arithmetic. On the main thread that is a second or two of a frozen
// sheet, so it happens here instead and reports progress on the way.
//
// Two passes: a quick one first, so a toggle or a saved rule has an answer in
// a tenth of the time, then the full run. The quick pass is the full run's
// first games again, which costs a tenth more work and buys the wait back.

function post(msg: SimResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const { deck, opts } = e.data;
  try {
    const quick = Math.min(QUICK_GAMES, opts.games);
    const total = quick < opts.games ? quick + opts.games : opts.games;
    if (quick < opts.games) {
      post({ type: 'quick', result: simulate(deck, { ...opts, games: quick }, (done) => post({ type: 'progress', done, total })) });
    }
    const offset = total - opts.games;
    const result = simulate(deck, opts, (done) => post({ type: 'progress', done: offset + done, total }));
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
