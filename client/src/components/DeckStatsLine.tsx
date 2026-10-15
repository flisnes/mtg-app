import { Icon } from './icons.js';
import type { DeckManaStats } from '../deck/manaStats.js';
import { plural } from '../util/format.js';

// Lives apart from DeckAnalysis.tsx on purpose: the deck page only needs this
// one tappable line, and importing it from DeckAnalysis would drag the whole
// analysis module (sim engine, every panel) into the main bundle — the
// analysis page itself is lazy-loaded.


/** One tappable line under the legality panel: the headline, and the way in. */
export function DeckStatsLine({ stats, onOpen }: { stats: DeckManaStats; onOpen: () => void }) {
  return (
    <button type="button" className="deck-stats-line" onClick={onOpen} aria-label="Open deck analysis">
      <span className="deck-stats-bits">
        <span>
          <strong>{stats.lands}</strong> {plural(stats.lands, 'land')}
        </span>
        {stats.hasManaData && stats.tappedAlways > 0 && <span>{stats.tappedAlways} enter tapped</span>}
        <span className={`deck-stats-tone tone-${stats.land.tone}`}>{stats.land.short}</span>
      </span>
      <Icon name="chevronRight" />
    </button>
  );
}
