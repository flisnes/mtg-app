import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  wishMatchesCopy,
  type OracleCard,
  type Priced,
  type Printing,
  type TradeLine,
  type WishLine,
} from '@mtg/shared';
import { ApiError, getUserLists } from '../account/api.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { Icon } from '../components/icons.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { sanitizePublicTradelist, sanitizePublicWishlist } from '../trade/validate.js';
import type { CardItem } from '../components/CardViews.js';

// Shared machinery for viewing another user's published trade/wishlist: the
// fetch + card-DB resolution, the "does this match my own stuff" matchers, and
// the row builders. Used by the Community page and by the global search when it
// scopes into the profile you're browsing.

/** Resolved card-DB data for the lines we're showing, from the viewer's local DB. */
export interface CardMaps {
  oracles: Map<string, Priced<OracleCard>>;
  printings: Map<string, Priced<Printing>>;
}

export interface UserListsData {
  updatedAt: number;
  tradelist: TradeLine[];
  wishlist: WishLine[];
}

/** The card-info sheet target: an oracle card, optionally pinned to a printing.
 *  For a wishlist tile, `wish` carries their preferences so the sheet can show
 *  them read-only (any printing / min condition / finish / language). */
export type InfoTarget = { oracle: Priced<OracleCard>; scryfallId?: string; wish?: WishLine };

export function lineDetail(l: TradeLine): string {
  const bits: string[] = [l.condition];
  if (l.finish !== 'nonfoil') bits.push(l.finish);
  if (l.lang !== 'en') bits.push(l.lang);
  return bits.join(' · ');
}

/** A wish's preferences, spelled out for a trade partner (empty = no prefs). */
export function wishDetail(l: WishLine): string {
  const bits: string[] = [];
  if (l.finish && l.finish !== 'nonfoil') bits.push(l.finish);
  if (l.condition) bits.push(`min ${l.condition}`);
  if (l.lang && l.lang !== 'en') bits.push(l.lang);
  return bits.join(' · ');
}

/** Fetch + sanitize another user's published lists. Untrusted input, same as trade shares. */
export function useUserLists(token: string, username: string): { lists: UserListsData | null; error: string | null } {
  const [lists, setLists] = useState<UserListsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLists(null);
    setError(null);
    getUserLists(token, username)
      .then((res) => {
        if (cancelled) return;
        setLists({
          updatedAt: res.updatedAt,
          tradelist: sanitizePublicTradelist(res.tradelist),
          wishlist: sanitizePublicWishlist(res.wishlist),
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.friendlyMessage : 'Could not load lists.');
      });
    return () => {
      cancelled = true;
    };
  }, [token, username]);
  return { lists, error };
}

/** Resolve images and set/printing detail from the viewer's own synced card DB. */
export function useResolvedCards(lists: UserListsData | null): CardMaps | undefined {
  return useLiveQuery<CardMaps>(async () => {
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
}

/** Matcher over their wishlist lines (null = any printing of the card). */
export type HaveFn = (wish: WishLine) => boolean;

/** My wishlist as a matcher over their tradelist lines (respects my prefs). */
export function useMyWants(): (line: TradeLine) => boolean {
  const wishes = useLiveQuery(() => db.wishlist.toArray(), [], []);
  return useMemo(() => {
    const byOracle = new Map<string, typeof wishes>();
    for (const w of wishes) {
      const list = byOracle.get(w.oracleId) ?? [];
      list.push(w);
      byOracle.set(w.oracleId, list);
    }
    return (line: TradeLine) => (byOracle.get(line.oracleId) ?? []).some((w) => wishMatchesCopy(w, line));
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
  const entries = useLiveQuery(() => db.collection.toArray(), [], []);
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
  cards: CardMaps | undefined,
  flags: { match: boolean; hi: boolean },
  onOpen?: (oracle: Priced<OracleCard>) => void,
): CardItem {
  const oracle = cards?.oracles.get(line.oracleId);
  const printing = cards?.printings.get(line.scryfallId);
  return {
    key,
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
  cards: CardMaps | undefined,
  flags: { match: boolean; own: boolean; hi: boolean },
  onOpen?: (oracle: Priced<OracleCard>) => void,
): CardItem {
  const oracle = cards?.oracles.get(line.oracleId);
  const printing = line.scryfallId ? cards?.printings.get(line.scryfallId) : undefined;
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
    key,
    name: oracle?.name ?? line.name,
    image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
    foil: !!line.finish && line.finish !== 'nonfoil',
    count: line.quantity,
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
