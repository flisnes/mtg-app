import { useMemo, useState } from 'react';
import type { Finish, OracleCard, Priced } from '@mtg/shared';
import { compileCardQuery, rowPrintingSummary, toSearchableEntry } from '../cardDb/querySyntax.js';
import { CardSheet } from './CardSheet.js';
import type { CardItem } from './CardViews.js';
import { ResultsList, resultCount } from './ResultsList.js';
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

  const loading = !lists && !error;

  return (
    <>
      <ResultsList
        items={items}
        pageKey={`profile:${username}|${query}|${showTrade}|${showWish}|${sort.key}:${sort.dir}`}
        status={error ? error : loading ? 'Loading…' : `${resultCount(items.length)} in ${username}’s lists`}
        controls={<SortControls prefs={sort} onChange={setSort} />}
        showEmpty={!loading && !error && items.length === 0}
      />

      {info && (
        <CardSheet
          mode="info"
          oracleCard={info.oracle}
          initialScryfallId={info.scryfallId}
          wishView={info.wish}
          onClose={() => setInfo(null)}
        />
      )}
    </>
  );
}
