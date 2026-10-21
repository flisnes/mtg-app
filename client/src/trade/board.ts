import { useMemo } from 'react';
import type { CollectionEntry, HeldCopy, OracleCard, Priced, Printing, SetTypeMap, TradeLine } from '@mtg/shared';
import { collectionKey } from '../db/keys.js';
import type { JoinedEntry } from '../db/queries.js';
import { useJoinedCollection } from '../db/collectionSnapshot.js';
import type { OwnershipIndex } from '../db/useOwnership.js';
import { ownedBadge, type OwnedBadgeSpec } from '../components/OwnedBadge.js';
import { foldByOracle } from '../components/stackPrintings.js';
import { sumQty } from '../util/groupBy.js';
import type { Prefs } from '../prefs.js';

// The trade board's shared vocabulary: which column, how lines are keyed, who
// wants what, and the own-tradelist-as-TradeLines view the pickers and the
// balance tool both read. Pure apart from the one hook at the bottom.

/** Offer lines merge on the same compound key as collection entries. */
export const lineKey = collectionKey;

/** Which column an add/scan/balance action targets: 'give' = my offer, 'get' = theirs. */
export type Side = 'give' | 'get';

/**
 * What the card-info sheet should show when a card is tapped. `side` says whose
 * printings to highlight in the edition dropdown ('give' = my collection,
 * 'get' = their tradelist).
 */
export type InfoCtx = { side: Side };
export type InfoTarget = { oracle: Priced<OracleCard>; scryfallId?: string; ctx?: InfoCtx };
export type OpenInfo = (oracle: Priced<OracleCard>, scryfallId?: string, ctx?: InfoCtx) => void;

/** How many copies a wishlist wants of a given card (0 = no match). */
export type WantFn = (have: HeldCopy) => number;

/** Values below this (EUR) count as "the trade is even". */
export const BALANCE_EPSILON = 0.5;

/** Add-default preference: for-trade copies beat idle ones, then more copies win. */
function betterAddDefault(a: CollectionEntry, b: CollectionEntry): boolean {
  const at = a.quantityForTrade > 0 ? 1 : 0;
  const bt = b.quantityForTrade > 0 ? 1 : 0;
  return at !== bt ? at > bt : a.quantity > b.quantity;
}

/** The best entry to seed an add with (prefers for-trade copies, then the printing with most copies). */
export function bestAddDefault(entries: CollectionEntry[]): CollectionEntry | undefined {
  let best: CollectionEntry | undefined;
  for (const e of entries) if (!best || betterAddDefault(e, best)) best = e;
  return best;
}

/** Their highest-quantity tradelist line for an oracle: the best printing guess for "you get". */
export function bestPeerLine(lines: TradeLine[] | null, oracleId: string): TradeLine | undefined {
  let best: TradeLine | undefined;
  for (const l of lines ?? []) {
    if (l.oracleId === oracleId && (!best || l.quantity > best.quantity)) best = l;
  }
  return best;
}

/** The shared ownership checkmark for a card I might give (own exact/other, or for trade). */
export function ownIndicator(ownership: OwnershipIndex | undefined, oracleId: string, scryfallId?: string): OwnedBadgeSpec | null {
  if (!ownership) return null;
  const s = ownership.lookup(oracleId, scryfallId);
  // No wishlist rung: this is the "you give" side, so what you're after is
  // beside the point (the "you get" panel stars its own wishlist matches).
  return ownedBadge({ qty: s.qty, forTrade: s.forTrade, ownsExact: s.ownsExact, wished: 0 });
}

/**
 * My tradelist in the shape a partner sees it: one line per offer key, with
 * the for-trade count as its quantity. Rows that differ only by a special
 * condition share a key, so they merge here the way they would in an offer.
 */
export function ownTradeLines(rows: JoinedEntry[]): TradeLine[] {
  const byKey = new Map<string, TradeLine>();
  for (const { entry: e, oracle } of rows) {
    if (e.quantityForTrade <= 0) continue;
    const key = lineKey(e);
    const cur = byKey.get(key);
    if (cur) cur.quantity += e.quantityForTrade;
    else
      byKey.set(key, {
        oracleId: e.oracleId,
        scryfallId: e.scryfallId,
        name: oracle?.name ?? '(unknown card)',
        quantity: e.quantityForTrade,
        condition: e.condition,
        finish: e.finish,
        lang: e.lang,
      });
  }
  return [...byKey.values()];
}

/** Your tradelist as TradeLines, off the shared snapshot. */
export function useOwnTradeLines(): TradeLine[] | undefined {
  const joined = useJoinedCollection();
  return useMemo(() => (joined ? ownTradeLines(joined) : undefined), [joined]);
}

/** One row of a quick-pick list: a tradelist line, or every line of one card. */
export interface PickRow {
  /** The line key for one line; `s:<oracleId>` for a stack. */
  key: string;
  /** The line on the tile and the one a tap composes from. */
  lead: TradeLine;
  /** Every line folded in, lead first. */
  members: TradeLine[];
  /** Copies for trade, summed. */
  quantity: number;
  /** The most any one member is wanted (members match the same wishes). */
  wanted: number;
  editions: number;
}

/**
 * The quick-pick list: tradelist lines, folded into one row per card when
 * stacking is on (the lead is the preferred printing among the ones listed,
 * then the line with most copies), wishlist matches first.
 */
export function foldPicks(
  lines: TradeLine[],
  wanted: WantFn,
  opts: {
    stack: boolean;
    printMap: Map<string, Priced<Printing>> | undefined;
    prefs: Pick<Prefs, 'printing' | 'baseCurrency'>;
    setTypes: SetTypeMap | null;
  },
): PickRow[] {
  const single = (l: TradeLine, key = lineKey(l)): PickRow => ({
    key,
    lead: l,
    members: [l],
    quantity: l.quantity,
    wanted: wanted(l),
    editions: 1,
  });
  const rows: PickRow[] = !opts.stack
    ? lines.map((l) => single(l))
    : foldByOracle(lines, {
        oracleIdOf: (l) => l.oracleId,
        printingOf: (l) => opts.printMap?.get(l.scryfallId),
        scryfallIdOf: (l) => l.scryfallId,
        prefs: opts.prefs,
        setTypes: opts.setTypes,
      }).map(({ oracleId, members, shown, printingCount }) => {
        if (members.length === 1) return single(members[0]!, `s:${oracleId}`);
        const pool = shown ? members.filter((m) => m.scryfallId === shown.scryfallId) : members;
        const lead = (pool.length ? pool : members).reduce((a, b) => (b.quantity > a.quantity ? b : a));
        return {
          key: `s:${oracleId}`,
          lead,
          members: [lead, ...members.filter((m) => m !== lead)],
          quantity: sumQty(members),
          wanted: Math.max(...members.map(wanted)),
          editions: printingCount,
        };
      });
  return rows.sort((a, b) => b.wanted - a.wanted);
}
