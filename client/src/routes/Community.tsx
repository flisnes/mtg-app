import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing, PublicUser, TradeLine, WishLine } from '@mtg/shared';
import { ApiError, getUserLists, listUsers } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from '../components/CardViews.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { sanitizeOffer, sanitizeWishlist } from '../trade/validate.js';
import { EmptyState, Page } from './Page.js';

// Community: browse other users' published trade/wishlists (uploaded with
// their backups) and highlight matches against your own data, using the same
// rule as in-person trades: an "any printing" wish matches every printing of
// that card, a specific-printing wish matches only itself.

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function lineDetail(l: TradeLine): string {
  const bits: string[] = [l.condition];
  if (l.finish !== 'nonfoil') bits.push(l.finish);
  if (l.lang !== 'en') bits.push(l.lang);
  return bits.join(' · ');
}

/** My wishlist as a matcher over their tradelist lines. */
function useMyWants(): (oracleId: string, scryfallId: string) => boolean {
  const wishes = useLiveQuery(() => db.wishlist.toArray(), [], []);
  return useMemo(() => {
    const byOracle = new Map<string, (string | null)[]>();
    for (const w of wishes) {
      const list = byOracle.get(w.oracleId) ?? [];
      list.push(w.scryfallId);
      byOracle.set(w.oracleId, list);
    }
    return (oracleId, scryfallId) =>
      (byOracle.get(oracleId) ?? []).some((s) => s === null || s === scryfallId);
  }, [wishes]);
}

/** Matcher over their wishlist lines (null = any printing of the card). */
type HaveFn = (oracleId: string, scryfallId: string | null) => boolean;

/**
 * My collection as two matchers over their wishlist lines:
 *  - `have`: I already have it marked for trade (I'm offering it), and
 *  - `own`: I own a copy at all (whether or not it's on my tradelist).
 * Same printing rule as trades: a specific-printing wish matches only that
 * printing, an "any printing" wish matches every printing of the card.
 */
function useMyCollection(): { have: HaveFn; own: HaveFn } {
  const entries = useLiveQuery(() => db.collection.toArray(), [], []);
  return useMemo(() => {
    const matcher = (rows: typeof entries): HaveFn => {
      const oracles = new Set(rows.map((e) => e.oracleId));
      const printings = new Set(rows.map((e) => e.scryfallId));
      return (oracleId, scryfallId) =>
        scryfallId === null ? oracles.has(oracleId) : printings.has(scryfallId);
    };
    return { have: matcher(entries.filter((e) => e.quantityForTrade > 0)), own: matcher(entries) };
  }, [entries]);
}

export function Community() {
  const account = useAccount();

  if (!account.enabled || account.session === null) {
    return (
      <Page title="Community" subtitle="Browse other users’ trade and wishlists.">
        <EmptyState hint={<Link to="/account">Go to Account &amp; sync</Link>}>
          {account.enabled
            ? 'Sign in to browse other users’ lists. Your own trade and wishlist are shared when you back up.'
            : 'Accounts aren’t configured for this build yet.'}
        </EmptyState>
      </Page>
    );
  }
  if (account.session === undefined) return <Page title="Community">{null}</Page>;

  return <CommunityBrowser token={account.session.token} me={account.session.username} />;
}

function CommunityBrowser({ token, me }: { token: string; me: string }) {
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Selection lives in the URL (/community/:username) so notifications can
  // deep-link straight to a user, with ?highlight=oracleId,… for the matches.
  const { username: selected } = useParams<{ username?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const highlight = useMemo(() => {
    const raw = searchParams.get('highlight') ?? '';
    return new Set(raw.split(',').filter(Boolean));
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    listUsers(token)
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.friendlyMessage : 'Could not load users.');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (selected) {
    return (
      <UserLists
        token={token}
        username={selected}
        highlight={highlight}
        onBack={() => navigate('/community')}
      />
    );
  }

  return (
    <Page title="Community" subtitle="Everyone who backs up shares their trade and wishlist here.">
      {error ? (
        <EmptyState>{error}</EmptyState>
      ) : users === null ? (
        <p className="fine-print">Loading…</p>
      ) : users.length === 0 ? (
        <EmptyState hint="Lists appear after the first backup.">No one has published lists yet.</EmptyState>
      ) : (
        <ul className="menu-list">
          {users.map((u) => (
            <li key={u.username}>
              <button
                className="menu-item menu-item-btn"
                onClick={() => navigate(`/community/${encodeURIComponent(u.username)}`)}
              >
                <span className="community-user">
                  {u.username}
                  {u.username === me && <span className="badge own-yes"> you</span>}
                </span>
                <span className="community-meta">
                  ⇄ {u.tradelistCount} · ★ {u.wishlistCount} · {fmtDate(u.updatedAt)}
                </span>
                <span className="menu-chevron" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

/** Resolved card-DB data for the lines we're showing, from the viewer's local DB. */
interface CardMaps {
  oracles: Map<string, Priced<OracleCard>>;
  printings: Map<string, Priced<Printing>>;
}

/** The card-info sheet target: an oracle card, optionally pinned to a printing. */
type InfoTarget = { oracle: Priced<OracleCard>; scryfallId?: string };

function UserLists({
  token,
  username,
  highlight,
  onBack,
}: {
  token: string;
  username: string;
  /** oracleIds to emphasise (the cards a notification matched on). */
  highlight?: Set<string>;
  onBack: () => void;
}) {
  const [lists, setLists] = useState<{ updatedAt: number; tradelist: TradeLine[]; wishlist: WishLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useViewMode();
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const iWant = useMyWants();
  const { have: iHave, own: iOwn } = useMyCollection();

  useEffect(() => {
    let cancelled = false;
    getUserLists(token, username)
      .then((res) => {
        if (cancelled) return;
        // Same trust model as trade shares: the other side is untrusted input.
        setLists({
          updatedAt: res.updatedAt,
          tradelist: sanitizeOffer(res.tradelist),
          wishlist: sanitizeWishlist(res.wishlist),
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.friendlyMessage : 'Could not load lists.');
      });
    return () => {
      cancelled = true;
    };
  }, [token, username]);

  // The wire lines carry only name + ids; resolve images and set/printing detail
  // from the viewer's own synced card DB (like the own-list screens do).
  const cards = useLiveQuery<CardMaps>(async () => {
    if (!lists) return { oracles: new Map(), printings: new Map() };
    const oracleIds = [...lists.tradelist, ...lists.wishlist].map((l) => l.oracleId);
    const scryfallIds = [
      ...lists.tradelist.map((l) => l.scryfallId),
      ...lists.wishlist.map((l) => l.scryfallId),
    ].filter((id): id is string => id !== null);
    const [oracles, printings] = await Promise.all([
      getOracleCardsByIds(oracleIds),
      getPrintingsByIds(scryfallIds),
    ]);
    return { oracles, printings };
  }, [lists]);

  // Sort the strongest signal to the top: notification hit, then a direct
  // list match, then "you own it but haven't listed it", then by name.
  const hiSort = (a: { hi: boolean; match: boolean; own: boolean; line: { name: string } }, b: typeof a) =>
    Number(b.hi) - Number(a.hi) ||
    Number(b.match) - Number(a.match) ||
    Number(b.own) - Number(a.own) ||
    a.line.name.localeCompare(b.line.name);

  const trade = useMemo(() => {
    if (!lists) return [];
    return lists.tradelist
      .map((l) => ({ line: l, match: iWant(l.oracleId, l.scryfallId), own: false, hi: highlight?.has(l.oracleId) ?? false }))
      .sort(hiSort);
  }, [lists, iWant, highlight]);

  const wish = useMemo(() => {
    if (!lists) return [];
    return lists.wishlist
      .map((l) => {
        const match = iHave(l.oracleId, l.scryfallId);
        // "own" is the new highlight: a card of theirs sitting in my
        // collection that I haven't put on my tradelist yet. If it's already
        // for trade, the ⇄ match badge already says so — don't double-flag.
        const own = !match && iOwn(l.oracleId, l.scryfallId);
        return { line: l, match, own, hi: highlight?.has(l.oracleId) ?? false };
      })
      .sort(hiSort);
  }, [lists, iHave, iOwn, highlight]);

  const tradeMatches = trade.filter((t) => t.match).length;
  const wishMatches = wish.filter((w) => w.match).length;
  const wishOwned = wish.filter((w) => w.own).length;

  const tradeItems = useMemo(
    (): CardItem[] =>
      trade.map(({ line, match, hi }, i) => {
        const oracle = cards?.oracles.get(line.oracleId);
        const printing = cards?.printings.get(line.scryfallId);
        return {
          key: `${line.scryfallId}-${i}`,
          name: oracle?.name ?? line.name,
          image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
          count: line.quantity,
          sub: (
            <>
              {printing && <SetSymbol set={printing.set} className="sub-set-symbol" title={printing.setName} />}
              {printing ? `${printing.setName} · #${printing.collectorNumber} · ` : ''}
              {lineDetail(line)}
            </>
          ),
          badge: hi ? '🔔 you want this' : match ? '⭐ you want this' : undefined,
          badgeClass: hi ? 'badge-match' : 'own-trade',
          badgeTitle: 'On your wishlist',
          onClick: oracle ? () => setInfo({ oracle, scryfallId: line.scryfallId }) : undefined,
        };
      }),
    [trade, cards],
  );

  const wishItems = useMemo(
    (): CardItem[] =>
      wish.map(({ line, match, own, hi }, i) => {
        const oracle = cards?.oracles.get(line.oracleId);
        const printing = line.scryfallId ? cards?.printings.get(line.scryfallId) : undefined;
        return {
          key: `${line.oracleId}-${i}`,
          name: oracle?.name ?? line.name,
          image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
          count: line.quantity,
          sub: line.scryfallId ? (
            printing ? (
              <>
                <SetSymbol set={printing.set} className="sub-set-symbol" title={printing.setName} />
                {`${printing.setName} · #${printing.collectorNumber}`}
              </>
            ) : (
              'specific printing'
            )
          ) : (
            'any printing'
          ),
          badge: hi
            ? '🔔 you have this'
            : match
              ? '⇄ you have this'
              : own
                ? '✓ you own this'
                : undefined,
          badgeClass: hi ? 'badge-match' : match ? 'own-trade' : 'own-yes',
          badgeTitle: match
            ? 'In your tradelist'
            : own
              ? 'You own this but haven’t listed it for trade. Add it to your tradelist to offer it.'
              : undefined,
          onClick: oracle ? () => setInfo({ oracle, scryfallId: line.scryfallId ?? undefined }) : undefined,
        };
      }),
    [wish, cards],
  );

  return (
    <Page
      title={username}
      subtitle={lists ? `Lists updated ${fmtDate(lists.updatedAt)}.` : undefined}
      menu={
        <button className="ghost" onClick={onBack}>
          ‹ All users
        </button>
      }
    >
      {error ? (
        <EmptyState>{error}</EmptyState>
      ) : !lists ? (
        <p className="fine-print">Loading…</p>
      ) : (
        <>
          <div className="meta-row">
            {tradeMatches > 0 || wishMatches > 0 || wishOwned > 0 ? (
              <p className="fine-print match-summary">
                {tradeMatches > 0 && <>⭐ {tradeMatches} of their trades match your wishlist.</>}{' '}
                {wishMatches > 0 && <>⇄ {wishMatches} of their wishes match your tradelist.</>}{' '}
                {wishOwned > 0 && <>✓ You own {wishOwned} more of their wishes (not yet on your tradelist).</>}
              </p>
            ) : (
              <span />
            )}
            <div className="meta-actions">
              <ViewToggle mode={view} onChange={setView} />
            </div>
          </div>

          <section className="about-section">
            <h2>Has for trade ({trade.length})</h2>
            {trade.length === 0 ? (
              <p className="fine-print">Nothing marked for trade.</p>
            ) : (
              <CardItems view={view} items={tradeItems} />
            )}
          </section>

          <section className="about-section">
            <h2>Wants ({wish.length})</h2>
            {wish.length === 0 ? (
              <p className="fine-print">Empty wishlist.</p>
            ) : (
              <CardItems view={view} items={wishItems} />
            )}
          </section>
        </>
      )}

      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}
