import type { AcquisitionGain } from '../price/costBasis.js';
import type { HistoryChange } from '../price/history.js';
import { fmtMoney, fmtPriceIn } from '../price/rates.js';
import { Icon } from './icons.js';
import { Sparkline } from './Sparkline.js';

/**
 * Recorded price movement of one thing we track: sparkline plus how much it has
 * moved. Tapping it opens the full chart. Shared by the card sheet and the
 * sealed shelf — a box moves in price like a card does.
 *
 * The change is measured against what the copies cost, since that's the number
 * about your money. Where no price was recorded the basis is estimated from the
 * reading nearest the day you got the card, and the line says "since you got
 * it" rather than "since you paid" so the two aren't passed off as one. Only a
 * card we can't price at acquisition at all falls back to "since tracking
 * began", which is a fact about our archive and not about you.
 *
 * An estimate is marked "est." with the reason in the tooltip, and a foil whose
 * basis could only come from a nonfoil price says so outright: we archive
 * nonfoil prices only (see notes/foil-price-tracking.md), and a foil measured
 * against the plain version's price is not a number to act on.
 */
export function PriceTrend({
  trend,
  gain,
  nonfoilLine,
  onOpen,
}: {
  trend: HistoryChange;
  gain?: AcquisitionGain | null;
  /** The sparkline is the nonfoil series but the copy on show isn't nonfoil. */
  nonfoilLine?: boolean;
  onOpen: () => void;
}) {
  const delta = gain ? gain.delta : trend.delta;
  const pct = gain ? gain.pct : trend.pct;
  const dir = delta > 0.001 ? 'up' : delta < -0.001 ? 'down' : 'flat';
  const amount = gain ? fmtMoney(Math.abs(delta), gain.unit) : fmtPriceIn(Math.abs(delta), trend.cur);
  return (
    <button
      type="button"
      className="sheet-price-trend"
      onClick={onOpen}
      title={
        gain
          ? gain.crossFinish
            ? `Estimated at ${fmtMoney(gain.paid, gain.unit)} per copy from the nonfoil price, the only one we track day by day`
            : gain.estimated
              ? `Worth about ${fmtMoney(gain.paid, gain.unit)} per copy when you got it`
              : `You paid ${fmtMoney(gain.paid, gain.unit)} per copy`
          : nonfoilLine
            ? 'Open the full price chart. The tracked line is the nonfoil price.'
            : 'Open the full price chart'
      }
    >
      <Sparkline values={trend.series} width={64} />
      <div className={`price-change price-${dir}`}>
        {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·'} {amount}
        {pct != null && ` (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`}
        <span className="fine-print">
          {' · '}
          {gain ? (gain.estimated || gain.crossFinish ? 'since you got it (est.)' : 'since you paid') : `${trend.points} pts`}
        </span>
      </div>
      <Icon name="expand" size={14} />
    </button>
  );
}
