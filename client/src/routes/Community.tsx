import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { PublicUser, TradeLine, WishLine } from '@mtg/shared';
import { ApiError, listUsers } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { Avatar } from '../components/Avatar.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from '../components/CardViews.js';
import {
  SortControls,
  sortCards,
  priceValue,
  pricedForFinish,
  useCardSort,
  type SortFields,
} from '../components/CardSorting.js';
import { usePagedLimit } from '../components/usePagedLimit.js';
import {
  tradeLineItem,
  wishLineItem,
  useMyCollection,
  useMyWants,
  useResolvedCards,
  useUserLists,
  type CardMaps,
  type InfoTarget,
} from '../community/userLists.js';
import { fmtDate } from '../util/format.js';
import { EmptyState, Page } from './Page.js';

// Community: browse other users' published trade/wishlists (uploaded with
// their backups) and highlight matches against your own data, using the same
// rule as in-person trades: an "any printing" wish matches every printing of
// that card, a specific-printing wish matches only itself.

/** Sort fields for a trade line, resolved against the viewer's card DB. */
function tradeFields(line: TradeLine, cards: CardMaps | undefined): SortFields {
  const oracle = cards?.oracles.get(line.oracleId);
  const printing = cards?.printings.get(line.scryfallId);
  return { name: oracle?.name ?? line.name, cmc: oracle?.cmc, price: priceValue(pricedForFinish(printing, line.finish), oracle) };
}

/** Sort fields for a wish line (may be "any printing" and have no finish). */
function wishFields(line: WishLine, cards: CardMaps | undefined): SortFields {
  const oracle = cards?.oracles.get(line.oracleId);
  const printing = line.scryfallId ? cards?.printings.get(line.scryfallId) : undefined;
  return {
    name: oracle?.name ?? line.name,
    cmc: oracle?.cmc,
    price: priceValue(pricedForFinish(printing, line.finish ?? 'nonfoil'), oracle),
  };
}

export function Community() {
  const account = useAccount();

  if (!account.enabled || account.session === null) {
    return (
      <Page title="Community" subtitle="Browse other users’ trade and wishlists.">
        <EmptyState hint={<Link to="/settings">Go to Settings</Link>}>
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
            <li key={u.username} className="community-row">
              <button
                className="avatar-btn"
                onClick={() => navigate(`/profile/${encodeURIComponent(u.username)}`)}
                title={`${u.username}’s profile`}
                aria-label={`${u.username}’s profile`}
              >
                <Avatar avatar={u.avatar} username={u.username} size={40} />
              </button>
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
  const navigate = useNavigate();
  const { lists, error } = useUserLists(token, username);
  const cards = useResolvedCards(lists);
  const [view, setView] = useViewMode();
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const iWant = useMyWants();
  const { have: iHave, own: iOwn } = useMyCollection();

  // Same collection-style sort controls as the own-list screens. A deep-linked
  // notification hit (`hi`) still pins to the very top; everything else follows
  // the chosen sort, tie-broken by name.
  const [tradeSort, setTradeSort] = useCardSort('community-trade');
  const [wishSort, setWishSort] = useCardSort('community-wish');
  const pinHi = <T extends { hi: boolean }>(rows: T[]) => [...rows].sort((a, b) => Number(b.hi) - Number(a.hi));

  const trade = useMemo(() => {
    if (!lists) return [];
    const enriched = lists.tradelist.map((l) => ({ line: l, match: iWant(l), own: false, hi: highlight?.has(l.oracleId) ?? false }));
    return pinHi(sortCards(enriched, (t) => tradeFields(t.line, cards), tradeSort));
  }, [lists, iWant, highlight, cards, tradeSort]);

  const wish = useMemo(() => {
    if (!lists) return [];
    const enriched = lists.wishlist.map((l) => {
      const match = iHave(l);
      // "own" is the new highlight: a card of theirs sitting in my collection
      // that I haven't put on my tradelist yet. If it's already for trade, the
      // ⇄ match badge already says so — don't double-flag.
      const own = !match && iOwn(l);
      return { line: l, match, own, hi: highlight?.has(l.oracleId) ?? false };
    });
    return pinHi(sortCards(enriched, (w) => wishFields(w.line, cards), wishSort));
  }, [lists, iHave, iOwn, highlight, cards, wishSort]);

  const tradeMatches = trade.filter((t) => t.match).length;
  const wishMatches = wish.filter((w) => w.match).length;
  const wishOwned = wish.filter((w) => w.own).length;

  // Page both lists — another user's tradelist/wishlist can run to thousands of
  // lines, and this renders card tiles with images for each.
  const tradePaged = usePagedLimit(`${username}|trade|${trade.length}`, 60);
  const wishPaged = usePagedLimit(`${username}|wish|${wish.length}`, 60);

  const tradeItems = useMemo(
    (): CardItem[] =>
      trade.map(({ line, match, hi }, i) =>
        tradeLineItem(line, `${line.scryfallId}-${i}`, cards, { match, hi }, (oracle) =>
          setInfo({ oracle, scryfallId: line.scryfallId }),
        ),
      ),
    [trade, cards],
  );

  const wishItems = useMemo(
    (): CardItem[] =>
      wish.map(({ line, match, own, hi }, i) =>
        wishLineItem(line, `${line.oracleId}-${i}`, cards, { match, own, hi }, (oracle) =>
          setInfo({ oracle, scryfallId: line.scryfallId ?? undefined, wish: line }),
        ),
      ),
    [wish, cards],
  );

  return (
    <Page
      title={username}
      subtitle={lists ? `Lists updated ${fmtDate(lists.updatedAt)}.` : undefined}
      menu={
        <>
          <button className="ghost" onClick={onBack}>
            ‹ All users
          </button>
          <button className="ghost" onClick={() => navigate(`/profile/${encodeURIComponent(username)}`)}>
            Profile
          </button>
        </>
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
            <div className="list-section-head">
              <h2>Has for trade ({trade.length})</h2>
              {trade.length > 0 && <SortControls prefs={tradeSort} onChange={setTradeSort} />}
            </div>
            {trade.length === 0 ? (
              <p className="fine-print">Nothing marked for trade.</p>
            ) : (
              <>
                <CardItems view={view} items={tradeItems.slice(0, tradePaged.limit)} />
                {tradeItems.length > tradePaged.limit && (
                  <button className="show-more" onClick={tradePaged.showMore}>
                    Show {Math.min(60, tradeItems.length - tradePaged.limit)} more
                  </button>
                )}
              </>
            )}
          </section>

          <section className="about-section">
            <div className="list-section-head">
              <h2>Wants ({wish.length})</h2>
              {wish.length > 0 && <SortControls prefs={wishSort} onChange={setWishSort} />}
            </div>
            {wish.length === 0 ? (
              <p className="fine-print">Empty wishlist.</p>
            ) : (
              <>
                <CardItems view={view} items={wishItems.slice(0, wishPaged.limit)} />
                {wishItems.length > wishPaged.limit && (
                  <button className="show-more" onClick={wishPaged.showMore}>
                    Show {Math.min(60, wishItems.length - wishPaged.limit)} more
                  </button>
                )}
              </>
            )}
          </section>
        </>
      )}

      {info && (
        <CardSheet
          oracleCard={info.oracle}
          initialScryfallId={info.scryfallId}
          wishView={info.wish}
          readOnly
          onClose={() => setInfo(null)}
        />
      )}
    </Page>
  );
}
