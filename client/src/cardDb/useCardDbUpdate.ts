import { useCallback, useEffect, useRef, useState } from 'react';
import { getPrefs, setPrefs, type UpdatePolicy } from '../prefs.js';
import { checkForBackgroundUpdate, type RunSync } from './sync.js';

// Keeps an already-usable card DB fresh without ever blocking the app. Runs only
// once the gate has rendered the app (a usable DB exists). Prices churn daily and
// are small; card data changes rarely and is large. Either way the download +
// import run in the worker, so the app stays fully usable. See beta plan §3.
//
// What happens when an update is waiting is the user's call, per feed
// (prefs.ts pricesPolicy / cardDbPolicy):
//   'ask'    — a banner offers it, with a "don't ask again" that writes one of
//              the two settings below. The default: a fresh install downloads
//              nothing it wasn't given permission for.
//   'always' — downloaded silently in the background.
//   'never'  — skipped; Settings still has a "Check now" button.
//
// Declining a card-data update doesn't have to mean declining prices: they ride
// along in the same run, but sync.ts also hands back a prices-only run for
// exactly this case.

/** Which feed a prompt is about — decides the wording and which policy it writes. */
export type UpdateKind = 'prices' | 'card-data';

export interface UpdatePromptState {
  kind: UpdateKind;
  sizeBytes: number;
}

export interface CardDbUpdate {
  /** Non-null when an update is available and awaiting the user's decision. */
  prompt: UpdatePromptState | null;
  /** A confirmed update is downloading in the background. */
  downloading: boolean;
  /** Live download+import progress while `downloading`, else null. */
  progress: { fraction: number; label: string } | null;
  /** Bumps after a completed card-data update so views re-query the new data. */
  epoch: number;
  /** Accept the pending update. `remember` writes the policy to 'always'. */
  applyUpdate: (remember?: boolean) => void;
  /** Decline it. `remember` writes the policy to 'never'; otherwise it's
   *  suppressed until the next launch. */
  dismiss: (remember?: boolean) => void;
  /** Re-check now, ignoring a 'never' policy and any earlier dismissal. */
  checkNow: () => Promise<void>;
}

export function useCardDbUpdate(): CardDbUpdate {
  const [prompt, setPrompt] = useState<UpdatePromptState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const run = useRef<RunSync | null>(null);
  const dismissed = useRef<Partial<Record<UpdateKind, boolean>>>({}); // "Not now", until next launch
  const busy = useRef(false); // a check or an import is in flight

  /** Download now, reporting progress; bumps `epoch` on a card-data success. */
  const start = useCallback((r: RunSync, kind: UpdateKind) => {
    busy.current = true;
    setDownloading(true);
    setProgress({ fraction: 0, label: 'Starting…' });
    return r((s) => {
      if (s.status === 'progress') setProgress({ fraction: s.fraction, label: s.label });
    })
      .then(() => {
        setPrompt(null);
        // Prices reflect on the next query (the cache was invalidated); new card
        // data needs the views to re-run their queries.
        if (kind === 'card-data') setEpoch((e) => e + 1);
      })
      .catch(() => {
        /* older data stays intact (atomic chunk imports); leave the prompt to retry */
      })
      .finally(() => {
        setDownloading(false);
        setProgress(null);
        busy.current = false;
      });
  }, []);

  const check = useCallback(async (manual = false) => {
    if (!manual && document.visibilityState !== 'visible') return;
    if (busy.current) return;
    busy.current = true;
    try {
      const upd = await checkForBackgroundUpdate();
      if (upd.kind === 'none') return;

      const prefs = getPrefs();
      const policyFor = (kind: UpdateKind): UpdatePolicy =>
        manual ? 'always' : kind === 'prices' ? prefs.pricesPolicy : prefs.cardDbPolicy;

      if (upd.kind === 'prices') {
        const policy = policyFor('prices');
        if (policy === 'never') return;
        if (policy === 'always') {
          busy.current = false; // start() takes the lock itself
          await start(upd.run, 'prices');
          return;
        }
        if (dismissed.current.prices) return;
        run.current = upd.run;
        setPrompt({ kind: 'prices', sizeBytes: upd.sizeBytes });
        return;
      }

      // Card data. Prices are bundled into its run, so an accepted card-data
      // update covers both; a declined one may still leave prices to take.
      const cardPolicy = policyFor('card-data');
      if (cardPolicy === 'always') {
        busy.current = false;
        await start(upd.run, 'card-data');
        return;
      }
      if (cardPolicy === 'ask' && !dismissed.current['card-data']) {
        run.current = upd.run;
        setPrompt({ kind: 'card-data', sizeBytes: upd.sizeBytes });
        return;
      }
      // Card data declined (or 'never'): fall back to the prices-only run, which
      // has its own policy and is a fraction of the size.
      if (!upd.prices) return;
      const pricePolicy = policyFor('prices');
      if (pricePolicy === 'never') return;
      if (pricePolicy === 'always') {
        busy.current = false;
        await start(upd.prices.run, 'prices');
        return;
      }
      if (dismissed.current.prices) return;
      run.current = upd.prices.run;
      setPrompt({ kind: 'prices', sizeBytes: upd.prices.sizeBytes });
    } finally {
      busy.current = false;
    }
  }, [start]);

  useEffect(() => {
    void check();
    // Re-check when the app returns to the foreground (PWAs resume after days).
    const onVis = () => void check();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [check]);

  const applyUpdate = useCallback(
    (remember = false) => {
      const r = run.current;
      const kind = prompt?.kind;
      if (!r || !kind || busy.current) return;
      if (remember) setPrefs(kind === 'prices' ? { pricesPolicy: 'always' } : { cardDbPolicy: 'always' });
      void start(r, kind);
    },
    [prompt, start],
  );

  const dismiss = useCallback(
    (remember = false) => {
      const kind = prompt?.kind;
      if (!kind) return;
      if (remember) setPrefs(kind === 'prices' ? { pricesPolicy: 'never' } : { cardDbPolicy: 'never' });
      else dismissed.current[kind] = true;
      setPrompt(null);
      // Declining card data may still leave the small price file on the table.
      if (kind === 'card-data') void check();
    },
    [prompt, check],
  );

  const checkNow = useCallback(async () => {
    dismissed.current = {};
    await check(true);
  }, [check]);

  return { prompt, downloading, progress, epoch, applyUpdate, dismiss, checkNow };
}
