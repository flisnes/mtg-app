import { useCallback, useEffect, useRef, useState } from 'react';
import { checkForBackgroundUpdate, type RunSync } from './sync.js';

// Keeps an already-usable card DB fresh without ever blocking the app. Runs only
// once the gate has rendered the app (a usable DB exists). Prices churn daily and
// are small, so a prices-only change updates silently in the background; the
// larger, rarer card-data change surfaces a prompt so the user can decide before
// spending data. Either way the download + import run in the worker, so the app
// stays fully usable. See beta plan §3.

export interface CardDbUpdate {
  /** Non-null when a card-data update is available and awaiting the user's OK. */
  prompt: { sizeBytes: number } | null;
  /** A confirmed card-data update is downloading in the background. */
  downloading: boolean;
  /** Live download+import progress while `downloading`, else null. */
  progress: { fraction: number; label: string } | null;
  /** Bumps after a completed card-data update so views re-query the new data. */
  epoch: number;
  applyUpdate: () => void;
  dismiss: () => void;
}

export function useCardDbUpdate(): CardDbUpdate {
  const [prompt, setPrompt] = useState<{ sizeBytes: number } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const run = useRef<RunSync | null>(null);
  const dismissed = useRef(false); // "Not now" — suppressed until next launch
  const busy = useRef(false); // a check or an import is in flight

  const check = useCallback(async () => {
    if (document.visibilityState !== 'visible' || busy.current) return;
    busy.current = true;
    try {
      const upd = await checkForBackgroundUpdate();
      if (upd.kind === 'none') return;
      if (upd.kind === 'prices') {
        // Silent: no UI. Prices reflect on the next query (cache is invalidated).
        try {
          await upd.run(() => {});
        } catch {
          /* keep the older prices; try again next launch */
        }
        return;
      }
      // card-data: don't download yet — let the user decide.
      if (dismissed.current) return;
      run.current = upd.run;
      setPrompt({ sizeBytes: upd.sizeBytes });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void check();
    // Re-check when the app returns to the foreground (PWAs resume after days).
    const onVis = () => void check();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [check]);

  const applyUpdate = useCallback(() => {
    const r = run.current;
    if (!r || busy.current) return;
    busy.current = true;
    setDownloading(true);
    setProgress({ fraction: 0, label: 'Starting…' });
    void r((s) => {
      if (s.status === 'progress') setProgress({ fraction: s.fraction, label: s.label });
    })
      .then(() => {
        // Success: drop the prompt and nudge views to re-query the new data.
        setPrompt(null);
        setEpoch((e) => e + 1);
      })
      .catch(() => {
        /* older DB stays intact (atomic chunk imports); leave the prompt to retry */
      })
      .finally(() => {
        setDownloading(false);
        setProgress(null);
        busy.current = false;
      });
  }, []);

  const dismiss = useCallback(() => {
    dismissed.current = true;
    setPrompt(null);
  }, []);

  return { prompt, downloading, progress, epoch, applyUpdate, dismiss };
}
