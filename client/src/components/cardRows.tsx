import type { ContainerKind, DeckBoard } from '@mtg/shared';
import { specialLabel } from '@mtg/shared';
import type { JoinedEntry, JoinedWish, JoinedDeckCard } from '../db/queries.js';
import type { CardItem } from './CardViews.js';
import type { useMoverFlags } from '../price/useMoverFlags.js';
import type { useOwnershipIndex } from '../db/useOwnership.js';
import type { PlacementIndex } from '../db/usePlacements.js';
import { Icon } from './icons.js';
import { SetSymbol } from './SetSymbol.js';
import { ownedBadge } from './OwnedBadge.js';
import { placementBadge } from './PlacementBadge.js';
import { specialMark } from './SpecialConditions.js';
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
  opts: { moverFlags?: MoverFlags; placements?: PlacementIndex; onClick?: () => void },
): CardItem {
  // Per copy: the badge belongs on the card that's actually filed away, not on
  // every edition — nor on your English copy when it's the Spanish one that's in
  // the deck.
  const place = placementBadge(
    opts.placements?.lookup(r.entry.oracleId, r.entry.scryfallId, {
      condition: r.entry.condition,
      finish: r.entry.finish,
      lang: r.entry.lang,
    }),
  );
  // Altered / signed / misprint: per copy again, and the reason this row exists
  // at all rather than being folded into the plain one.
  const special = specialMark(r.entry.special);
  return {
    ...(place ? { place } : {}),
    ...(special ? { special } : {}),
    key: r.entry.id,
    name: r.oracle?.name ?? '(unknown card)',
    image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
    mana: r.oracle?.manaCost,
    foil: r.entry.finish !== 'nonfoil',
    count: r.entry.quantity,
    // Tradelist glyph + how many copies are up for grabs, same shape as the
    // "filed" badge next to it.
    badge:
      r.entry.quantityForTrade > 0 ? (
        <>
          <Icon name="tradelist" size={12} />
          {r.entry.quantityForTrade > 1 && (
            <span className="badge-ft-count">{r.entry.quantityForTrade}</span>
          )}
        </>
      ) : undefined,
    badgeClass: 'badge-ft',
    badgeTitle: r.entry.quantityForTrade > 0 ? `${r.entry.quantityForTrade} for trade` : undefined,
    sub: (
      <>
        {r.printing && <SetSymbol set={r.printing.set} className="sub-set-symbol" title={r.printing.setName} />}
        {r.printing ? `${r.printing.setName} · #${r.printing.collectorNumber} · ` : ''}
        {r.entry.condition} · {r.entry.finish}
        {r.entry.lang !== 'en' ? ` · ${r.entry.lang}` : ''}
        {r.entry.special?.length ? ` · ${specialLabel(r.entry.special)}` : ''}
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
  // The wishlist star is zeroed out here: every row on this list is a wish, so
  // the star would say nothing — same reason the collection doesn't checkmark
  // itself. What's worth knowing is whether you've since picked the card up.
  const own = opts.ownership?.lookup(r.entry.oracleId, r.entry.scryfallId ?? r.oracle?.defaultScryfallId);
  const ownBadge = ownedBadge(own && { ...own, wished: 0 });
  // Any finish/condition/lang the wish pins down (undefined = "any", shown as
  // nothing); condition is a minimum, English is the norm (only shown if not).
  const prefs = [
    r.entry.finish,
    r.entry.condition ? `min ${r.entry.condition}` : undefined,
    r.entry.lang && r.entry.lang !== 'en' ? r.entry.lang : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const printingSub = r.entry.scryfallId ? (
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
  );
  return {
    key: r.entry.id,
    name: r.oracle?.name ?? '(unknown card)',
    image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
    foil: !!r.entry.finish && r.entry.finish !== 'nonfoil',
    count: r.entry.quantity,
    badge: ownBadge?.icon,
    badgeClass: ownBadge?.cls,
    badgeTitle: ownBadge?.title,
    sub: prefs ? (
      <>
        {printingSub} · {prefs}
      </>
    ) : (
      printingSub
    ),
    // "Any printing" wishes are tracked via the oracle's default printing.
    trend: opts.moverFlags?.get(r.entry.scryfallId ?? r.oracle?.defaultScryfallId ?? ''),
    onClick: opts.onClick,
  };
}

const BOARD_LABEL: Record<DeckBoard, string> = { main: '', side: 'Sideboard', commander: 'Commander', token: 'Token' };

/** A deck/binder/box slot: which board it's in (deck), or its printing (storage). */
export function deckCardItem(r: JoinedDeckCard, opts: { kind: ContainerKind; onClick?: () => void }): CardItem {
  return {
    key: r.entry.id,
    name: r.oracle?.name ?? '(unknown card)',
    image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
    mana: r.oracle?.manaCost,
    foil: !!r.entry.finish && r.entry.finish !== 'nonfoil',
    count: r.entry.quantity,
    sub:
      opts.kind === 'deck' ? (
        BOARD_LABEL[r.entry.board] || undefined
      ) : r.entry.anyBasic ? (
        'any printing'
      ) : (
        r.printing && (
          <>
            <SetSymbol set={r.printing.set} className="sub-set-symbol" title={r.printing.setName} />
            {r.printing.setName} · #{r.printing.collectorNumber}
          </>
        )
      ),
    price: formatPrice(pricedForFinish(r.printing, r.entry.finish ?? 'nonfoil'), r.oracle) ?? '—',
    onClick: opts.onClick,
  };
}
