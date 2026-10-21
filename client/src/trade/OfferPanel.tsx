import type { ReactNode } from 'react';
import type { OracleCard, Priced, TradeLine } from '@mtg/shared';
import type { CardMaps } from '../db/useCardMaps.js';
import { fmtEur } from '../price/rates.js';
import { NO_PRICE, formatPrice, pricedForFinish } from '../components/CardSorting.js';
import { CardItems, type CardItem, type ViewMode } from '../components/CardViews.js';
import { tradeLineCardItem } from '../components/cardRows.js';
import { Icon } from '../components/icons.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { QtyStepper } from '../components/QtyStepper.js';
import { lineKey, type OpenInfo, type Side } from './board.js';

/**
 * One side of the board: title + running total, the card tiles, and the
 * add/scan actions. Both sides are editable: you usually hold each other's
 * binders, so adding to "You get" is as normal as adding to "You give".
 */
export function OfferPanel({
  side,
  title,
  total,
  lines,
  empty,
  editable,
  onQty,
  onAdd,
  onScan,
  badge,
  cards,
  onInfo,
  onEdit,
  view,
}: {
  side: Side;
  title: string;
  total: number;
  lines: TradeLine[];
  empty: string;
  editable: boolean;
  onQty: (side: Side, key: string, qty: number) => void;
  onAdd: () => void;
  onScan: () => void;
  /** Per-line indicator: ownership for "You give", wishlist match for "You get". */
  badge: (l: TradeLine) => { icon: ReactNode; cls?: string; title?: string } | null;
  cards: CardMaps;
  /** Read-only card info (locked trades). */
  onInfo: OpenInfo;
  /** Tap a line in an editable trade: open the full edit sheet for it. */
  onEdit: (side: Side, line: TradeLine, oracle: Priced<OracleCard>) => void;
  /** Card tiles or visual stacks, chosen for the whole board. */
  view: ViewMode;
}) {
  return (
    <section className="trade-col" aria-label={`Cards ${title.toLowerCase()}`}>
      <header className="trade-col-head">
        <h3>{title}</h3>
        <span className="trade-col-total" aria-label={`Total ${title.toLowerCase()}`}>
          {fmtEur(total)}
        </span>
      </header>
      <div className="trade-col-list">
        {lines.length === 0 ? (
          <p className="trade-empty">{empty}</p>
        ) : (
          <CardItems
            view={view}
            items={lines.map((l): CardItem => {
              const ind = badge(l);
              const key = lineKey(l);
              const printing = cards.printMap?.get(l.scryfallId);
              const oracle = cards.oracleMap?.get(l.oracleId);
              const price = formatPrice(pricedForFinish(printing, l.finish));
              return {
                // The flag earns its keep most here: your partner hands you a
                // card and you want to know it's the Spanish one before you take
                // it, not after. Stacks show the card's own title bar at close
                // to full size, where the small scan turns to mush.
                ...tradeLineCardItem(l, key, cards, { image: view === 'stack' ? printing?.imageNormal : undefined }),
                badge: ind?.icon,
                badgeClass: ind?.cls,
                badgeTitle: ind?.title,
                sub: printing ? (
                  <>
                    <SetSymbol set={printing.set} title={printing.setName} />
                    <span className="stack-setname">{printing.setName}</span>
                  </>
                ) : undefined,
                price: price ?? NO_PRICE,
                onClick: oracle
                  ? () => (editable ? onEdit(side, l, oracle) : onInfo(oracle, l.scryfallId, { side }))
                  : undefined,
                // The row and the stack both show the price beside the card, so
                // the stepper keeps the quantity between its buttons in either view.
                actions: editable ? (
                  <QtyStepper compact value={l.quantity} min={0} onChange={(v) => onQty(side, key, v)} label={l.name} />
                ) : undefined,
              };
            })}
          />
        )}
      </div>
      {editable && (
        <div className="trade-col-actions">
          <button className="trade-add" onClick={onAdd}>
            <Icon name="plus" size={15} /> Add
          </button>
          <button className="trade-add" onClick={onScan}>
            <Icon name="camera" size={15} /> Scan
          </button>
        </div>
      )}
    </section>
  );
}
