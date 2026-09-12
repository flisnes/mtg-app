import type { DeckFormat } from '@mtg/shared';
import { Sheet } from './Sheet.js';
import { Icon } from './icons.js';
import { CURVE_MAX, TAX_TURNS, type DeckManaStats } from '../deck/manaStats.js';
import { DrawOddsPanel } from './DrawOddsPanel.js';
import { ColorSourcesPanel } from './ColorSourcesPanel.js';
import { MulliganPanel } from './MulliganPanel.js';
import { librarySize, type GroupRow } from '../analysis/groups.js';

// What the deck's mana looks like before a single card is drawn: the curve, the
// tempo the tapped lands cost you, and whether there are enough lands for what
// you're casting. Arithmetic only — see deck/manaStats.ts for the model and its
// deliberate omissions.
//
// It lives in a sheet rather than on the deck page because the deck page is a
// decklist, and because the analysis phases after this one (odds by turn N, the
// colored-source report, the mulligan table) all want to land here beside it.

const one = (n: number) => n.toFixed(1);
const plural = (n: number) => (n === 1 ? '' : 's');

/** One tappable line under the legality panel: the headline, and the way in. */
export function DeckStatsLine({ stats, onOpen }: { stats: DeckManaStats; onOpen: () => void }) {
  return (
    <button type="button" className="deck-stats-line" onClick={onOpen} aria-label="Open deck stats">
      <span className="deck-stats-bits">
        <span>
          <strong>{stats.lands}</strong> land{plural(stats.lands)}
        </span>
        {stats.hasManaData && stats.tappedAlways > 0 && <span>{stats.tappedAlways} enter tapped</span>}
        <span className={`deck-stats-tone tone-${stats.land.tone}`}>{stats.land.short}</span>
      </span>
      <Icon name="chevronRight" />
    </button>
  );
}

function Curve({ stats }: { stats: DeckManaStats }) {
  const peak = Math.max(1, ...stats.curve.map((b) => b.count));
  return (
    <div className="curve" role="img" aria-label={curveLabel(stats)}>
      {stats.curve.map((b) => (
        <div key={b.mv} className="curve-col">
          <span className="curve-count">{b.count || ''}</span>
          {/* A floor of 2px so an empty slot still reads as a slot rather than
              as a gap in the axis. */}
          <div className="curve-bar" style={{ height: `${(b.count / peak) * 100}%` }} />
          <span className="curve-tick">{b.mv === CURVE_MAX ? `${CURVE_MAX}+` : b.mv}</span>
        </div>
      ))}
    </div>
  );
}

function curveLabel(stats: DeckManaStats): string {
  const bits = stats.curve.filter((b) => b.count > 0).map((b) => `${b.mv === CURVE_MAX ? `${CURVE_MAX} or more` : b.mv}: ${b.count}`);
  return `Mana curve. ${bits.join(', ')}.`;
}

/** The tapland paragraph, which has four genuinely different things to say. */
function taplandText(stats: DeckManaStats): string {
  const { tappedAlways: always, tappedMaybe: maybe, lands } = stats;
  if (always === 0 && maybe === 0) return `None of your ${lands} lands enter tapped. Nothing to pay here.`;
  if (always === 0) {
    return `None of your ${lands} lands always enter tapped, though ${maybe} sometimes do.`;
  }
  const aside = maybe > 0 ? `, and ${maybe} sometimes do` : '';
  return `${always} of your ${lands} lands always enter tapped${aside}. Expect to lose about ${one(
    stats.taplandTax,
  )} mana over your first ${TAX_TURNS} turns.`;
}

export function DeckStatsSheet({
  stats,
  rows,
  name,
  format,
  onClose,
}: {
  stats: DeckManaStats;
  /** The deck's slots, for the draw-odds panel to run its search against. */
  rows: readonly GroupRow[];
  name: string;
  format: DeckFormat | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} title={`Deck stats: ${name}`} className="deck-stats-sheet">
      {stats.total === 0 ? (
        <p className="fine-print">Nothing in the mainboard yet.</p>
      ) : (
        <>
          <div className="deck-stats-tiles">
            <div className="deck-stat">
              <strong>{stats.lands}</strong>
              <span>Lands</span>
            </div>
            <div className="deck-stat">
              <strong>{stats.spells}</strong>
              <span>Spells</span>
            </div>
            <div className="deck-stat">
              <strong>{one(stats.avgMv)}</strong>
              <span>Avg mana value</span>
            </div>
          </div>

          <h3 className="deck-stats-head">Mana curve</h3>
          <Curve stats={stats} />

          <h3 className="deck-stats-head">Land count</h3>
          <p className={`deck-stats-verdict tone-${stats.land.tone}`}>
            <strong>
              {stats.lands} land{plural(stats.lands)}.
            </strong>{' '}
            {stats.land.text}
          </p>
          {stats.modalLands > 0 && (
            <p className="fine-print">
              {stats.modalLands} of them {stats.modalLands === 1 ? 'is a modal card' : 'are modal cards'} with a land on the back, counted
              here as {stats.modalLands === 1 ? 'a land' : 'lands'} and in the curve as {stats.modalLands === 1 ? 'a spell' : 'spells'},
              which is what {stats.modalLands === 1 ? 'it is' : 'they are'}.
            </p>
          )}

          <h3 className="deck-stats-head">Taplands</h3>
          {stats.hasManaData ? (
            <>
              <p className="deck-stats-verdict">{taplandText(stats)}</p>
              {stats.tappedMaybe > 0 && (
                <p className="fine-print">
                  The sometimes-tapped ones (shocks, checks, fastlands) stay out of that number. You decide when they cost you, so an
                  average would be a guess wearing a decimal point.
                </p>
              )}
            </>
          ) : (
            <p className="fine-print">Your card database predates this data. Refresh it from About to see which of your lands enter tapped.</p>
          )}

          <ColorSourcesPanel rows={rows} library={librarySize(rows)} format={format} />

          <DrawOddsPanel rows={rows} format={format} />

          <MulliganPanel rows={rows} format={format} />

          <p className="fine-print deck-stats-note">
            Goldfish numbers: they assume a land drop every turn and nobody on the other side of the table.
            {format === 'commander' && ' Your commander counts as a card you cast.'}
            {stats.unknown > 0 &&
              ` ${stats.unknown} card${plural(stats.unknown)} here produce${stats.unknown === 1 ? 's' : ''} mana in a way we can't put a number on.`}
          </p>
        </>
      )}
    </Sheet>
  );
}
