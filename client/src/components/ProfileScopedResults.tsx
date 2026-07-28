import { useMemo, useState } from 'react';
import type { OracleCard } from '@mtg/shared';
import { compileCardQuery, toSearchableEntry } from '../cardDb/querySyntax.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import {
  useUserLists,
  useResolvedCards,
  useMyWants,
  useMyCollection,
  tradeLineItem,
  wishLineItem,
  type InfoTarget,
} from '../community/userLists.js';

// The global search, scoped into the profile you're browsing: it filters that
// user's published tradelist / wishlist by the same query as the card search
// and shows the same match badges the Community page does. Read-only — tapping
// a tile opens the info sheet, never an editor. Mirrors ScopedResults, but the
// data comes from the remote lists instead of your own Dexie tables.
export function ProfileScopedResults({
  token,
  username,
  query,
  showTrade,
  showWish,
}: {
  token: string;
  username: string;
  query: string;
  showTrade: boolean;
  showWish: boolean;
}) {
  const { lists, error } = useUserLists(token, username);
  const cards = useResolvedCards(lists);
  const iWant = useMyWants();
  const { have: iHave, own: iOwn } = useMyCollection();
  const [view, setView] = useViewMode();
  const [info, setInfo] = useState<InfoTarget | null>(null);

  const items = useMemo(() => {
    if (!lists) return [];
    const q = compileCardQuery(query);
    const matchesQuery = (oracle: OracleCard | undefined) =>
      q.isEmpty || (!!oracle && q.matches(toSearchableEntry(oracle)));

    const out: CardItem[] = [];
    if (showTrade) {
      lists.tradelist.forEach((line, i) => {
        const oracle = cards?.oracles.get(line.oracleId);
        if (!matchesQuery(oracle)) return;
        out.push(
          tradeLineItem(line, `t:${line.scryfallId}-${i}`, cards, { match: iWant(line), hi: false }, (o) =>
            setInfo({ oracle: o, scryfallId: line.scryfallId }),
          ),
        );
      });
    }
    if (showWish) {
      lists.wishlist.forEach((line, i) => {
        const oracle = cards?.oracles.get(line.oracleId);
        if (!matchesQuery(oracle)) return;
        const match = iHave(line);
        const own = !match && iOwn(line);
        out.push(
          wishLineItem(line, `w:${line.oracleId}-${i}`, cards, { match, own, hi: false }, (o) =>
            setInfo({ oracle: o, scryfallId: line.scryfallId ?? undefined, wish: line }),
          ),
        );
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [lists, cards, query, showTrade, showWish, iWant, iHave, iOwn]);

  const { limit, showMore } = usePagedLimit(`profile:${username}|${query}|${showTrade}|${showWish}`, 60);
  const visible = items.slice(0, limit);
  const loading = !lists && !error;

  return (
    <>
      <div className="meta-row">
        <p className="search-meta">
          {error
            ? error
            : loading
              ? 'Loading…'
              : `${items.length} result${items.length === 1 ? '' : 's'} in ${username}’s lists`}
        </p>
        <ViewToggle mode={view} onChange={setView} />
      </div>

      {!loading && !error && items.length === 0 ? (
        <p className="search-meta">Nothing here matches.</p>
      ) : (
        <>
          <CardItems view={view} items={visible} />
          <LoadMoreSentinel hasMore={items.length > visible.length} onLoadMore={showMore} rearmKey={visible.length} />
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
    </>
  );
}
