import { useEffect, useRef, useState, type ReactNode } from 'react';
import { syncCardDb, type SyncState } from './sync.js';

// Gates the app on a ready card database (beta plan §3). On first launch (or a
// version change) it shows a progress screen while the worker imports; once
// ready it renders the app. Offline with no DB is handled explicitly.

export function CardDbGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SyncState>({ status: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const lastAttempt = useRef(-1);

  useEffect(() => {
    // Run once per distinct attempt — immune to StrictMode's dev double-invoke.
    if (lastAttempt.current === attempt) return;
    lastAttempt.current = attempt;
    void syncCardDb(setState);
  }, [attempt]);

  if (state.status === 'ready') return <>{children}</>;

  return (
    <div className="gate">
      <div className="gate-inner">
        <div className="gate-logo" aria-hidden>
          ◆
        </div>
        <h1>MTG Collection &amp; Trade</h1>

        {state.status === 'checking' && <p className="gate-msg">Checking for card data…</p>}

        {state.status === 'progress' && (
          <>
            <p className="gate-msg">{state.label}</p>
            <div className="progress" role="progressbar" aria-valuenow={Math.round(state.fraction * 100)}>
              <div className="progress-bar" style={{ width: `${Math.round(state.fraction * 100)}%` }} />
            </div>
            <p className="gate-note">One-time download (~14 MB). Best on Wi-Fi.</p>
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
