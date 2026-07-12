import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { MIN_PASSWORD_CHARS, USERNAME_RE, type SnapshotCounts } from '@mtg/shared';
import { ApiError } from '../account/api.js';
import {
  applyBackup,
  backupNow,
  deleteAccount,
  fetchBackup,
  signIn,
  signOut,
  signUp,
  type FetchedBackup,
} from '../account/session.js';
import { useAccount } from '../account/useAccount.js';
import { setSetting } from '../db/settings.js';
import { KEY_AUTO_BACKUP } from '../account/session.js';
import { useToast } from '../components/Toast.js';
import { EmptyState, Page } from './Page.js';

// Account & sync (opt-in). One combined agreement covers everything the
// feature does: the server keeps a copy of your data, and your tradelist +
// wishlist are visible to other signed-in users.

function fmtWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtCounts(c: SnapshotCounts): string {
  return `${c.cards.toLocaleString()} cards · ${c.decks} decks · ${c.wishlist} wishes`;
}

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.friendlyMessage;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const DISCLAIMER = (
  <div className="account-disclaimer">
    <p className="fine-print">Creating an account is optional — the app works fully without one. By creating one you agree to all of this:</p>
    <ul className="fine-print">
      <li>
        Your collection, lists and decks are stored on a <strong>small hobby server</strong>. It is run with care
        but with no uptime or durability promises — it could go away or lose data at any time. Keep making local
        exports of anything you can’t afford to lose.
      </li>
      <li>
        Your <strong>tradelist and wishlist are visible to every other signed-in user</strong> (that’s the point —
        so you can find trades). Your collection, decks and prices stay private.
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
        toast('Account created — back up your data below.');
      } else {
        await signIn(username.trim(), password);
        toast(`Signed in as ${username.trim()}.`);
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
      subtitle="Optional: back up your collection to the server, use it from another device, and share your trade and wishlists with other users."
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
// Signed in: backup status, back up / restore, sign out, delete
// ---------------------------------------------------------------------------

type RestoreState =
  | { step: 'idle' }
  | { step: 'fetching' }
  | { step: 'review'; backup: FetchedBackup }
  | { step: 'applying' };

function SignedIn() {
  const { session, lastBackup, conflict, autoBackup } = useAccount();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<RestoreState>({ step: 'idle' });
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleBackup(overwriteVersion?: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await backupNow(overwriteVersion);
      toast(`Backed up ${fmtCounts(res.counts)}.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(null); // the conflict panel takes over
      } else {
        setError(errText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleFetchRestore() {
    setRestore({ step: 'fetching' });
    setError(null);
    try {
      setRestore({ step: 'review', backup: await fetchBackup() });
    } catch (err) {
      setRestore({ step: 'idle' });
      setError(err instanceof ApiError && err.status === 404 ? 'No backup stored yet — back up first.' : errText(err));
    }
  }

  async function handleApplyRestore() {
    if (restore.step !== 'review') return;
    setRestore({ step: 'applying' });
    try {
      await applyBackup(restore.backup);
      setRestore({ step: 'idle' });
      toast('Backup restored on this device.');
    } catch (err) {
      setRestore({ step: 'idle' });
      setError(errText(err));
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
        <h2>Backup</h2>
        {lastBackup ? (
          <p className="fine-print">
            Last backed up from this device {fmtWhen(lastBackup.at)} — {fmtCounts(lastBackup.counts)}.
          </p>
        ) : (
          <p className="fine-print">Nothing backed up from this device yet.</p>
        )}

        {conflict && (
          <div className="conflict-panel" role="alert">
            <p className="fine-print">
              The server has a backup this device hasn’t seen (saved {fmtWhen(conflict.updatedAt)} — probably from
              another device). Restore it here, or overwrite it with this device’s data.
            </p>
            <div className="confirm-row">
              <button onClick={handleFetchRestore} disabled={busy || restore.step !== 'idle'}>
                Review &amp; restore it
              </button>
              <button className="danger-outline" onClick={() => void handleBackup(conflict.version)} disabled={busy}>
                Overwrite with this device
              </button>
            </div>
          </div>
        )}

        {restore.step === 'review' ? (
          <div className="conflict-panel">
            <p className="fine-print">
              Server backup from {fmtWhen(restore.backup.updatedAt)}: {fmtCounts(restore.backup.counts)}. Restoring{' '}
              <strong>replaces everything on this device</strong> with it.
            </p>
            <div className="confirm-row">
              <button className="danger" onClick={handleApplyRestore}>
                Replace this device’s data
              </button>
              <button onClick={() => setRestore({ step: 'idle' })}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="confirm-row">
            <button className="primary" onClick={() => void handleBackup()} disabled={busy || restore.step !== 'idle'}>
              {busy ? 'Backing up…' : 'Back up now'}
            </button>
            {!conflict && (
              <button onClick={handleFetchRestore} disabled={busy || restore.step !== 'idle'}>
                {restore.step === 'fetching' ? 'Fetching…' : restore.step === 'applying' ? 'Restoring…' : 'Restore…'}
              </button>
            )}
          </div>
        )}

        <label className="agree-row">
          <input
            type="checkbox"
            checked={autoBackup}
            onChange={(e) => void setSetting(KEY_AUTO_BACKUP, e.target.checked)}
          />
          <span>Back up automatically when I open the app</span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="about-section">
        <h2>Community</h2>
        <p className="fine-print">
          Your tradelist and wishlist are shared with other users every time you back up.{' '}
          <Link to="/community">Browse everyone’s lists</Link> to find matches.
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
        <p className="fine-print">Deleting removes your backup and shared lists from the server. Data on this device stays.</p>
      </section>
    </Page>
  );
}
