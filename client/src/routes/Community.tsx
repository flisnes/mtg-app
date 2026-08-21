import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Finish, OracleCard, PublicUser, TradeLine, WishLine } from '@mtg/shared';
import { ApiError, listUsers } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { compileCardQuery, rowPrintingSummary, toSearchableEntry } from '../cardDb/querySyntax.js';
import { Avatar } from '../components/Avatar.js';
import { CardRow } from '../components/CardRow.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from '../components/CardViews.js';
import {
  SortControls,
  sortCards,
  priceValue,
  pricedForFinish,
  useCardSort,
  type CardSortPrefs,
  type SortFields,
} from '../components/CardSorting.js';
import { Icon } from '../components/icons.js';
import { LoadMoreSentinel } from '../components/LoadMoreSentinel.js';
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

const PAGE_SIZE = 60;

// One trade/wishlist line paired with how it relates to the viewer:
//  match — trade: they have a card I want; wish: I have a card they want.
//  own   — wish only: I own the card but haven't listed it for trade yet.
//  hi    — this match is one the notification named, pinned above the rest. It
//          only ever decorates a row that already matches, so the badges read
//          the same whether you arrived from the bell or from the user list.
type TradeEntry = { line: TradeLine; match: boolean; own: false; hi: boolean };
type WishEntry = { line: WishLine; match: boolean; own: boolean; hi: boolean };

/** Notification-named oracleIds, kept apart per list so neither leaks into the other. */
type Highlight = { trade: Set<string>; wish: Set<string> };

// Matches float to the top of a Community list (hi > match > own), keeping the
// chosen sort order within each tier (Array.prototype.sort is stable).
function rankOf(r: { hi: boolean; match: boolean; own: boolean }): number {
  return r.hi ? 3 : r.match ? 2 : r.own ? 1 : 0;
}

/** Two layouts for a user's lists: swipeable rows (default) or the old stacks. */
type Layout = 'row' | 'stack';
const LAYOUT_KEY = 'communityLayout';

function useLayout(): [Layout, (l: Layout) => void] {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'stack' ? 'stack' : 'row';
    } catch {
      return 'row';
    }
  });
  const set = (l: Layout) => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  };
  return [layout, set];
}

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
  // deep-link straight to a user. The matched oracleIds come in per direction —
  // ?hiTrade=… for their tradelist, ?hiWish=… for their wishlist.
  const { username: selected } = useParams<{ username?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const hiTrade = searchParams.get('hiTrade') ?? '';
  const hiWish = searchParams.get('hiWish') ?? '';
  const highlight = useMemo<Highlight>(
    () => ({
      trade: new Set(hiTrade.split(',').filter(Boolean)),
      wish: new Set(hiWish.split(',').filter(Boolean)),
    }),
    [hiTrade, hiWish],
  );

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
                  <Icon name="trade" size={12} className="mark-trade" /> {u.tradelistCount} ·{' '}
                  <Icon name="wishlist" size={12} className="mark-wish" /> {u.wishlistCount} ·{' '}
                  {fmtDate(u.updatedAt)}
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

function buildTradeItems(rows: TradeEntry[], cards: CardMaps | undefined, onOpen: (t: InfoTarget) => void): CardItem[] {
  return rows.map(({ line, match, hi }, i) =>
    tradeLineItem(line, `${line.scryfallId}-${i}`, cards, { match, hi }, (oracle) =>
      onOpen({ oracle, scryfallId: line.scryfallId }),
    ),
  );
}

function buildWishItems(rows: WishEntry[], cards: CardMaps | undefined, onOpen: (t: InfoTarget) => void): CardItem[] {
  return rows.map(({ line, match, own, hi }, i) =>
    wishLineItem(line, `${line.oracleId}-${i}`, cards, { match, own, hi }, (oracle) =>
      onOpen({ oracle, scryfallId: line.scryfallId ?? undefined, wish: line }),
    ),
  );
}

/** Sort by the chosen key, then float matches to the front (stable). */
function orderRows<T extends { hi: boolean; match: boolean; own: boolean }>(
  rows: T[],
  fieldsOf: (r: T) => SortFields,
  sort: CardSortPrefs,
): T[] {
  return [...sortCards(rows, fieldsOf, sort)].sort((a, b) => rankOf(b) - rankOf(a));
}

function UserLists({
  token,
  username,
  highlight,
  onBack,
}: {
  token: string;
  username: string;
  /** oracleIds to emphasise (the cards a notification matched on), per list. */
  highlight?: Highlight;
  onBack: () => void;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { lists, error } = useUserLists(token, username);
  const cards = useResolvedCards(lists);
  const [layout, setLayout] = useLayout();
  const [view, setView] = useViewMode();
  const [info, setInfo] = useState<InfoTarget | null>(null);
  const iWant = useMyWants();
  const { have: iHave, own: iOwn } = useMyCollection();

  // Same collection-style sort controls as the own-list screens, shared with
  // the "See all" view. Matches (and deep-linked notification hits) float to the
  // top here; the full-list view respects the pure sort so search stays useful.
  const [tradeSort, setTradeSort] = useCardSort('community-trade');
  const [wishSort, setWishSort] = useCardSort('community-wish');

  // Enrich each line with how it relates to me (unsorted — the display layers
  // and the See-all view apply their own order).
  const tradeBase = useMemo<TradeEntry[]>(
    () =>
      (lists?.tradelist ?? []).map((l) => {
        const match = iWant(l);
        return { line: l, match, own: false, hi: match && (highlight?.trade.has(l.oracleId) ?? false) };
      }),
    [lists, iWant, highlight],
  );
  const wishBase = useMemo<WishEntry[]>(
    () =>
      (lists?.wishlist ?? []).map((l) => {
        const match = iHave(l);
        // "own": a card of theirs I have but haven't listed for trade. If it's
        // already for trade the trade match badge says so — don't double-flag.
        const own = !match && iOwn(l);
        return { line: l, match, own, hi: match && (highlight?.wish.has(l.oracleId) ?? false) };
      }),
    [lists, iHave, iOwn, highlight],
  );

  const tradeMatches = tradeBase.filter((t) => t.match).length;
  const wishMatches = wishBase.filter((w) => w.match).length;
  const wishOwned = wishBase.filter((w) => w.own).length;

  // Matches-first order for the overview (the See-all view sorts its own copy).
  const tradeOrdered = useMemo(
    () => orderRows(tradeBase, (t) => tradeFields(t.line, cards), tradeSort),
    [tradeBase, cards, tradeSort],
  );
  const wishOrdered = useMemo(
    () => orderRows(wishBase, (w) => wishFields(w.line, cards), wishSort),
    [wishBase, cards, wishSort],
  );

  const menu = (
    <>
      <button className="ghost" onClick={onBack}>
        ‹ All users
      </button>
      <button className="ghost" onClick={() => navigate(`/profile/${encodeURIComponent(username)}`)}>
        Profile
      </button>
    </>
  );
  const sheet = info && (
    <CardSheet
      oracleCard={info.oracle}
      initialScryfallId={info.scryfallId}
      wishView={info.wish}
      readOnly
      onClose={() => setInfo(null)}
    />
  );

  // "See all" is a URL sub-mode (?all=trade|wish) so the back button returns to
  // the overview, reusing the already-fetched lists.
  const all = searchParams.get('all');
  const openAll = (which: 'trade' | 'wish') =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('all', which);
        return next;
      },
      { replace: false },
    );
  const closeAll = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('all');
        return next;
      },
      { replace: false },
    );

  if (lists && (all === 'trade' || all === 'wish')) {
    return (
      <Page title={username} menu={menu}>
        {all === 'trade' ? (
          <UserListAll
            heading="Has for trade"
            rows={tradeBase}
            cards={cards}
            fieldsOf={(t) => tradeFields(t.line, cards)}
            build={(rows) => buildTradeItems(rows, cards, setInfo)}
            sort={tradeSort}
            setSort={setTradeSort}
            onClose={closeAll}
          />
        ) : (
          <UserListAll
            heading="Wants"
            rows={wishBase}
            cards={cards}
            fieldsOf={(w) => wishFields(w.line, cards)}
            build={(rows) => buildWishItems(rows, cards, setInfo)}
            sort={wishSort}
            setSort={setWishSort}
            onClose={closeAll}
          />
        )}
        {sheet}
      </Page>
    );
  }

  return (
    <Page title={username} subtitle={lists ? `Lists updated ${fmtDate(lists.updatedAt)}.` : undefined} menu={menu}>
      {error ? (
        <EmptyState>{error}</EmptyState>
      ) : !lists ? (
        <p className="fine-print">Loading…</p>
      ) : (
        <>
          <div className="meta-row">
            {tradeMatches > 0 || wishMatches > 0 || wishOwned > 0 ? (
              <p className="fine-print match-summary">
                {tradeMatches > 0 && (
                  <>
                    <Icon name="wishlist" size={12} className="mark-wish" /> {tradeMatches} of their trades match
                    your wishlist.
                  </>
                )}{' '}
                {wishMatches > 0 && (
                  <>
                    <Icon name="trade" size={12} className="mark-trade" /> {wishMatches} of their wishes match your
                    tradelist.
                  </>
                )}{' '}
                {wishOwned > 0 && (
                  <>
                    <Icon name="check" size={12} className="mark-own" /> You own {wishOwned} more of their wishes
                    (not yet on your tradelist).
                  </>
                )}
              </p>
            ) : (
              <span />
            )}
            <div className="meta-actions">
              <LayoutToggle layout={layout} onChange={setLayout} />
              {layout === 'stack' && <ViewToggle mode={view} onChange={setView} />}
            </div>
          </div>

          <ListSection
            heading="Has for trade"
            count={tradeBase.length}
            emptyLabel="Nothing marked for trade."
            layout={layout}
            view={view}
            sort={tradeSort}
            setSort={setTradeSort}
            onSeeAll={() => openAll('trade')}
            items={tradeOrdered}
            build={(rows) => buildTradeItems(rows, cards, setInfo)}
            signature={`${username}|trade|${tradeBase.length}`}
          />

          <ListSection
            heading="Wants"
            count={wishBase.length}
            emptyLabel="Empty wishlist."
            layout={layout}
            view={view}
            sort={wishSort}
            setSort={setWishSort}
            onSeeAll={() => openAll('wish')}
            items={wishOrdered}
            build={(rows) => buildWishItems(rows, cards, setInfo)}
            signature={`${username}|wish|${wishBase.length}`}
          />
        </>
      )}
      {sheet}
    </Page>
  );
}

/** Row/stack toggle mirroring ViewToggle's look. */
function LayoutToggle({ layout, onChange }: { layout: Layout; onChange: (l: Layout) => void }) {
  return (
    <div className="view-toggle" role="group" aria-label="Layout">
      <button
        className={layout === 'row' ? 'active' : ''}
        onClick={() => onChange('row')}
        aria-pressed={layout === 'row'}
        title="Swipeable rows"
      >
        ⇄
      </button>
      <button
        className={layout === 'stack' ? 'active' : ''}
        onClick={() => onChange('stack')}
        aria-pressed={layout === 'stack'}
        title="Stacked grid"
      >
        ≣
      </button>
    </div>
  );
}

/** One list on the overview: a swipeable row or a paged stack, with a "See all". */
function ListSection<T extends { hi: boolean; match: boolean; own: boolean }>({
  heading,
  count,
  emptyLabel,
  layout,
  view,
  sort,
  setSort,
  onSeeAll,
  items,
  build,
  signature,
}: {
  heading: string;
  count: number;
  emptyLabel: string;
  layout: Layout;
  view: 'list' | 'grid' | 'pile';
  sort: CardSortPrefs;
  setSort: (p: CardSortPrefs) => void;
  onSeeAll: () => void;
  items: T[];
  build: (rows: T[]) => CardItem[];
  signature: string;
}) {
  const { limit, showMore } = usePagedLimit(signature, PAGE_SIZE);
  const visible = build(items.slice(0, limit));
  const hasMore = items.length > limit;

  return (
    <section className="about-section">
      <div className="list-section-head">
        <h2>
          {heading} ({count})
        </h2>
        <div className="list-section-actions">
          {count > 0 && <SortControls prefs={sort} onChange={setSort} />}
          {count > 0 && (
            <button className="ghost see-all" onClick={onSeeAll}>
              See all
            </button>
          )}
        </div>
      </div>
      {count === 0 ? (
        <p className="fine-print">{emptyLabel}</p>
      ) : layout === 'row' ? (
        <CardRow items={visible} hasMore={hasMore} onLoadMore={showMore} />
      ) : (
        <>
          <CardItems view={view} items={visible} />
          {hasMore && (
            <button className="show-more" onClick={showMore}>
              Show {Math.min(PAGE_SIZE, items.length - limit)} more
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** Full-screen list with its own search, sort, view toggle and scroll autoload. */
function UserListAll<
  T extends {
    hi: boolean;
    match: boolean;
    own: boolean;
    line: { oracleId: string; scryfallId?: string | null; finish?: Finish };
  },
>({
  heading,
  rows,
  cards,
  fieldsOf,
  build,
  sort,
  setSort,
  onClose,
}: {
  heading: string;
  rows: T[];
  cards: CardMaps | undefined;
  fieldsOf: (r: T) => SortFields;
  build: (rows: T[]) => CardItem[];
  sort: CardSortPrefs;
  setSort: (p: CardSortPrefs) => void;
  onClose: () => void;
}) {
  const [view, setView] = useViewMode();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = compileCardQuery(query);
    const sorted = sortCards(rows, fieldsOf, sort);
    if (q.isEmpty) return sorted;
    return sorted.filter((r) => {
      const oracle = cards?.oracles.get(r.line.oracleId) as OracleCard | undefined;
      // The line names its own printing, so `set:` and the printing-level `is:`
      // keywords filter that copy rather than every printing of the card.
      const printing = r.line.scryfallId ? cards?.printings.get(r.line.scryfallId) : undefined;
      return !!oracle && q.matches(toSearchableEntry(oracle, rowPrintingSummary(printing, r.line.finish)));
    });
  }, [rows, cards, fieldsOf, sort, query]);

  const { limit, showMore } = usePagedLimit(`all|${heading}|${query}|${rows.length}`, PAGE_SIZE);
  const items = build(filtered.slice(0, limit));

  return (
    <>
      <div className="list-section-head">
        <button className="ghost see-all" onClick={onClose}>
          ‹ Back
        </button>
        <h2 className="list-all-heading">
          {heading} ({rows.length})
        </h2>
        <div className="list-section-actions">
          <SortControls prefs={sort} onChange={setSort} />
          <ViewToggle mode={view} onChange={setView} />
        </div>
      </div>

      <div className="search-field">
        <Icon name="search" size={16} />
        <input
          className="search-input"
          type="search"
          placeholder="Search these cards…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="search-meta">Nothing here matches.</p>
      ) : (
        <>
          <CardItems view={view} items={items} />
          <LoadMoreSentinel hasMore={filtered.length > items.length} onLoadMore={showMore} rearmKey={items.length} />
        </>
      )}
    </>
  );
}
