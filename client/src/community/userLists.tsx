import { useMemo } from 'react';
import {
  wishCountMatcher,
  wishMatchesCopy,
  type CollectionEntry,
  type OracleCard,
  type Priced,
  type TradeLine,
  type WishLine,
  type WishlistEntry,
} from '@mtg/shared';
import { getUserLists } from '../account/api.js';
import { useApiQuery } from '../account/useApiQuery.js';
import { useCardMaps, type CardMaps } from '../db/useCardMaps.js';
import { useCollectionEntries, useWishes } from '../db/collectionSnapshot.js';

/** Stable while the snapshot loads, so the matcher memo doesn't churn. */
const EMPTY_ENTRIES: CollectionEntry[] = [];
const EMPTY_WISHES: WishlistEntry[] = [];
import { Icon } from '../components/icons.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { baseCardItem, tradeLineCardItem } from '../components/cardRows.js';
import { sanitizePublicTradelist, sanitizePublicWishlist } from '../trade/validate.js';
import type { CardItem } from '../components/CardViews.js';

// Shared machinery for viewing another user's published trade/wishlist: the
// fetch + card-DB resolution, the "does this match my own stuff" matchers, and
// the row builders. Used by the Community page and by the global search when it
// scopes into the profile you're browsing.

interface UserListsData {
  updatedAt: number;
  tradelist: TradeLine[];
  wishlist: WishLine[];
}

/** The card-info sheet target: an oracle card, optionally pinned to a printing.
 *  For a wishlist tile, `wish` carries their preferences so the sheet can show
 *  them read-only (any printing / min condition / finish / language). */
export type InfoTarget = { oracle: Priced<OracleCard>; scryfallId?: string; wish?: WishLine };

/** A wish's preferences, spelled out for a trade partner (empty = no prefs). */
function wishDetail(l: WishLine): string {
  const bits: string[] = [];
  if (l.finish && l.finish !== 'nonfoil') bits.push(l.finish);
  if (l.condition) bits.push(`min ${l.condition}`);
  if (l.lang && l.lang !== 'en') bits.push(l.lang);
  return bits.join(' · ');
}

/** Fetch + sanitize another user's published lists. Untrusted input, same as trade shares. */
export function useUserLists(token: string, username: string): { lists: UserListsData | null; error: string | null } {
  const { data, error } = useApiQuery(
    () =>
      getUserLists(token, username).then(
        (res): UserListsData => ({
          updatedAt: res.updatedAt,
          tradelist: sanitizePublicTradelist(res.tradelist),
          wishlist: sanitizePublicWishlist(res.wishlist),
        }),
      ),
    [token, username],
    { fallback: 'Could not load lists.' },
  );
  return { lists: data, error };
}

/** Every line of both lists, for resolving their cards against the viewer's DB. */
export function useListCardMaps(lists: UserListsData | null): CardMaps {
  return useCardMaps(useMemo(() => [...(lists?.tradelist ?? []), ...(lists?.wishlist ?? [])], [lists]));
}

/** Matcher over their wishlist lines (null = any printing of the card). */
type HaveFn = (wish: WishLine) => boolean;

/** My wishlist as a matcher over their tradelist lines (respects my prefs). */
export function useMyWants(): (line: TradeLine) => boolean {
  const wishes = useWishes() ?? EMPTY_WISHES;
  return useMemo(() => {
    const wanted = wishCountMatcher(wishes);
    return (line: TradeLine) => wanted(line) > 0;
  }, [wishes]);
}

/**
 * My collection as two matchers over their wishlist lines:
 *  - `have`: I already have it marked for trade (I'm offering it), and
 *  - `own`: I own a copy at all (whether or not it's on my tradelist).
 * Same printing rule as trades (a specific-printing wish matches only that
 * printing, an "any printing" wish matches every printing), and the copy must
 * also meet the wish's finish/condition/language preferences.
 */
export function useMyCollection(): { have: HaveFn; own: HaveFn } {
  const entries = useCollectionEntries() ?? EMPTY_ENTRIES;
  return useMemo(() => {
    const matcher = (rows: typeof entries): HaveFn => {
      const byOracle = new Map<string, typeof rows>();
      for (const e of rows) {
        const list = byOracle.get(e.oracleId) ?? [];
        list.push(e);
        byOracle.set(e.oracleId, list);
      }
      return (wish) => (byOracle.get(wish.oracleId) ?? []).some((e) => wishMatchesCopy(wish, e));
    };
    return { have: matcher(entries.filter((e) => e.quantityForTrade > 0)), own: matcher(entries) };
  }, [entries]);
}

/** Build the "has for trade" tile. `onOpen` fires only when the card resolves. */
export function tradeLineItem(
  line: TradeLine,
  key: string,
  cards: CardMaps,
  flags: { match: boolean; hi: boolean; showYear?: boolean },
  onOpen?: (oracle: Priced<OracleCard>) => void,
): CardItem {
  const oracle = cards.oracleMap?.get(line.oracleId);
  return {
    ...tradeLineCardItem(line, key, cards, { showYear: flags.showYear }),
    badge: flags.match ? (
      <>
        <Icon name="wishlist" size={11} /> you want this
      </>
    ) : undefined,
    badgeClass: `match-badge ${flags.hi ? 'badge-match' : 'own-trade'}`,
    badgeTitle: 'On your wishlist',
    onClick: oracle && onOpen ? () => onOpen(oracle) : undefined,
  };
}

/** Build the "wants" tile. `onOpen` fires only when the card resolves. */
export function wishLineItem(
  line: WishLine,
  key: string,
  cards: CardMaps,
  flags: { match: boolean; own: boolean; hi: boolean; showYear?: boolean },
  onOpen?: (oracle: Priced<OracleCard>) => void,
): CardItem {
  const oracle = cards.oracleMap?.get(line.oracleId);
  const printing = line.scryfallId ? cards.printMap?.get(line.scryfallId) : undefined;
  const detail = wishDetail(line);
  const printingSub = line.scryfallId ? (
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
  );
  return {
    ...baseCardItem({ key, oracle, printing, name: line.name, finish: line.finish, quantity: line.quantity, lang: line.lang, showYear: flags.showYear }),
    sub: detail ? (
      <>
        {printingSub} · {detail}
      </>
    ) : (
      printingSub
    ),
    badge: flags.match ? (
      <>
        <Icon name="trade" size={11} /> you have this
      </>
    ) : flags.own ? (
      <>
        <Icon name="check" size={11} /> you own this
      </>
    ) : undefined,
    badgeClass: `match-badge ${flags.hi ? 'badge-match' : flags.match ? 'own-trade' : 'own-yes'}`,
    badgeTitle: flags.match
      ? 'In your tradelist'
      : flags.own
        ? 'You own this but haven’t listed it for trade. Add it to your tradelist to offer it.'
        : undefined,
    onClick: oracle && onOpen ? () => onOpen(oracle) : undefined,
  };
}
