import type { ContainerKind, DeckBoard, Priced, Printing } from '@mtg/shared';
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
import { langMark } from './LangFlag.js';
import { specialMark } from './SpecialConditions.js';
import { NO_PRICE, formatPrice, formatTotal, pricedForFinish } from './CardSorting.js';
import { stackPlacement, type EntryStack } from './stackPrintings.js';

// One place that turns an owned entry (collection or wishlist) into a CardItem,
// shared by the list pages (Collection / Tradelist / Wishlist) and the scoped
// global search so a row looks the same wherever it appears. Keep these in sync
// with each other's fields — the whole point is that they don't drift.

type MoverFlags = ReturnType<typeof useMoverFlags>;
type Ownership = ReturnType<typeof useOwnershipIndex>;

/**
 * The release-year mark, and only while the list is actually sorted by release
 * date — the rest of the time the year is noise, and the set name in the
 * subtitle already says roughly when. A row with no printing pinned (an "any
 * printing" wish, a lands-box basic) has no year to show and gets nothing.
 */
export function yearMark(
  printing: { releasedAt: string; setName: string } | undefined,
  show: boolean | undefined,
): CardItem['year'] {
  if (!show || !printing) return undefined;
  return {
    node: printing.releasedAt.slice(0, 4),
    title: `${printing.setName} · released ${printing.releasedAt}`,
  };
}

/** A collection/tradelist row: printing + condition + finish, with a "for trade" badge. */
export function collectionCardItem(
  r: JoinedEntry,
  opts: { moverFlags?: MoverFlags; placements?: PlacementIndex; showYear?: boolean; onClick?: () => void },
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
  // Same per-copy logic: a flag belongs on the Italian copy, not on the row
  // above it that happens to be the same card in English.
  const lang = langMark(r.entry.lang);
  const year = yearMark(r.printing, opts.showYear);
  return {
    ...(place ? { place } : {}),
    ...(special ? { special } : {}),
    ...(lang ? { lang } : {}),
    ...(year ? { year } : {}),
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
        {lang ? ` · ${r.entry.lang}` : ''}
        {r.entry.special?.length ? ` · ${specialLabel(r.entry.special)}` : ''}
      </>
    ),
    price: formatPrice(pricedForFinish(r.printing, r.entry.finish), r.oracle) ?? NO_PRICE,
    trend: opts.moverFlags?.get(r.entry.scryfallId),
    onClick: opts.onClick,
  };
}

/**
 * A stack of collection rows as one tile: every copy of the card you own,
 * counted together, wearing the edition your printing preference picks out of
 * the ones you hold. Marks follow "any copy": the sheen if any is foil, the
 * flag if any is in another language, the A if any is altered, the filing
 * badge if any is in a deck. A stack of one row is exactly that row's item,
 * so the list looks the same with the toggle on and off wherever a card has
 * only one kind of copy.
 */
export function stackCardItem(
  s: EntryStack,
  opts: { moverFlags?: MoverFlags; placements?: PlacementIndex; showYear?: boolean; onClick?: () => void },
): CardItem {
  if (s.members.length === 1) return { ...collectionCardItem(s.members[0]!, opts), key: s.key };
  const place = placementBadge(stackPlacement(s, opts.placements));
  const special = specialMark(s.special);
  // The first language that isn't the one you collect in gets the flag.
  const lang = s.langs.map((l) => langMark(l)).find((m) => !!m);
  const year = yearMark(s.printing, opts.showYear);
  const trend = s.members.map((m) => opts.moverFlags?.get(m.entry.scryfallId)).find((t) => !!t);
  const kinds =
    s.printingCount > 1
      ? `${s.printingCount} editions`
      : `${s.members.length} kinds`;
  return {
    ...(place ? { place } : {}),
    ...(special ? { special } : {}),
    ...(lang ? { lang } : {}),
    ...(year ? { year } : {}),
    key: s.key,
    name: s.oracle?.name ?? '(unknown card)',
    image: s.printing?.imageSmall ?? s.oracle?.imageSmall ?? null,
    mana: s.oracle?.manaCost,
    foil: s.foil,
    count: s.quantity,
    badge:
      s.quantityForTrade > 0 ? (
        <>
          <Icon name="tradelist" size={12} />
          {s.quantityForTrade > 1 && <span className="badge-ft-count">{s.quantityForTrade}</span>}
        </>
      ) : undefined,
    badgeClass: 'badge-ft',
    badgeTitle: s.quantityForTrade > 0 ? `${s.quantityForTrade} for trade` : undefined,
    // "3 editions" leads: it's what makes this row a stack, and at the end it was
    // the part the ellipsis ate.
    sub: (
      <>
        <span className="stack-kinds" title={`${s.quantity} copies across ${kinds}; tap to see each`}>
          {kinds}
        </span>
        {s.printing && ' · '}
        {s.printing && <SetSymbol set={s.printing.set} className="sub-set-symbol" title={s.printing.setName} />}
        {s.printing ? `${s.printing.setName} · #${s.printing.collectorNumber}` : ''}
      </>
    ),
    // The pile's worth, not one copy's: ten Bolts is a number about ten Bolts.
    price: formatTotal(s.value),
    trend,
    onClick: opts.onClick,
  };
}

/** A wishlist row: a specific printing or "any printing", with an owned badge. */
export function wishCardItem(
  r: JoinedWish,
  opts: {
    ownership?: Ownership;
    moverFlags?: MoverFlags;
    showYear?: boolean;
    /** What an "any printing" wish looks like: the printing preference's pick
     *  (useDisplayPrintings), else the card DB's newest printing. */
    shown?: Priced<Printing>;
    onClick?: () => void;
  },
): CardItem {
  // A wish shows a specific printing, or the preferred one for "any printing".
  // The wishlist star is zeroed out here: every row on this list is a wish, so
  // the star would say nothing — same reason the collection doesn't checkmark
  // itself. What's worth knowing is whether you've since picked the card up.
  const shownAny = r.entry.scryfallId ? undefined : opts.shown;
  const own = opts.ownership?.lookup(r.entry.oracleId, r.entry.scryfallId ?? r.oracle?.defaultScryfallId);
  const ownBadge = ownedBadge(own && { ...own, wished: 0 });
  // A wish that pins a language you don't collect in flies its flag; one still
  // on "any language" says nothing, because anything would do.
  const lang = langMark(r.entry.lang);
  // Any finish/condition/lang the wish pins down (undefined = "any", shown as
  // nothing); condition is a minimum, and the language spells itself out only
  // when it's the one the flag is already flagging.
  const prefs = [
    r.entry.finish,
    r.entry.condition ? `min ${r.entry.condition}` : undefined,
    lang ? r.entry.lang : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const year = yearMark(r.printing, opts.showYear);
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
    image: r.printing?.imageSmall ?? shownAny?.imageSmall ?? r.oracle?.imageSmall ?? null,
    foil: !!r.entry.finish && r.entry.finish !== 'nonfoil',
    count: r.entry.quantity,
    ...(lang ? { lang } : {}),
    ...(year ? { year } : {}),
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
    // "Any printing" wishes are tracked via the printing they show.
    trend: opts.moverFlags?.get(r.entry.scryfallId ?? shownAny?.scryfallId ?? r.oracle?.defaultScryfallId ?? ''),
    onClick: opts.onClick,
  };
}

const BOARD_LABEL: Record<DeckBoard, string> = {
  main: '',
  side: 'Sideboard',
  commander: 'Commander',
  companion: 'Companion',
  maybe: 'Considering',
  token: 'Token',
};

/** A deck/binder/box slot: which board it's in (deck), or its printing (storage). */
export function deckCardItem(
  r: JoinedDeckCard,
  opts: { kind: ContainerKind; showYear?: boolean; onClick?: () => void },
): CardItem {
  // A slot that named a language: the flag says which copy this binder page or
  // deck list is actually asking for.
  const lang = langMark(r.entry.lang);
  const year = yearMark(r.printing, opts.showYear);
  return {
    key: r.entry.id,
    name: r.oracle?.name ?? '(unknown card)',
    image: r.printing?.imageSmall ?? r.oracle?.imageSmall ?? null,
    mana: r.oracle?.manaCost,
    foil: !!r.entry.finish && r.entry.finish !== 'nonfoil',
    count: r.entry.quantity,
    ...(lang ? { lang } : {}),
    ...(year ? { year } : {}),
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
    price: formatPrice(pricedForFinish(r.printing, r.entry.finish ?? 'nonfoil'), r.oracle) ?? NO_PRICE,
    onClick: opts.onClick,
  };
}
