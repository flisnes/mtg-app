import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MIN_PASSWORD_CHARS, USERNAME_RE } from '@mtg/shared';
import { apiErrorText, me } from '../account/api.js';
import {
  confirmReplaceWithAccount,
  deleteAccount,
  signIn,
  signOut,
  signUp,
  type AccountSession,
} from '../account/session.js';
import { useAccount } from '../account/useAccount.js';
import { useApiQuery } from '../account/useApiQuery.js';
import { MenuRow } from '../components/MenuRow.js';
import { syncNow } from '../sync/engine.js';
import { getAgentStatusSnapshot, subscribeAgentStatus, type AgentStatus } from '../agent/status.js';
import { useToast } from '../components/Toast.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { DataTransfer } from '../components/DataTransfer.js';
import { deleteAllUserData } from '../db/dataAccess.js';
import { setGoblinMode, useGoblinMode } from '../components/useGoblinMode.js';
import { formatDiagnostics } from '../errorLog.js';
import { Page } from './Page.js';
import { fmtCount, fmtDateTime as fmtWhen, fmtIsoDate, plural } from '../util/format.js';
import { setPrefs, type FilingPolicy, type PrintingPref, type UpdatePolicy } from '../prefs.js';
import { LANGS, langName } from '@mtg/shared';
import { LangFlag } from '../components/LangFlag.js';
import { usePrefs } from '../usePrefs.js';
import { CURRENCIES, ensureRates, rateSummary } from '../price/rates.js';
import {
  clampImageCacheLimit,
  enforceImageCacheLimit,
  fmtBytes,
  IMAGE_CACHE_CEILING,
  IMAGE_CACHE_MIN,
  IMAGE_CACHE_STEP,
  imageCacheStats,
  projectImageCacheBytes,
  pruneImageCache,
  type ImageCacheStats,
} from '../util/imageCache.js';
import {
  checkCardDataNow,
  checkPricesNow,
  checkScanDataNow,
  type CheckOutcome,
} from '../cardDb/manualCheck.js';

// One home for everything management-y: your account (auth + sync), your data
// (transfer/backup), and preferences. Purely informational bits (version,
// attribution) live on the About page instead.

// ---------------------------------------------------------------------------
// The building blocks every section is made of
// ---------------------------------------------------------------------------

function PrefSection({
  id,
  title,
  blurb,
  children,
}: {
  /** Target for the index at the top of the page. */
  id?: SectionId;
  title: string;
  blurb?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="about-section" id={id ? `settings-${id}` : undefined}>
      <h2>{title}</h2>
      {blurb && <p className="fine-print">{blurb}</p>}
      {children}
    </section>
  );
}

interface PrefOption<V extends string> {
  value: V;
  label: string;
  /** Shown under the dropdown while this option is picked. */
  hint?: string;
}

function PrefSelect<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: ReactNode;
  value: V;
  options: readonly PrefOption<V>[];
  onChange: (v: V) => void;
}) {
  const hint = options.find((o) => o.value === value)?.hint;
  return (
    <>
      <label className="field">
        {label}
        <select value={value} onChange={(e) => onChange(e.target.value as V)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {hint && <p className="fine-print">{hint}</p>}
    </>
  );
}

function PrefToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="agree-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// The agent bridge needs a Claude Code session on the same computer, so a
// phone has no use for the section. Still shown if it's somehow switched on,
// so it can be switched off again.
const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

const SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'prices', label: 'Prices' },
  { id: 'language', label: 'Language' },
  { id: 'printings', label: 'Printings' },
  { id: 'filing', label: 'Filing' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'images', label: 'Images' },
  { id: 'agent', label: 'Agent' },
  { id: 'goblin', label: 'Goblin mode' },
  { id: 'data', label: 'Your data' },
  { id: 'trouble', label: 'Trouble' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

/** Settings runs five screens long on a phone: a row of jump links up top. */
function SectionIndex() {
  const { agentBridge } = usePrefs();
  const shown = SECTIONS.filter((s) => s.id !== 'agent' || !IS_TOUCH || agentBridge);
  return (
    <nav className="settings-index chips" aria-label="Jump to section">
      {shown.map((s) => (
        <button
          key={s.id}
          className="chip"
          onClick={() => document.getElementById(`settings-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {s.label}
        </button>
      ))}
    </nav>
  );
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
      <SectionIndex />
      <AccountSection />
      <CurrencySection />
      <LanguageSection />
      <PrintingSection />
      <FilingSection />
      <DownloadsSection />
      <ImageCacheSection />
      <AgentSection />
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
      <PrefSection
        id="account"
        title="Account & sync"
        blurb="Accounts (to sync across devices and share trade lists) need a secure connection to the server, which isn’t configured for this build yet. Coming in a later update."
      />
    );
  }
  if (account.session === undefined) return <PrefSection id="account" title="Account & sync" />;
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
      setError(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PrefSection
      id="account"
      title="Account & sync"
      blurb="Optional: keep your collection in sync across your devices and share your trade and wishlists with other users."
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
    </PrefSection>
  );
}

/**
 * The way into the server admin panel, shown only to the account(s) the server
 * names admin. One /api/me per visit to Settings; a failed or offline check
 * simply shows nothing, the panel itself gates again.
 */
function AdminLink({ session }: { session: AccountSession }) {
  const { data } = useApiQuery(() => me(session.token), [session.token], { fallback: '' });
  if (!data?.admin) return null;
  return (
    <ul className="menu-list">
      <li>
        <MenuRow to="/admin" icon="shield" label="Server admin" note="Accounts, live sessions, price archive" />
      </li>
    </ul>
  );
}

function SignedIn() {
  const { session, syncReady, pendingChanges, sync } = useAccount();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, sheet: confirmSheet } = useConfirm();

  async function handleReplace() {
    setBusy(true);
    setError(null);
    try {
      await confirmReplaceWithAccount();
      toast('This device now mirrors your account.');
    } catch (err) {
      setError(apiErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete your account?',
      body: 'Your synced data and shared lists are removed from the server. Data on this device stays.',
      confirmLabel: 'Delete account',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
      toast('Account deleted. Your local data is untouched.');
    } catch (err) {
      setError(apiErrorText(err));
      setBusy(false);
    }
  }

  return (
    <>
      <PrefSection id="account" title="Sync" blurb={`Signed in as ${session?.username ?? ''}.`}>
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
                      ? `${pendingChanges} local ${plural(pendingChanges, 'change')} waiting to sync.`
                      : `Offline: ${pendingChanges} ${plural(pendingChanges, 'change')} will sync when you’re back online.`
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
      </PrefSection>

      <PrefSection
        title="Community"
        blurb={
          <>
            Your tradelist and wishlist are shared with other users whenever they change.{' '}
            <Link to="/community">Browse everyone’s lists</Link> to find matches. Tap your picture (top right) any
            time to open your profile.
          </>
        }
      />

      <PrefSection title="Account">
        {session && <AdminLink session={session} />}
        <div className="confirm-row">
          <button onClick={() => void signOut().then(() => toast('Signed out.'))} disabled={busy}>
            Sign out on this device
          </button>
        </div>
        <button className="danger-outline" onClick={() => void handleDelete()} disabled={busy}>
          Delete account…
        </button>
        <p className="fine-print">Deleting removes your synced data and shared lists from the server. Data on this device stays.</p>
      </PrefSection>
      {confirmSheet}
    </>
  );
}

// ---------------------------------------------------------------------------
// Prices & currency
// ---------------------------------------------------------------------------

const CURRENCY_OPTIONS: PrefOption<string>[] = CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }));

function CurrencySection() {
  const { displayCurrency, baseCurrency, gridPrices } = usePrefs();
  const [checking, setChecking] = useState(false);
  const rate = rateSummary();
  const converting = displayCurrency !== baseCurrency;

  // Switching either currency may need a rate we haven't fetched yet.
  const change = (patch: Partial<{ displayCurrency: string; baseCurrency: 'EUR' | 'USD' }>) => {
    setPrefs(patch);
    setChecking(true);
    void ensureRates().finally(() => setChecking(false));
  };

  return (
    <PrefSection
      id="prices"
      title="Prices & currency"
      blurb="Card prices come from Scryfall in euros and US dollars. Pick any other currency and the app converts them for display; what gets recorded in your history never changes."
    >
      <PrefSelect
        label="Show prices in"
        value={displayCurrency}
        options={CURRENCY_OPTIONS}
        onChange={(displayCurrency) => change({ displayCurrency })}
      />

      <p className="fine-print">Base prices (what conversions start from, and what shows if a rate isn’t available):</p>
      <div className="seg-row" role="radiogroup" aria-label="Base currency">
        {(['EUR', 'USD'] as const).map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={baseCurrency === c}
            className={baseCurrency === c ? 'seg seg-active' : 'seg'}
            onClick={() => change({ baseCurrency: c })}
          >
            {c === 'EUR' ? '€ Euro' : '$ US dollar'}
          </button>
        ))}
      </div>

      {converting && (
        <p className="fine-print">
          {checking
            ? 'Fetching today’s rate…'
            : rate
              ? `${rate.text} · European Central Bank reference rate via Frankfurter, ${fmtIsoDate(rate.date)}.`
              : `No exchange rate available yet, so prices are showing in ${baseCurrency}. Rates are fetched once a day and need a connection.`}
        </p>
      )}

      <PrefToggle checked={gridPrices} onChange={(gridPrices) => setPrefs({ gridPrices })}>
        Show prices on grid tiles
      </PrefToggle>
      <p className="fine-print">
        Grid view shows the art alone. With this on, each tile gets a small price in its corner, next to the copy count,
        for a quick look at the trade table.
      </p>
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Language: which one your cards are expected to be in
// ---------------------------------------------------------------------------

const LANG_OPTIONS: PrefOption<string>[] = LANGS.map((l) => ({ value: l, label: langName(l) }));

function LanguageSection() {
  const { preferredLang } = usePrefs();

  return (
    <PrefSection
      id="language"
      title="Language"
      blurb="The language you collect in. Any card in a different one gets a small flag next to its badges, wherever it shows up: your collection, a binder page, or the pile your trade partner just pushed across the table."
    >
      <PrefSelect
        label="I collect in"
        value={preferredLang}
        options={LANG_OPTIONS}
        onChange={(preferredLang) => setPrefs({ preferredLang })}
      />
      <p className="fine-print lang-pref-sample">
        No flag on {langName(preferredLang)} cards. Everything else looks like this:{' '}
        {LANGS.filter((l) => l !== preferredLang).map((l) => (
          <span key={l} className="badge badge-lang" title={langName(l)}>
            <LangFlag lang={l} size={11} />
          </span>
        ))}
      </p>
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Card printings
// ---------------------------------------------------------------------------

const PRINTING_OPTIONS: PrefOption<PrintingPref>[] = [
  { value: 'latest', label: 'Newest printing', hint: 'The most recent edition of the card. This is the default.' },
  {
    value: 'latestNonPromo',
    label: 'Newest normal printing',
    hint: 'The most recent plain version: no promos, prerelease stamps or Secret Lairs, and none of the borderless, showcase, extended-art, retro-frame or special-foil variants a set prints alongside it.',
  },
  {
    value: 'first',
    label: 'First printing',
    hint: 'The oldest plain version: the card as it originally appeared, skipping the same promos and variants.',
  },
  { value: 'cheapest', label: 'Cheapest printing', hint: 'The least expensive edition with a known price.' },
];

function PrintingSection() {
  const { printing, preferOwnedPrinting } = usePrefs();

  return (
    <PrefSection
      id="printings"
      title="Card printings"
      blurb="Which edition a card shows as in search results, and which one gets recorded when you add it without picking one yourself. Cards already in your collection, decks and boxes keep the printing they were filed under."
    >
      <PrefSelect
        label="Show cards as their"
        value={printing}
        options={PRINTING_OPTIONS}
        onChange={(printing) => setPrefs({ printing })}
      />
      <PrefToggle checked={preferOwnedPrinting} onChange={(preferOwnedPrinting) => setPrefs({ preferOwnedPrinting })}>
        Prefer a printing I already own, when I own one
      </PrefToggle>
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Filing: what happens to a card that's already filed somewhere
// ---------------------------------------------------------------------------

const FILING_OPTIONS: PrefOption<FilingPolicy>[] = [
  {
    value: 'ask',
    label: 'Ask me each time',
    hint: 'You get the list of cards in the way and choose move or both, once per batch.',
  },
  {
    value: 'move',
    label: 'Move it to the new place',
    hint: 'What actually happens when you pick a card up: it leaves the deck, binder or box it was in.',
  },
  {
    value: 'copy',
    label: 'File it in both places',
    hint: 'Keeps every filing. Useful for brewing two decks around one card. The card will show up as double-filed until you sort it out.',
  },
];

function FilingSection() {
  const { filingPolicy } = usePrefs();

  return (
    <PrefSection
      id="filing"
      title="Filing"
      blurb="A card can only be in one place at a time. When you file a copy you’ve already put in a deck, binder or box, this decides what happens to the old spot."
    >
      <PrefSelect
        label="Already filed elsewhere"
        value={filingPolicy}
        options={FILING_OPTIONS}
        onChange={(filingPolicy) => setPrefs({ filingPolicy })}
      />
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Agent connections: let a local Claude Code session drive this tab
// ---------------------------------------------------------------------------

const AGENT_STATUS_TEXT: Record<AgentStatus, string> = {
  off: 'Off.',
  waiting: 'Looking for the bridge. Start a Claude Code session in the app repo and it will appear.',
  connected: 'Connected. The agent can see this tab.',
  replaced: 'Another tab took over the connection. Toggle this off and on to reclaim it.',
};

function AgentSection() {
  const { agentBridge, agentWrites } = usePrefs();
  const status = useSyncExternalStore(subscribeAgentStatus, getAgentStatusSnapshot);
  if (IS_TOUCH && !agentBridge) return null;

  return (
    <PrefSection
      id="agent"
      title="Agent connections"
      blurb="Lets a Claude Code session on this computer work with your collection and decks through this tab. Desktop only, local only: the connection never leaves your machine, and nothing is shared until you turn it on."
    >
      <PrefToggle checked={agentBridge} onChange={(agentBridge) => setPrefs({ agentBridge })}>
        Enable agent connections
      </PrefToggle>

      {agentBridge && (
        <>
          <PrefToggle checked={agentWrites} onChange={(agentWrites) => setPrefs({ agentWrites })}>
            Allow changes (adding cards, editing lists). Off = read only.
          </PrefToggle>
          <p className="fine-print">{AGENT_STATUS_TEXT[status]}</p>
        </>
      )}
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Automatic downloads
// ---------------------------------------------------------------------------

const POLICY_OPTIONS: PrefOption<UpdatePolicy>[] = [
  { value: 'ask', label: 'Ask me first' },
  { value: 'always', label: 'Download automatically' },
  { value: 'never', label: 'Never download' },
];

function DownloadsSection() {
  const prefs = usePrefs();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const runCheck = async (key: string, fn: () => Promise<CheckOutcome>) => {
    setBusy(key);
    try {
      toast((await fn()).message);
    } finally {
      setBusy(null);
    }
  };

  const feeds: {
    key: string;
    title: string;
    blurb: string;
    policy: UpdatePolicy;
    set: (p: UpdatePolicy) => void;
    check: () => Promise<CheckOutcome>;
  }[] = [
    {
      key: 'prices',
      title: 'Card prices',
      blurb: 'Refreshed daily, around 3 MB each time. Without it, prices and collection values slowly go stale.',
      policy: prefs.pricesPolicy,
      set: (pricesPolicy) => setPrefs({ pricesPolicy }),
      check: checkPricesNow,
    },
    {
      key: 'cardDb',
      title: 'Card database',
      blurb:
        'New sets, corrected card text and the sealed-product list. Only the parts that changed download, so it is usually small, but a big change (or a first install) runs to about 14 MB.',
      policy: prefs.cardDbPolicy,
      set: (cardDbPolicy) => setPrefs({ cardDbPolicy }),
      check: checkCardDataNow,
    },
    {
      key: 'scanData',
      title: 'Card scanning data',
      blurb:
        'The card-art index the camera scanner matches against, about 4 MB. Newer versions recognise newer cards; the copy you have keeps working either way.',
      policy: prefs.scanDataPolicy,
      set: (scanDataPolicy) => setPrefs({ scanDataPolicy }),
      check: checkScanDataNow,
    },
  ];

  return (
    <PrefSection
      id="downloads"
      title="Automatic downloads"
      blurb="Nothing downloads without your say-so. Each of these asks the first time it has something new, and “don’t ask again” on that prompt lands here, where you can change your mind, or fetch an update on demand."
    >
      {feeds.map((f) => (
        <div key={f.key} className="download-feed">
          <PrefSelect label={f.title} value={f.policy} options={POLICY_OPTIONS} onChange={f.set} />
          <p className="fine-print">{f.blurb}</p>
          <button onClick={() => void runCheck(f.key, f.check)} disabled={busy !== null}>
            {busy === f.key ? 'Checking…' : 'Check now'}
          </button>
        </div>
      ))}
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Card images: how many of Scryfall's pictures this device keeps
// ---------------------------------------------------------------------------

function ImageCacheSection() {
  const { imageCacheLimit } = usePrefs();
  const [text, setText] = useState(String(imageCacheLimit));
  const [stats, setStats] = useState<ImageCacheStats | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Enforce before counting: boot upkeep may still be trimming, and a stale
  // "images cached right now" is exactly the number people would check here.
  useEffect(() => {
    void enforceImageCacheLimit().then(() => imageCacheStats().then(setStats));
  }, []);

  // The number box is free-typed, so the slider and the estimate read a
  // clamped value; an empty or nonsense box just means "unchanged".
  const typed = Number(text);
  const value = clampImageCacheLimit(text.trim() && Number.isFinite(typed) ? typed : imageCacheLimit);
  const dirty = value !== imageCacheLimit;

  async function save() {
    setBusy(true);
    try {
      setText(String(value));
      setPrefs({ imageCacheLimit: value });
      const pruned = await pruneImageCache(value);
      setStats(await imageCacheStats());
      toast(
        pruned
          ? `Keeping ${fmtCount(value)} images. Sent ${fmtCount(pruned)} of the oldest to the graveyard.`
          : `Keeping ${fmtCount(value)} images.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PrefSection
      id="images"
      title="Card images"
      blurb="Card pictures are fetched from Scryfall as you browse and kept on this device, so they appear instantly next time and still show up offline. A bigger cache spends less of your data plan; a smaller one leaves more room on the phone. When it is full the oldest images are dropped first, and any card you look at fetches its picture again."
    >
      <label className="field" htmlFor="image-cache-limit">
        Images to keep cached
      </label>
      <div className="image-budget-row">
        <input
          id="image-cache-limit"
          type="range"
          min={IMAGE_CACHE_MIN}
          max={IMAGE_CACHE_CEILING}
          step={IMAGE_CACHE_STEP}
          value={value}
          onChange={(e) => setText(e.target.value)}
        />
        <input
          className="image-budget-number"
          type="number"
          inputMode="numeric"
          min={IMAGE_CACHE_MIN}
          max={IMAGE_CACHE_CEILING}
          step={IMAGE_CACHE_STEP}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setText(String(value))}
          aria-label="Images to keep cached"
        />
      </div>
      <p className="fine-print image-budget-estimate">
        About {fmtBytes(projectImageCacheBytes(value, stats))} of storage when full.
        {stats
          ? ` ${fmtCount(stats.count)} images cached right now, about ${fmtBytes(stats.bytes)}.`
          : ''}
      </p>
      <button className="primary" onClick={() => void save()} disabled={busy || !dirty}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function PreferencesSection() {
  const goblinMode = useGoblinMode();
  return (
    <PrefSection id="goblin" title="Goblin mode" blurb="Just like Richard Garfield intended.">
      <PrefToggle checked={goblinMode} onChange={(on) => void setGoblinMode(on)}>
        Enable goblin mode
      </PrefToggle>
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Your data: transfer + local wipe
// ---------------------------------------------------------------------------

function DataSection({ signedIn }: { signedIn: boolean }) {
  const [done, setDone] = useState(false);
  const { confirm, sheet: confirmSheet } = useConfirm();

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete all your data?',
      body: 'Your collection, lists, decks and history on this device are erased. There is no undo, so export first if you might want them back.',
      confirmLabel: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    await deleteAllUserData();
    setDone(true);
  }

  return (
    <PrefSection
      id="data"
      title="Your data"
      blurb="Everything is stored on this device. The server only keeps a copy if you create an account and back up (the Account & sync section above). Trades themselves always live on your device. Clearing your browser data will erase your collection, so export regularly or keep a backup."
    >
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
      ) : (
        <button className="danger-outline" onClick={() => void handleDelete()}>
          Delete all my data
        </button>
      )}
      {confirmSheet}
    </PrefSection>
  );
}

// ---------------------------------------------------------------------------
// Troubleshooting
// ---------------------------------------------------------------------------

function TroubleSection() {
  return (
    <PrefSection
      id="trouble"
      title="Having trouble?"
      blurb="If something breaks, copy the diagnostic log and send it along. It includes recent errors and your app/device version, but no card data."
    >
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(formatDiagnostics());
        }}
      >
        Copy diagnostic log
      </button>
    </PrefSection>
  );
}
