import type { Trade } from '@mtg/shared';
import { MenuRow } from '../components/MenuRow.js';
import { fmtDateTime } from '../util/format.js';
import { sumQty } from '../util/groupBy.js';

/** One completed trade: who with, when, and how many cards went each way. */
export function TradeRow({ trade, to, onClick }: { trade: Trade; to?: string; onClick?: () => void }) {
  return (
    <MenuRow
      to={to}
      onClick={onClick}
      icon="trade"
      label={
        <>
          Trade with {trade.partner ?? 'Other User'}
          <span className="badge">
            −{sumQty(trade.given)} / +{sumQty(trade.received)}
          </span>
        </>
      }
      plain
      note={fmtDateTime(trade.completedAt)}
    />
  );
}
