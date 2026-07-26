import type { JoinedEntry, JoinedWish } from '../db/queries.js';
import type { CardItem } from './CardViews.js';
import type { useMoverFlags } from '../price/useMoverFlags.js';
import type { useOwnershipIndex } from '../db/useOwnership.js';
import { SetSymbol } from './SetSymbol.js';
import { ownedBadge } from './OwnedBadge.js';
import { formatPrice, pricedForFinish } from './CardSorting.js';

// One place that turns an owned entry (collection or wishlist) into a CardItem,
// shared by the list pages (Collection / Tradelist / Wishlist) and the scoped
// global search so a row looks the same wherever it appears. Keep these in sync
// with each other's fields — the whole point is that they don't drift.

type MoverFlags = ReturnType<typeof useMoverFlags>;
type Ownership = ReturnType<typeof useOwnershipIndex>;

/** A collection/tradelist row: printing + condition + finish, with a "for trade" badge. */
export function collectionCardItem(
  r: JoinedEntry,
  opts: { moverFlags?: MoverFlags; onClick?: () => void },
): CardItem {
  return {
    key: r.entry.id,
    name: r.oracle?.name ?? '(unknown card)',
    image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
    mana: r.oracle?.manaCost,
    foil: r.entry.finish !== 'nonfoil',
    count: r.entry.quantity,
    badge: r.entry.quantityForTrade > 0 ? `${r.entry.quantityForTrade} FT` : undefined,
    badgeClass: 'badge-trade',
    badgeTitle: r.entry.quantityForTrade > 0 ? `${r.entry.quantityForTrade} for trade` : undefined,
    sub: (
      <>
        {r.printing && <SetSymbol set={r.printing.set} className="sub-set-symbol" title={r.printing.setName} />}
        {r.printing ? `${r.printing.setName} · #${r.printing.collectorNumber} · ` : ''}
        {r.entry.condition} · {r.entry.finish}
        {r.entry.lang !== 'en' ? ` · ${r.entry.lang}` : ''}
      </>
    ),
    price: formatPrice(pricedForFinish(r.printing, r.entry.finish), r.oracle) ?? '—',
    trend: opts.moverFlags?.get(r.entry.scryfallId),
    onClick: opts.onClick,
  };
}

/** A wishlist row: a specific printing or "any printing", with an owned badge. */
export function wishCardItem(
  r: JoinedWish,
  opts: { ownership?: Ownership; moverFlags?: MoverFlags; onClick?: () => void },
): CardItem {
  // A wish shows a specific printing, or the oracle's default for "any printing".
  const ownBadge = ownedBadge(
    opts.ownership?.lookup(r.entry.oracleId, r.entry.scryfallId ?? r.oracle?.defaultScryfallId),
  );
  return {
    key: r.entry.id,
    name: r.oracle?.name ?? '(unknown card)',
    image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
    count: r.entry.quantity,
    badge: ownBadge?.icon,
    badgeClass: ownBadge?.cls,
    badgeTitle: ownBadge?.title,
    sub: r.entry.scryfallId ? (
      r.printing ? (
        <>
          <SetSymbol set={r.printing.set} className="sub-set-symbol" title={r.printing.setName} />
          {`${r.printing.setName} · #${r.printing.collectorNumber}`}
        </>
      ) : (
        'specific printing'
      )
    ) : (
      'any printing'
    ),
    // "Any printing" wishes are tracked via the oracle's default printing.
    trend: opts.moverFlags?.get(r.entry.scryfallId ?? r.oracle?.defaultScryfallId ?? ''),
    onClick: opts.onClick,
  };
}
