import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import type { PublicUser, TradeLine, WishLine } from '@mtg/shared';
import { ApiError, getUserLists, listUsers } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { db } from '../db/schema.js';
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

/** My tradelist as a matcher over their wishlist lines (null = any printing). */
function useMyHaves(): (oracleId: string, scryfallId: string | null) => boolean {
  const forTrade = useLiveQuery(
    () => db.collection.where('quantityForTrade').above(0).toArray(),
    [],
    [],
  );
  return useMemo(() => {
    const oracles = new Set(forTrade.map((e) => e.oracleId));
    const printings = new Set(forTrade.map((e) => e.scryfallId));
    return (oracleId, scryfallId) =>
      scryfallId === null ? oracles.has(oracleId) : printings.has(scryfallId);
  }, [forTrade]);
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
  const [selected, setSelected] = useState<string | null>(null);

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
    return <UserLists token={token} username={selected} onBack={() => setSelected(null)} />;
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
              <button className="menu-item menu-item-btn" onClick={() => setSelected(u.username)}>
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

function UserLists({ token, username, onBack }: { token: string; username: string; onBack: () => void }) {
  const [lists, setLists] = useState<{ updatedAt: number; tradelist: TradeLine[]; wishlist: WishLine[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iWant = useMyWants();
  const iHave = useMyHaves();

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

  const trade = useMemo(() => {
    if (!lists) return [];
    return lists.tradelist
      .map((l) => ({ line: l, match: iWant(l.oracleId, l.scryfallId) }))
      .sort((a, b) => Number(b.match) - Number(a.match) || a.line.name.localeCompare(b.line.name));
  }, [lists, iWant]);

  const wish = useMemo(() => {
    if (!lists) return [];
    return lists.wishlist
      .map((l) => ({ line: l, match: iHave(l.oracleId, l.scryfallId) }))
      .sort((a, b) => Number(b.match) - Number(a.match) || a.line.name.localeCompare(b.line.name));
  }, [lists, iHave]);

  const tradeMatches = trade.filter((t) => t.match).length;
  const wishMatches = wish.filter((w) => w.match).length;

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
          {(tradeMatches > 0 || wishMatches > 0) && (
            <p className="fine-print match-summary">
              {tradeMatches > 0 && <>⭐ {tradeMatches} of their trades match your wishlist.</>}{' '}
              {wishMatches > 0 && <>⇄ {wishMatches} of their wishes match your tradelist.</>}
            </p>
          )}

          <section className="about-section">
            <h2>Has for trade ({trade.length})</h2>
            {trade.length === 0 ? (
              <p className="fine-print">Nothing marked for trade.</p>
            ) : (
              <ul className="community-lines">
                {trade.map(({ line, match }, i) => (
                  <li key={`${line.scryfallId}-${i}`} className={match ? 'community-line match' : 'community-line'}>
                    <span className="line-qty">{line.quantity}×</span>
                    <span className="line-name">{line.name}</span>
                    <span className="line-detail">{lineDetail(line)}</span>
                    {match && (
                      <span className="badge own-trade" title="On your wishlist">
                        ⭐ you want this
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="about-section">
            <h2>Wants ({wish.length})</h2>
            {wish.length === 0 ? (
              <p className="fine-print">Empty wishlist.</p>
            ) : (
              <ul className="community-lines">
                {wish.map(({ line, match }, i) => (
                  <li key={`${line.oracleId}-${i}`} className={match ? 'community-line match' : 'community-line'}>
                    <span className="line-qty">{line.quantity}×</span>
                    <span className="line-name">{line.name}</span>
                    <span className="line-detail">{line.scryfallId === null ? 'any printing' : 'specific printing'}</span>
                    {match && (
                      <span className="badge own-trade" title="In your tradelist">
                        ⇄ you have this
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Page>
  );
}
