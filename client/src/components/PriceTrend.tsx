import type { HistoryChange } from '../price/history.js';
import { fmtPriceIn } from '../price/rates.js';
import { Icon } from './icons.js';
import { Sparkline } from './Sparkline.js';

/**
 * Recorded price movement of one thing we track: sparkline plus the change
 * since tracking began. Tapping it opens the full chart. Shared by the card
 * sheet and the sealed shelf — a box moves in price like a card does.
 */
export function PriceTrend({ trend, onOpen }: { trend: HistoryChange; onOpen: () => void }) {
  const dir = trend.delta > 0.001 ? 'up' : trend.delta < -0.001 ? 'down' : 'flat';
  return (
    <button type="button" className="sheet-price-trend" onClick={onOpen} title="Open the full price chart">
      <Sparkline values={trend.series} width={64} />
      <div className={`price-change price-${dir}`}>
        {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {fmtPriceIn(Math.abs(trend.delta), trend.cur)}
        {trend.pct != null && ` (${trend.pct >= 0 ? '+' : '−'}${Math.abs(trend.pct).toFixed(1)}%)`}
        <span className="fine-print"> · {trend.points} pts</span>
      </div>
      <Icon name="expand" size={14} />
    </button>
  );
}
