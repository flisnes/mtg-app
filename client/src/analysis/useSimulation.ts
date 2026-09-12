import { useEffect, useRef, useState } from 'react';
import type { SimDeck } from './simDeck.js';
import type { SimOptions, SimRequest, SimResponse, SimResult } from './simulate.js';

// The simulator's lifecycle: one worker, restarted whenever the deck or the
// settings change, terminated when the sheet closes.
//
// Debounced, because the settings are a toggle and a toggle gets toggled. A
// run that is already obsolete is a run that is heating a phone for nothing.

const DEBOUNCE_MS = 120;

export type SimStatus =
  | { kind: 'idle' }
  | { kind: 'running'; fraction: number; previous?: SimResult }
  | { kind: 'done'; result: SimResult }
  | { kind: 'error'; message: string };

export function useSimulation(deck: SimDeck | null, opts: SimOptions): SimStatus {
  const [status, setStatus] = useState<SimStatus>({ kind: 'idle' });
  const workerRef = useRef<Worker | null>(null);
  // The last good result, so switching from play to draw redraws the chart
  // rather than blanking it for a second. Held in a ref because it must not
  // itself be a reason to re-run.
  const lastRef = useRef<SimResult | undefined>(undefined);

  const key = JSON.stringify(opts);
  useEffect(() => {
    if (!deck || deck.library.length === 0) {
      setStatus({ kind: 'idle' });
      return;
    }
    const timer = setTimeout(() => {
      workerRef.current?.terminate();
      const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      setStatus({ kind: 'running', fraction: 0, previous: lastRef.current });
      worker.onmessage = (e: MessageEvent<SimResponse>) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          setStatus({ kind: 'running', fraction: msg.total > 0 ? msg.done / msg.total : 0, previous: lastRef.current });
        } else if (msg.type === 'done') {
          lastRef.current = msg.result;
          setStatus({ kind: 'done', result: msg.result });
          worker.terminate();
        } else {
          setStatus({ kind: 'error', message: msg.message });
          worker.terminate();
        }
      };
      worker.onerror = (e) => {
        setStatus({ kind: 'error', message: e.message || 'the simulator crashed' });
        worker.terminate();
      };
      worker.postMessage({ deck, opts } satisfies SimRequest);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [deck, key]);

  return status;
}
