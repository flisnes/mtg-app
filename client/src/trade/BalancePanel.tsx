import type { TradeLine } from '@mtg/shared';
import { useCardMaps } from '../db/useCardMaps.js';
import { fmtEur } from '../price/rates.js';
import { pricedForFinish } from '../components/CardSorting.js';
import { CardList, type CardItem } from '../components/CardViews.js';
import { tradeLineCardItem } from '../components/cardRows.js';
import { Loading } from '../components/Loading.js';
import { plural } from '../util/format.js';
import { BALANCE_EPSILON, lineKey, type OpenInfo, type Side, type WantFn } from './board.js';

/** A card that could help close the value gap. */
interface BalanceCandidate {
  key: string;
  /** One copy of the tradelist line. */
  line: TradeLine;
  /** The tradelist's quantity: an add never goes past it. */
  max: number;
  price: number;
  /** Copies still available (tradelist quantity minus copies already offered). */
  qty: number;
  /** Copies the receiving side's wishlist asks for (0 = no match). */
  wanted: number;
}

/**
 * Greedy best-fit: repeatedly pick the card that brings the remaining gap
 * closest to zero; stop when no card improves it. The pool is pre-sorted
 * wishlist-matches-first, so ties favor cards someone actually wants.
 */
function suggestBalance(gap: number, pool: BalanceCandidate[]): Map<string, number> {
  const picks = new Map<string, number>();
  let remaining = gap;
  for (let n = 0; n < 40; n++) {
    let best: BalanceCandidate | undefined;
    let bestAfter = Math.abs(remaining);
    for (const c of pool) {
      if ((picks.get(c.key) ?? 0) >= c.qty) continue;
      const after = Math.abs(remaining - c.price);
      if (after < bestAfter - 1e-9) {
        best = c;
        bestAfter = after;
      }
    }
    if (!best) break;
    picks.set(best.key, (picks.get(best.key) ?? 0) + 1);
    remaining -= best.price;
  }
  return picks;
}

/**
 * The scales tool: suggests cards from the lighter side's tradelist to even
 * out the value. Suggestions can be added straight to that side's column;
 * either participant may edit either side.
 */
export function BalancePanel({
  diff,
  myOffer,
  theirOffer,
  myTradelist,
  peerTradelist,
  theirWanted,
  myWanted,
  onAdd,
  onAddMany,
  onInfo,
}: {
  diff: number;
  myOffer: TradeLine[];
  theirOffer: TradeLine[];
  myTradelist: TradeLine[] | undefined;
  peerTradelist: TradeLine[] | null;
  theirWanted: WantFn;
  myWanted: WantFn;
  onAdd: (side: Side, line: TradeLine, max: number) => void;
  onAddMany: (side: Side, adds: Array<{ line: TradeLine; count: number; max: number }>) => void;
  onInfo: OpenInfo;
}) {
  const cards = useCardMaps([...(myTradelist ?? []), ...(peerTradelist ?? [])]);
  const { printMap, oracleMap } = cards;

  if (!printMap || !oracleMap || !myTradelist) return <Loading fine />;

  const gap = Math.abs(diff);
  if (gap < BALANCE_EPSILON) {
    return <p className="fine-print">This trade is already balanced (difference {fmtEur(gap)}).</p>;
  }
  const iGiveMore = diff > 0;
  if (iGiveMore && peerTradelist === null) {
    return <p className="fine-print">You’re giving more, but their tradelist hasn’t arrived yet. Try again in a moment.</p>;
  }

  // What's already in the lighter side's offer can't be suggested again.
  const offered = new Map<string, number>();
  for (const l of iGiveMore ? theirOffer : myOffer) {
    offered.set(lineKey(l), (offered.get(lineKey(l)) ?? 0) + l.quantity);
  }

  // The lighter side's tradelist, wanted by the heavier side's wishlist.
  const source = iGiveMore ? (peerTradelist ?? []) : myTradelist;
  const wantedBy = iGiveMore ? myWanted : theirWanted;
  const pool: BalanceCandidate[] = source
    .map((l): BalanceCandidate => ({
      key: lineKey(l),
      line: { ...l, quantity: 1 },
      max: l.quantity,
      price: pricedForFinish(printMap.get(l.scryfallId), l.finish)?.priceEur ?? 0,
      qty: l.quantity - (offered.get(lineKey(l)) ?? 0),
      wanted: wantedBy(l),
    }))
    .filter((c) => c.qty > 0 && c.price > 0)
    .sort((a, b) => b.wanted - a.wanted || b.price - a.price);

  const picks = suggestBalance(gap, pool);
  const suggestions = pool.filter((c) => picks.has(c.key));
  if (suggestions.length === 0) {
    return (
      <p className="fine-print">
        Nothing on {iGiveMore ? 'their' : 'your'} tradelist (with a known price) can close the {fmtEur(gap)} gap.
      </p>
    );
  }

  const pickCount = suggestions.reduce((s, c) => s + picks.get(c.key)!, 0);
  const pickedTotal = suggestions.reduce((s, c) => s + c.price * picks.get(c.key)!, 0);
  const after = Math.abs(gap - pickedTotal);
  const lightSide: Side = iGiveMore ? 'get' : 'give';

  return (
    <>
      <p className="fine-print">
        {iGiveMore ? (
          <>
            You’re giving <strong>{fmtEur(gap)}</strong> more. From <strong>their</strong> tradelist, you could add
            to what you get:
          </>
        ) : (
          <>
            You’re getting <strong>{fmtEur(gap)}</strong> more. From <strong>your</strong> tradelist, you could add
            to what you give:
          </>
        )}
      </p>
      <CardList
        className="picker-scroll"
        items={suggestions.map((c): CardItem => {
          const oracle = oracleMap.get(c.line.oracleId);
          return {
            ...tradeLineCardItem(c.line, c.key, cards),
            count: picks.get(c.key),
            badge: c.wanted > 0 ? '⭐' : undefined,
            badgeClass: 'badge-wish',
            badgeTitle:
              c.wanted > 0 ? (iGiveMore ? `On your wishlist (×${c.wanted})` : `They want ×${c.wanted}`) : undefined,
            price: fmtEur(c.price),
            onClick: oracle ? () => onInfo(oracle, c.line.scryfallId, { side: lightSide }) : undefined,
            actions: (
              <button
                title={iGiveMore ? 'Add to what you get' : 'Add to what you give'}
                onClick={() => onAdd(lightSide, c.line, c.max)}
              >
                ＋
              </button>
            ),
          };
        })}
      />
      <p className="fine-print">
        Adds {fmtEur(pickedTotal)}, bringing the difference from {fmtEur(gap)} down to {fmtEur(after)}. Prices are
        estimates based on Scryfall’s EUR figures; unpriced cards are skipped.
      </p>
      <button
        className="primary"
        onClick={() => onAddMany(lightSide, suggestions.map((c) => ({ line: c.line, count: picks.get(c.key)!, max: c.max })))}
      >
        Add all ({pickCount} {plural(pickCount, 'card')})
      </button>
    </>
  );
}
