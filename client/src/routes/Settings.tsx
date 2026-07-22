import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { MIN_PASSWORD_CHARS, USERNAME_RE } from '@mtg/shared';
import { ApiError } from '../account/api.js';
import {
  confirmReplaceWithAccount,
  deleteAccount,
  signIn,
  signOut,
  signUp,
} from '../account/session.js';
import { useAccount } from '../account/useAccount.js';
import { syncNow } from '../sync/engine.js';
import { useToast } from '../components/Toast.js';
import { DataTransfer } from '../components/DataTransfer.js';
import { deleteAllUserData } from '../db/dataAccess.js';
import { setGoblinMode, useGoblinMode } from '../components/useGoblinMode.js';
import { formatDiagnostics } from '../errorLog.js';
import { Page } from './Page.js';
import { fmtDateTime as fmtWhen } from '../util/format.js';

// One home for everything management-y: your account (auth + sync), your data
// (transfer/backup), and preferences. Purely informational bits (version,
// attribution) live on the About page instead.

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.friendlyMessage;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const DISCLAIMER = (
  <div className="account-disclaimer">
    <p className="fine-print">Creating an account is optional, the app works fully without one. By creating one you agree to all of this:</p>
    <ul className="fine-print">
      <li>
        Your collection, lists and decks are stored on a <strong>small hobby server</strong> and synced between the
        devices you sign in on. It is run with care but with no uptime or durability promises. It could go away or
        lose data at any time. Keep making local exports of anything you can’t afford to lose.
      </li>
      <li>
        Your <strong>tradelist and wishlist are visible to every other signed-in user</strong> (so you can find trades).
        Your collection, decks and prices stay private.
      </li>
      <li>
        Don’t reuse a password from anywhere else. Your data is sent over HTTPS and your password is stored only as
        a hash, but this is still a hobby project, not a bank.
      </li>
      <li>You can delete your account (and everything stored with it) at any time from this screen.</li>
    </ul>
  </div>
);

export function Settings() {
  const account = useAccount();

  return (
    <Page title="Settings">
      <AccountSection />
      <PreferencesSection />
      <DataSection signedIn={!!account.session} />
      <TroubleSection />
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Account: auth when signed out; sync + management when signed in
// ---------------------------------------------------------------------------

function AccountSection() {
  const account = useAccount();

  if (!account.enabled) {
    return (
      <section className="about-section">
        <h2>Account &amp; sync</h2>
        <p className="fine-print">
          Accounts (to sync across devices and share trade lists) need a secure connection to the server, which isn’t
          configured for this build yet. Coming in a later update.
        </p>
      </section>
    );
  }
  if (account.session === undefined) {
    return (
      <section className="about-section">
        <h2>Account &amp; sync</h2>
        {null}
      </section>
    );
  }
  return account.session ? <SignedIn /> : <SignedOut />;
}

function SignedOut() {
  const [mode, setMode] = useState<'create' | 'signin'>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const creating = mode === 'create';
  const valid =
    USERNAME_RE.test(username.trim()) &&
    password.length >= (creating ? MIN_PASSWORD_CHARS : 1) &&
    (!creating || (invite.trim().length > 0 && agreed));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        await signUp(username.trim(), password, invite.trim());
        toast('Account created. This device’s data is syncing to it.');
      } else {
        const action = await signIn(username.trim(), password);
        if (action === 'seeded') toast('Signed in. This device’s data now lives on your account.');
        else if (action === 'pulled') toast('Signed in. Downloading your data…');
        else if (action === 'resumed') toast(`Signed in as ${username.trim()}, syncing.`);
        // 'confirm_replace' → the signed-in view shows the decision panel.
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="about-section">
      <h2>Account &amp; sync</h2>
      <p className="fine-print">
        Optional: keep your collection in sync across your devices and share your trade and wishlists with other users.
      </p>

      <div className="seg-row" role="tablist" aria-label="Account mode">
        <button
          role="tab"
          aria-selected={creating}
          className={creating ? 'seg seg-active' : 'seg'}
          onClick={() => setMode('create')}
        >
          Create account
        </button>
        <button
          role="tab"
          aria-selected={!creating}
          className={!creating ? 'seg seg-active' : 'seg'}
          onClick={() => setMode('signin')}
        >
          Sign in
        </button>
      </div>

      {creating && DISCLAIMER}

      <form className="account-form" onSubmit={submit}>
        <label className="field">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="3–20 letters, digits, _"
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={creating ? 'new-password' : 'current-password'}
            placeholder={creating ? `at least ${MIN_PASSWORD_CHARS} characters` : undefined}
          />
        </label>
        {creating && (
          <>
            <label className="field">
              Invite code
              <input
                value={invite}
                onChange={(e) => setInvite(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="from whoever shared the app with you"
              />
            </label>
            <label className="agree-row">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>I’ve read the points above and I’m in.</span>
            </label>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={!valid || busy}>
          {busy ? 'Working…' : creating ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}

function SignedIn() {
  const { session, syncReady, pendingChanges, sync } = useAccount();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleReplace() {
    setBusy(true);
    setError(null);
    try {
      await confirmReplaceWithAccount();
      toast('This device now mirrors your account.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      toast('Account deleted. Your local data is untouched.');
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <>
      <section className="about-section">
        <h2>Sync</h2>
        <p className="fine-print">Signed in as {session?.username ?? ''}.</p>
        {!syncReady ? (
          <div className="conflict-panel" role="alert">
            <p className="fine-print">
              This account already has synced data, probably from another device. Joining the account{' '}
              <strong>replaces everything on this device</strong> with the account’s data. If this device has the
              better copy, sign out here and sign in from the other device first.
            </p>
            <div className="confirm-row">
              <button className="danger" onClick={() => void handleReplace()} disabled={busy}>
                {busy ? 'Replacing…' : 'Replace this device’s data'}
              </button>
              <button onClick={() => void signOut().then(() => toast('Signed out.'))} disabled={busy}>
                Sign out instead
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="fine-print">
              {sync.phase === 'syncing'
                ? 'Syncing…'
                : sync.phase === 'error'
                  ? `Sync problem: ${sync.message ?? 'unknown error'} Changes are kept and retried automatically.`
                  : pendingChanges > 0
                    ? navigator.onLine
                      ? `${pendingChanges} local ${pendingChanges === 1 ? 'change' : 'changes'} waiting to sync.`
                      : `Offline: ${pendingChanges} ${pendingChanges === 1 ? 'change' : 'changes'} will sync when you’re back online.`
                    : sync.lastSyncAt
                      ? `Everything is synced. Last synced ${fmtWhen(sync.lastSyncAt)}.`
                      : 'Everything is synced.'}
            </p>
            <div className="confirm-row">
              <button className="primary" onClick={() => void syncNow()} disabled={sync.phase === 'syncing'}>
                {sync.phase === 'syncing' ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            <p className="fine-print">
              Changes you make on any signed-in device sync automatically, even while offline; they catch up
              when you reconnect.
            </p>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="about-section">
        <h2>Community</h2>
        <p className="fine-print">
          Your tradelist and wishlist are shared with other users whenever they change.{' '}
          <Link to="/community">Browse everyone’s lists</Link> to find matches. Tap your picture (top right) any time
          to open your profile.
        </p>
      </section>

      <section className="about-section">
        <h2>Account</h2>
        <div className="confirm-row">
          <button onClick={() => void signOut().then(() => toast('Signed out.'))} disabled={busy}>
            Sign out on this device
          </button>
        </div>
        {confirmDelete ? (
          <div className="confirm-row">
            <button className="danger" onClick={() => void handleDelete()} disabled={busy}>
              Yes, delete my account and server data
            </button>
            <button onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        ) : (
          <button className="danger-outline" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete account…
          </button>
        )}
        <p className="fine-print">Deleting removes your synced data and shared lists from the server. Data on this device stays.</p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function PreferencesSection() {
  const goblinMode = useGoblinMode();
  return (
    <section className="about-section">
      <h2>Goblin mode</h2>
      <p className="fine-print">
        Adds a third way to view your collection: one big, unsorted pile. Shove cards around with your finger to dig
        through it, double-tap a card to flip it over, and press and hold one for its details. Sorting and filtering
        are for humans.
      </p>
      <label className="agree-row">
        <input type="checkbox" checked={goblinMode} onChange={(e) => void setGoblinMode(e.target.checked)} />
        <span>Enable goblin mode</span>
      </label>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Your data: transfer + local wipe
// ---------------------------------------------------------------------------

function DataSection({ signedIn }: { signedIn: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  async function handleDelete() {
    await deleteAllUserData();
    setConfirming(false);
    setDone(true);
  }

  return (
    <section className="about-section">
      <h2>Your data</h2>
      <p className="fine-print">
        Everything is stored on this device. The server only keeps a copy if you create an account and back up (the
        Account &amp; sync section above). Trades themselves always live on your device. Clearing your browser data
        will erase your collection, so export regularly or keep a backup.
      </p>
      <p className="fine-print">
        Moving to a new phone or browser? Transfer your collection, lists and decks with a one-time code. The data
        goes straight to the other device and is never stored on the server.
      </p>
      <DataTransfer />
      {done ? (
        <p role="status">All local data deleted.</p>
      ) : signedIn ? (
        <p className="fine-print">
          “Delete all my data” is disabled while signed in: this device syncs with your account, so a local wipe
          would quietly fall out of sync. Sign out first (Account &amp; sync above), or delete the whole account
          there instead.
        </p>
      ) : confirming ? (
        <div className="confirm-row">
          <button className="danger" onClick={handleDelete}>
            Yes, delete everything
          </button>
          <button onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : (
        <button className="danger-outline" onClick={() => setConfirming(true)}>
          Delete all my data
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Troubleshooting
// ---------------------------------------------------------------------------

function TroubleSection() {
  return (
    <section className="about-section">
      <h2>Having trouble?</h2>
      <p className="fine-print">
        If something breaks, copy the diagnostic log and send it along. It includes recent errors and your app/device
        version, but no card data.
      </p>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(formatDiagnostics());
        }}
      >
        Copy diagnostic log
      </button>
    </section>
  );
}
