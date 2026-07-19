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
import { EmptyState, Page } from './Page.js';

// Account & sync (opt-in). One combined agreement covers everything the
// feature does: your data syncs through the server between your devices, and
// your tradelist + wishlist are visible to other signed-in users.

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

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

export function Account() {
  const account = useAccount();

  if (!account.enabled) {
    return (
      <Page title="Account & sync">
        <EmptyState hint="Coming in a later update.">
          Accounts need a secure connection to the server, which isn’t configured for this build yet.
        </EmptyState>
      </Page>
    );
  }
  if (account.session === undefined) return <Page title="Account & sync">{null}</Page>;

  return account.session ? <SignedIn /> : <SignedOut />;
}

// ---------------------------------------------------------------------------
// Signed out: disclaimer + create/sign-in forms
// ---------------------------------------------------------------------------

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
    <Page
      title="Account & sync"
      subtitle="Optional: keep your collection in sync across your devices and share your trade and wishlists with other users."
    >
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
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Signed in: sync status, sign out, delete
// ---------------------------------------------------------------------------

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
    <Page title="Account & sync" subtitle={`Signed in as ${session?.username ?? ''}.`}>
      <section className="about-section">
        <h2>Sync</h2>
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
          <Link to="/community">Browse everyone’s lists</Link> to find matches.
        </p>
        <p className="fine-print">
          <Link to={`/profile/${encodeURIComponent(session?.username ?? '')}`}>Your profile</Link> is what others see
          when they tap your picture: pick a card art as your profile picture and show off three favorite cards and
          decks.
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
    </Page>
  );
}
