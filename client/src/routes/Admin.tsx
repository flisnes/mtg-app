import { Fragment, useState, type ReactNode } from 'react';
import type { AdminJobName, AdminJobStatus, AdminUserRow } from '@mtg/shared';
import { ApiError, adminDeleteUser, adminOverview, adminRevokeTokens, adminRunJob, apiErrorText } from '../account/api.js';
import type { AccountSession } from '../account/session.js';
import { useApiQuery } from '../account/useApiQuery.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { Icon } from '../components/icons.js';
import { MenuRow } from '../components/MenuRow.js';
import { RequireAccount } from '../components/RequireAccount.js';
import { Sheet } from '../components/Sheet.js';
import { useToast } from '../components/Toast.js';
import { fmtBytes } from '../util/imageCache.js';
import { fmtCount, fmtDate, fmtDateTime, fmtIsoDate, plural } from '../util/format.js';
import { EmptyState, Page } from './Page.js';

// The operator's view of the server: accounts, what is live on the relay, and
// whether the price archive is keeping up. Everything here is metadata the
// server already holds (counts, sizes, timestamps); synced rows stay opaque.
// Reached from Settings, and only for the account(s) the server names admin.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. */
function fmtAgo(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.round(d / MIN)} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`;
  if (d < 14 * DAY) return `${Math.round(d / DAY)} d ago`;
  return fmtDate(ts);
}

/** "3 d 4 h" style uptime. */
function fmtDuration(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const mins = Math.floor((ms % HOUR) / MIN);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${mins} min`;
  return `${mins} min`;
}

/** Whole days between an archive day (YYYY-MM-DD, UTC) and now; null when never archived. */
function daysBehind(lastDay: string, now: number): number | null {
  const ts = Date.parse(`${lastDay}T00:00:00Z`);
  if (Number.isNaN(ts)) return null;
  return Math.floor((now - ts) / DAY);
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="about-section admin-section">
      <h2>{title}</h2>
      {children}
      {actions && <div className="confirm-row admin-actions">{actions}</div>}
    </section>
  );
}

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function jobLine(job: AdminJobStatus, now: number): ReactNode {
  if (job.running) return 'running now';
  if (job.lastRunAt === null) return 'not run since boot';
  const when = fmtAgo(job.lastRunAt, now);
  if (job.lastError) {
    return (
      <span className="admin-bad">
        failed {when}: {job.lastError}
      </span>
    );
  }
  return `${job.lastResult ?? 'ok'}, ${when}`;
}

export function Admin() {
  return (
    <RequireAccount title="Server admin" signedOutText="Sign in with the operator account to see the server.">
      {(session) => <AdminPanel session={session} />}
    </RequireAccount>
  );
}

function AdminPanel({ session }: { session: AccountSession }) {
  const toast = useToast();
  const { confirm, sheet: confirmSheet } = useConfirm();
  // Bumped to refetch after an action, and by the Refresh button.
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [openUser, setOpenUser] = useState<string | null>(null);
  const { data, error, setData } = useApiQuery(
    () =>
      adminOverview(session.token).catch((err) => {
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        throw err;
      }),
    [session.token, tick],
    { fallback: 'Could not load the server overview.' },
  );
  const refresh = () => setTick((t) => t + 1);

  async function act(label: string, run: () => Promise<string>) {
    setBusy(label);
    try {
      toast(await run());
      refresh();
    } catch (err) {
      toast(apiErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  const runJob = (job: AdminJobName, label: string) =>
    act(job, async () => {
      const res = await adminRunJob(session.token, job);
      return `${label}: ${res.result}.`;
    });

  async function revoke(user: AdminUserRow) {
    const ok = await confirm({
      title: `Sign ${user.username} out everywhere?`,
      body: `Every device signed in as ${user.username} has to sign in again. Their data is untouched.`,
      confirmLabel: 'Sign out everywhere',
    });
    if (!ok) return;
    await act('revoke', async () => {
      const res = await adminRevokeTokens(session.token, user.username);
      return `${user.username}: ${res.revoked} ${plural(res.revoked, 'session')} revoked.`;
    });
  }

  async function remove(user: AdminUserRow) {
    const ok = await confirm({
      title: `Delete ${user.username}'s account?`,
      body: 'Their synced data and shared lists are removed from the server. Whatever is on their devices stays there. This cannot be undone.',
      confirmLabel: 'Delete account',
      danger: true,
    });
    if (!ok) return;
    setOpenUser(null);
    await act('delete', async () => {
      await adminDeleteUser(session.token, user.username);
      setData((d) => (d ? { ...d, accounts: { ...d.accounts, users: d.accounts.users.filter((u) => u.username !== user.username) } } : d));
      return `${user.username} deleted.`;
    });
  }

  if (forbidden) {
    return (
      <Page title="Server admin">
        <EmptyState>This account is not an admin. Nothing to see here, move along.</EmptyState>
      </Page>
    );
  }

  const menu = (
    <button className="ghost icon-only" onClick={refresh} disabled={!data && !error} aria-label="Refresh" title="Refresh">
      <Icon name="refresh" />
    </button>
  );

  if (!data) {
    return (
      <Page title="Server admin" menu={menu}>
        {error ? <EmptyState>{error}</EmptyState> : null}
      </Page>
    );
  }

  const now = data.server.now;
  const behind = daysBehind(data.archive.lastDay, now);
  const sessionStates = Object.entries(data.live.sessions);
  const sessionsOpen = sessionStates.reduce((n, [, c]) => n + c, 0);
  const selected = openUser ? data.accounts.users.find((u) => u.username === openUser) : undefined;

  return (
    <Page title="Server admin" subtitle={`As of ${fmtDateTime(now)}.`} menu={menu}>
      <Section title="Server">
        <Kv
          rows={[
            ['Up for', fmtDuration(now - data.server.startedAt)],
            ['Node', data.server.nodeVersion],
            ['Memory', `${fmtBytes(data.server.rssBytes)} resident · ${fmtBytes(data.server.heapUsedBytes)} heap`],
            ['Accounts DB', fmtBytes(data.server.accountsDbBytes)],
            ['Prices DB', fmtBytes(data.server.pricesDbBytes)],
            ['Registration', data.server.registrationOpen ? 'open (invite code set)' : 'closed'],
            ['Admins', data.server.admins.join(', ')],
          ]}
        />
      </Section>

      <Section title="Accounts">
        <Kv
          rows={[
            ['Total', fmtCount(data.accounts.total)],
            ['Active last 7 days', fmtCount(data.accounts.activeLast7d)],
            ['New last 7 / 30 days', `${fmtCount(data.accounts.newLast7d)} / ${fmtCount(data.accounts.newLast30d)}`],
          ]}
        />
        <ul className="menu-list">
          {data.accounts.users.map((u) => (
            <li key={u.username}>
              <MenuRow
                onClick={() => setOpenUser(u.username)}
                label={
                  <>
                    {u.username}
                    {u.admin && <span className="badge admin-badge">admin</span>}
                  </>
                }
                note={[
                  u.lastSeen === null ? 'signed out everywhere' : `seen ${fmtAgo(u.lastSeen, now)}`,
                  `${fmtCount(u.devices)} ${plural(u.devices, 'device')}`,
                  `${fmtCount(u.rows)} rows · ${fmtBytes(u.bytes)}`,
                  `T ${fmtCount(u.tradelistCount)} · W ${fmtCount(u.wishlistCount)}`,
                ].join(' · ')}
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Live">
        <Kv
          rows={[
            [
              'Trade sessions',
              sessionsOpen === 0
                ? 'none open'
                : sessionStates.map(([state, n]) => `${fmtCount(n)} ${state.replace('_', ' ')}`).join(' · '),
            ],
            ['Device transfers', fmtCount(data.live.transfers)],
            [
              'Sync listeners',
              `${fmtCount(data.live.syncSubscribers.sockets)} ${plural(data.live.syncSubscribers.sockets, 'device')} across ${fmtCount(data.live.syncSubscribers.users)} ${plural(data.live.syncSubscribers.users, 'account')}`,
            ],
            [
              'Since boot',
              Object.entries(data.live.counters)
                .map(([k, v]) => `${fmtCount(v)} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
                .join(' · '),
            ],
          ]}
        />
      </Section>

      <Section
        title="Price archive"
        actions={
          <>
            <button onClick={() => void runJob('archive', 'Archive')} disabled={busy !== null}>
              {busy === 'archive' ? 'Running…' : 'Archive now'}
            </button>
            <button onClick={() => void runJob('monthly', 'Monthly import')} disabled={busy !== null}>
              {busy === 'monthly' ? 'Running…' : 'Import monthly file'}
            </button>
          </>
        }
      >
        <Kv
          rows={[
            [
              'Last day',
              data.archive.lastDay ? (
                <>
                  {fmtIsoDate(data.archive.lastDay)}
                  {behind !== null && behind > 1 && <span className="admin-bad"> · {behind} days behind</span>}
                </>
              ) : (
                'never'
              ),
            ],
            ['Printings', fmtCount(data.archive.printings)],
            ['Daily job', jobLine(data.archive.job, now)],
            [
              'Monthly history',
              data.archive.monthly.imported
                ? `${fmtCount(data.archive.monthly.printings)} printings`
                : 'no file imported',
            ],
            ['Monthly job', jobLine(data.archive.monthly.job, now)],
            [
              'Backfill',
              data.archive.backfill.done
                ? `done (${data.archive.backfill.done}, ${data.archive.backfill.attempts} ${plural(data.archive.backfill.attempts, 'run')})`
                : data.archive.backfill.attempts > 0
                  ? `not done after ${data.archive.backfill.attempts} ${plural(data.archive.backfill.attempts, 'run')}`
                  : 'not started',
            ],
          ]}
        />
      </Section>

      {selected && (
        <Sheet onClose={() => setOpenUser(null)} title={selected.username}>
          <Kv
            rows={[
              ['Joined', fmtDateTime(selected.createdAt)],
              ['Last seen', selected.lastSeen === null ? 'signed out everywhere' : fmtDateTime(selected.lastSeen)],
              ['Signed-in sessions', fmtCount(selected.tokens)],
              ['Devices synced', fmtCount(selected.devices)],
              ['Synced rows', `${fmtCount(selected.rows)} · ${fmtBytes(selected.bytes)}`],
              ['Change feed', `seq ${fmtCount(selected.seq)}`],
              [
                'Published lists',
                selected.listsUpdatedAt === null
                  ? 'none'
                  : `${fmtCount(selected.tradelistCount)} for trade · ${fmtCount(selected.wishlistCount)} wanted · ${fmtAgo(selected.listsUpdatedAt, now)}`,
              ],
            ]}
          />
          <div className="sheet-actions">
            <button onClick={() => void revoke(selected)} disabled={busy !== null}>
              Sign out everywhere
            </button>
            <button
              className="danger"
              onClick={() => void remove(selected)}
              disabled={busy !== null || selected.username.toLowerCase() === session.username.toLowerCase()}
            >
              Delete account
            </button>
          </div>
        </Sheet>
      )}
      {confirmSheet}
    </Page>
  );
}
