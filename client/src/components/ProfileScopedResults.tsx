import { useMemo, useState } from 'react';
import type { Finish, OracleCard, Priced } from '@mtg/shared';
import { compileCardQuery, rowPrintingSummary, toSearchableEntry } from '../cardDb/querySyntax.js';
import { CardSheet } from './CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from './CardViews.js';
import { usePagedLimit } from './usePagedLimit.js';
import { LoadMoreSentinel } from './LoadMoreSentinel.js';
import { SortControls, priceValue, sortCards, useCardSort, type SortFields } from './CardSorting.js';
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
//
// The Community page sorts their tradelist and wishlist separately; here the
// two are one merged list, so they share one preference under its own key. The
// options are the same three — their lists say nothing about when a card was
// added or what it did last week.
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
  const [sort, setSort] = useCardSort('profile');
  const [info, setInfo] = useState<InfoTarget | null>(null);

  const items = useMemo(() => {
    if (!lists) return [];
    const q = compileCardQuery(query);
    // Each line names the printing it's about, so `set:` and the printing-level
    // `is:` keywords filter that copy — same as they do on your own lists.
    const matchesQuery = (oracle: OracleCard | undefined, line: { scryfallId: string | null; finish?: Finish }) =>
      q.isEmpty ||
      (!!oracle &&
        q.matches(
          toSearchableEntry(
            oracle,
            rowPrintingSummary(line.scryfallId ? cards?.printings.get(line.scryfallId) : undefined, line.finish),
          ),
        ));

    // Item plus what to sort it by, kept side by side: a CardItem has a name
    // but not a mana value or a price to order on.
    const out: { item: CardItem; fields: SortFields }[] = [];
    const fieldsFor = (oracle: Priced<OracleCard> | undefined, scryfallId: string | null): SortFields => ({
      name: oracle?.name,
      cmc: oracle?.cmc,
      price: priceValue(scryfallId ? cards?.printings.get(scryfallId) : undefined, oracle),
    });
    if (showTrade) {
      lists.tradelist.forEach((line, i) => {
        const oracle = cards?.oracles.get(line.oracleId);
        if (!matchesQuery(oracle, line)) return;
        out.push({
          item: tradeLineItem(line, `t:${line.scryfallId}-${i}`, cards, { match: iWant(line), hi: false }, (o) =>
            setInfo({ oracle: o, scryfallId: line.scryfallId }),
          ),
          fields: fieldsFor(oracle, line.scryfallId),
        });
      });
    }
    if (showWish) {
      lists.wishlist.forEach((line, i) => {
        const oracle = cards?.oracles.get(line.oracleId);
        if (!matchesQuery(oracle, line)) return;
        const match = iHave(line);
        const own = !match && iOwn(line);
        out.push({
          item: wishLineItem(line, `w:${line.oracleId}-${i}`, cards, { match, own, hi: false }, (o) =>
            setInfo({ oracle: o, scryfallId: line.scryfallId ?? undefined, wish: line }),
          ),
          fields: fieldsFor(oracle, line.scryfallId),
        });
      });
    }
    return sortCards(out, (o) => o.fields, sort).map((o) => o.item);
  }, [lists, cards, query, showTrade, showWish, sort, iWant, iHave, iOwn]);

  const { limit, showMore } = usePagedLimit(
    `profile:${username}|${query}|${showTrade}|${showWish}|${sort.key}:${sort.dir}`,
    60,
  );
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
        <div className="meta-actions">
          <SortControls prefs={sort} onChange={setSort} />
          <ViewToggle mode={view} onChange={setView} />
        </div>
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
