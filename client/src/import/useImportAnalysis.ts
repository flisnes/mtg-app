import { useEffect, useRef, useState } from 'react';
import type { ResolveResponse, ResolveResult, TradelistMode } from './types.js';

// Shared import driver (beta plan §5). Owns the resolve worker's lifecycle so
// both the collection Import route and the deck ImportPanel can reuse the same
// parse → resolve → review pipeline instead of duplicating it.

export type ImportStatus =
  | { kind: 'idle' }
  | { kind: 'working'; label: string; fraction: number }
  | { kind: 'review'; result: ResolveResult }
  | { kind: 'error'; message: string };

export function useImportAnalysis() {
  const [status, setStatus] = useState<ImportStatus>({ kind: 'idle' });
  const workerRef = useRef<Worker | null>(null);

  // Kill any in-flight analysis when leaving the screen (or re-analyzing).
  useEffect(() => () => workerRef.current?.terminate(), []);

  function analyze(text: string, opts: { tradelistMode?: TradelistMode } = {}) {
    if (!text.trim()) return;
    setStatus({ kind: 'working', label: 'Starting…', fraction: 0 });
    workerRef.current?.terminate();
    const worker = new Worker(new URL('./resolve.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<ResolveResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') setStatus({ kind: 'working', label: msg.label, fraction: msg.fraction });
      else if (msg.type === 'done') {
        setStatus({ kind: 'review', result: msg.result });
        worker.terminate();
      } else {
        setStatus({ kind: 'error', message: msg.message });
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      setStatus({ kind: 'error', message: e.message || 'import worker crashed' });
      worker.terminate();
    };
    worker.postMessage({ text, tradelistMode: opts.tradelistMode ?? 'none' });
  }

  function reset() {
    workerRef.current?.terminate();
    setStatus({ kind: 'idle' });
  }

  return { status, analyze, reset };
}
