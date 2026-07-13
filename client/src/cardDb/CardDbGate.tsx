import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hasUsableLocalDb, prepareInitialDownload, type RunSync, type SyncState } from './sync.js';

// Gates the app on a ready card database (beta plan §3). When a usable local DB
// already exists the app renders immediately and any refresh happens in the
// background (see useCardDbUpdate). Only the first run — when there's no data to
// run on — blocks here, and even then it asks before spending data: the ~14 MB
// download starts on a tap, not automatically. Offline with no DB is handled
// explicitly.

type GateState =
  | { status: 'checking' }
  | { status: 'confirm'; sizeBytes?: number }
  | SyncState;

const mb = (n: number) => Math.max(1, Math.round(n / 1e6));

export function CardDbGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const lastAttempt = useRef(-1);
  const run = useRef<RunSync | null>(null);

  useEffect(() => {
    // Run once per distinct attempt — immune to StrictMode's dev double-invoke.
    if (lastAttempt.current === attempt) return;
    lastAttempt.current = attempt;

    void (async () => {
      setState({ status: 'checking' });
      if (await hasUsableLocalDb()) return setState({ status: 'ready' });
      const plan = await prepareInitialDownload();
      if (plan.kind === 'offline-no-db') return setState({ status: 'offline-no-db' });
      if (plan.kind === 'error') return setState({ status: 'error', message: plan.message });
      run.current = plan.run;
      setState({ status: 'confirm', sizeBytes: plan.sizeBytes });
    })();
  }, [attempt]);

  const startDownload = () => {
    const r = run.current;
    if (!r) return;
    void (async () => {
      try {
        await r((s) => setState(s));
        setState({ status: 'ready' });
      } catch (err) {
        if (!navigator.onLine) return setState({ status: 'offline-no-db' });
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
  };

  if (state.status === 'ready') return <>{children}</>;

  return (
    <div className="gate">
      <div className="gate-inner">
        <div className="gate-logo" aria-hidden>
          ◆
        </div>
        <h1>MTG Collection &amp; Trade</h1>

        {state.status === 'checking' && <p className="gate-msg">Checking for card data…</p>}

        {state.status === 'confirm' && (
          <>
            <p className="gate-msg">
              One-time setup downloads the card database
              {state.sizeBytes ? ` (~${mb(state.sizeBytes)} MB)` : ' (~14 MB)'}.
            </p>
            <p className="gate-note">
              It’s stored on your device and works offline afterwards.
            </p>
            <button onClick={startDownload}>Download</button>
          </>
        )}

        {state.status === 'progress' && (
          <>
            <p className="gate-msg">{state.label}</p>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(state.fraction * 100)}>
              <div className="progress-bar" style={{ width: `${Math.round(state.fraction * 100)}%` }} />
            </div>
            <p className="gate-note">Downloading card data. Best on Wi-Fi.</p>
          </>
        )}

        {state.status === 'offline-no-db' && (
          <>
            <p className="gate-msg">You’re offline and the card database isn’t downloaded yet.</p>
            <p className="gate-note">Connect to the internet once to download it, then it works offline.</p>
            <button onClick={() => setAttempt((a) => a + 1)}>Try again</button>
          </>
        )}

        {state.status === 'error' && (
          <>
            <p className="gate-msg">Couldn’t load the card database.</p>
            <p className="gate-note gate-error">{state.message}</p>
            <button onClick={() => setAttempt((a) => a + 1)}>Retry</button>
          </>
        )}
      </div>
    </div>
  );
}
