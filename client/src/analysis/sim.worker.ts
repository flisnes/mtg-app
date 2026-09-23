/// <reference lib="webworker" />
import { QUICK_GAMES, SPEND_POLICIES, simulate, type SimRequest, type SimResponse, type SimResult, type SpendRun } from './simulate.js';

// Twenty thousand games with a matching solve in the loop is a second or two of
// solid arithmetic. On the main thread that is a second or two of a frozen
// sheet, so it happens here instead and reports progress on the way.
//
// Two passes: a quick one first, so a toggle or a saved rule has an answer in
// a tenth of the time, then the full run. The quick pass is the full run's
// first games again, which costs a tenth more work and buys the wait back.
//
// Then the other spend orders at the quick size (rebuild plan C6), after
// every number the page shows is in, so the spread costs no wait.

function post(msg: SimResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const { deck, opts } = e.data;
  try {
    const quick = Math.min(QUICK_GAMES, opts.games);
    const total = quick < opts.games ? quick + opts.games : opts.games;
    let quickResult: SimResult | undefined;
    if (quick < opts.games) {
      quickResult = simulate(deck, { ...opts, games: quick }, (done) => post({ type: 'progress', done, total }));
      post({ type: 'quick', result: quickResult });
    }
    const offset = total - opts.games;
    const result = simulate(deck, opts, (done) => post({ type: 'progress', done: offset + done, total }));
    post({ type: 'done', result });
    const runs: SpendRun[] = SPEND_POLICIES.map(({ id }) => ({
      spend: id,
      result: id === opts.spend ? (quickResult ?? result) : simulate(deck, { ...opts, spend: id, games: quick }),
    }));
    post({ type: 'spread', runs });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
