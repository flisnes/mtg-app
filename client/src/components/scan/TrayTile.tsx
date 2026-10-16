import { memo } from 'react';
import type { Candidate } from '../../scan/tray.js';
import { Icon } from '../icons.js';
import type { OwnedBadgeSpec } from '../OwnedBadge.js';
import { SetSymbol } from '../SetSymbol.js';

/** +1/−1 tap feedback on a tray tile; seq remounts the animation per tap. */
export interface TapFx {
  id: string;
  delta: 1 | -1;
  seq: number;
}

interface Props {
  candidate: Candidate;
  count: number;
  confirmed: boolean;
  owned: OwnedBadgeSpec | null;
  fx: TapFx | null;
  /** Stable across renders, so a tile only repaints when its own props change. */
  onBump: (c: Candidate, delta: 1 | -1) => void;
}

function TrayTileView({ candidate: c, count, confirmed, owned, fx, onBump }: Props) {
  const name = c.oracle?.name ?? 'Unknown card';
  return (
    <div className="scan-tile">
      <span className="scan-tile-caption">
        {c.printing ? (
          <>
            <SetSymbol set={c.printing.set} className="scan-tile-set" title={c.printing.setName} />
            {c.printing.set.toUpperCase()} #{c.printing.collectorNumber}
          </>
        ) : (
          '—'
        )}
      </span>
      <div className="scan-tile-card">
        {c.printing?.imageNormal ? <img src={c.printing.imageNormal} alt={name} /> : <div className="scan-tile-ph">{name}</div>}
        {owned && (
          <span className={`tile-badge ${owned.cls}`} title={owned.title}>
            {owned.icon}
          </span>
        )}
        <button className="scan-tile-half scan-tile-add" onClick={() => onBump(c, 1)} aria-label={`Add ${name}`}>
          <Icon name="plus" size={16} />
        </button>
        <button className="scan-tile-half scan-tile-sub" onClick={() => onBump(c, -1)} aria-label={`Remove ${name}`}>
          <Icon name="minus" size={16} />
        </button>
        {count > 0 && <span className="scan-tile-count">{count}</span>}
        {confirmed && (
          <span className="scan-tile-ocr" title="Edition confirmed">
            <Icon name="check" size={12} />
          </span>
        )}
        {fx && (
          <span key={fx.seq} className="scan-fx" aria-hidden>
            {fx.delta > 0 ? '+1' : '−1'}
          </span>
        )}
      </div>
    </div>
  );
}

// The hold bar and lock ring tick the scanner ten times a second; without this
// every tile re-rendered on every tick. The owned badge is rebuilt per render
// (its icon is an element), so it compares by what it says.
export const TrayTile = memo(
  TrayTileView,
  (a, b) =>
    a.candidate === b.candidate &&
    a.count === b.count &&
    a.confirmed === b.confirmed &&
    a.fx === b.fx &&
    a.onBump === b.onBump &&
    a.owned?.cls === b.owned?.cls &&
    a.owned?.title === b.owned?.title,
);
