import { useMemo, useState, type ReactNode } from 'react';
import type { OracleCard, Priced, Printing, TradeLine } from '@mtg/shared';
import type { SearchFilters } from '../cardDb/search.js';
import { useSetTypes } from '../cardDb/useSetTypes.js';
import { useCardMaps } from '../db/useCardMaps.js';
import { usePrefs } from '../usePrefs.js';
import type { SessionCardValues } from '../components/CardSheet.js';
import { CardSearchView, type ResultBadge } from '../components/CardSearchView.js';
import { CardList, StackToggle, useStackPrintings, type CardItem } from '../components/CardViews.js';
import { addToTotal, formatPrice, formatTotal, pricedForFinish, type PriceTotal } from '../components/CardSorting.js';
import { printingSub, tradeLineCardItem } from '../components/cardRows.js';
import { foldPicks, type WantFn } from './board.js';

type Compose = (card: Priced<OracleCard>, prefill?: Partial<SessionCardValues>) => void;

/** The sheet's starting values for a tradelist line: exactly that copy. */
const prefillOf = (l: TradeLine): Partial<SessionCardValues> => ({
  scryfallId: l.scryfallId,
  condition: l.condition,
  finish: l.finish,
  lang: l.lang,
});

/**
 * Add cards to one side of the offer. With no query it quick-picks from a
 * tradelist (yours for "you give", theirs for "you get"), wishlist matches
 * starred and sorted first, folded one row per card when stacking is on;
 * typing searches the whole card DB, for cards that aren't on the list. Every
 * pick opens the card sheet so edition, condition, finish, language and
 * quantity are confirmed before the card joins the offer.
 */
export function QuickPickPanel({
  lines,
  wanted,
  wantedText,
  intro,
  headerEnd,
  waiting,
  emptyText,
  placeholder,
  prefillFor,
  badgeFor,
  onCompose,
}: {
  /** The tradelist to pick from; null/undefined until it arrives. */
  lines: TradeLine[] | null | undefined;
  /** The other side's wishlist, as a counter over these lines. */
  wanted: WantFn;
  /** How a wishlist match reads, e.g. "they want ×2". */
  wantedText: (n: number) => string;
  intro: string;
  /** Beside the intro, before the stack toggle (a refresh chip). */
  headerEnd?: ReactNode;
  /** Shown while `lines` hasn't arrived. */
  waiting: string;
  emptyText: string;
  placeholder: string;
  /** The copy a search result should start from, when there's a better guess than the result's printing. */
  prefillFor: (oracleId: string) => Partial<SessionCardValues> | undefined;
  badgeFor?: (card: Priced<OracleCard>, printing?: Priced<Printing>) => ResultBadge | null;
  onCompose: Compose;
}) {
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<SearchFilters>({});
  // Lines reference cards by id; the local card DB has the display data.
  const cards = useCardMaps(lines ?? []);
  const [stacking, setStacking] = useStackPrintings();
  const prefs = usePrefs();
  const setTypes = useSetTypes(stacking);
  const rows = useMemo(
    () => foldPicks(lines ?? [], wanted, { stack: stacking, printMap: cards.printMap, prefs, setTypes }),
    [lines, wanted, stacking, cards.printMap, prefs, setTypes],
  );

  const compose = (card: Priced<OracleCard>, printing?: Priced<Printing>) =>
    onCompose(card, prefillFor(card.oracleId) ?? (printing ? { scryfallId: printing.scryfallId } : undefined));

  const emptyState = !lines ? (
    <p className="fine-print">{waiting}</p>
  ) : lines.length === 0 ? (
    <p className="fine-print">{emptyText}</p>
  ) : (
    <>
      <div className="meta-row">
        <span className="fine-print">{intro}</span>
        {headerEnd}
        <StackToggle on={stacking} onChange={setStacking} />
      </div>
      <CardList
        items={rows.map((row): CardItem => {
          const { lead } = row;
          const oracle = cards.oracleMap?.get(lead.oracleId);
          const printing = cards.printMap?.get(lead.scryfallId);
          const base = tradeLineCardItem({ ...lead, quantity: row.quantity }, row.key, cards);
          const stacked = row.members.length > 1;
          // A stack is worth the pile, as on every other stacked list.
          let price = formatPrice(pricedForFinish(printing, lead.finish));
          if (stacked) {
            const total: PriceTotal = { eur: 0, usd: 0 };
            for (const m of row.members) addToTotal(total, m.quantity, pricedForFinish(cards.printMap?.get(m.scryfallId), m.finish));
            price = formatTotal(total);
          }
          const kinds = row.editions > 1 ? `${row.editions} editions` : `${row.members.length} kinds`;
          const want = row.wanted > 0 ? wantedText(row.wanted) : undefined;
          return {
            ...base,
            foil: row.members.some((m) => m.finish !== 'nonfoil'),
            badge: want ? '⭐' : undefined,
            badgeClass: 'badge-wish',
            badgeTitle: want && want[0]!.toUpperCase() + want.slice(1),
            sub: (
              <>
                {stacked ? (
                  <>
                    <span className="stack-kinds">{kinds}</span>
                    {printing && ' · '}
                    {printing && printingSub(printing)}
                  </>
                ) : (
                  base.sub
                )}
                {` · ${row.quantity} for trade`}
                {want ? ` · ${want}` : ''}
              </>
            ),
            price,
            onClick: oracle ? () => onCompose(oracle, prefillOf(lead)) : undefined,
          };
        })}
      />
    </>
  );

  return (
    <CardSearchView
      query={q}
      onQueryChange={setQ}
      inputPlaceholder={placeholder}
      filters={filters}
      setFilters={setFilters}
      emptyState={emptyState}
      badgeFor={badgeFor}
      onCardClick={compose}
    />
  );
}
