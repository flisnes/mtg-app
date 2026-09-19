import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CardBehavior, DeckFormat } from '@mtg/shared';
import { Sheet } from './Sheet.js';
import { Icon } from './icons.js';
import { CURVE_MAX, TAX_TURNS, type DeckManaStats } from '../deck/manaStats.js';
import { DrawOddsPanel } from './DrawOddsPanel.js';
import { ColorSourcesPanel } from './ColorSourcesPanel.js';
import { ManaFixPanel } from './ManaFixPanel.js';
import { OnCurvePanel } from './OnCurvePanel.js';
import { ContributionsSheet } from './ContributionsSheet.js';
import { DeckTrajectory } from './DeckTrajectory.js';
import { GameTraceSheet } from './GameTraceSheet.js';
import { CardBehaviorSheet } from './CardBehaviorSheet.js';
import { buildSimDeck } from '../analysis/simDeck.js';
import { missedDrawCopies } from '../analysis/coverage.js';
import { deckBehaviorMap } from '../db/dataAccess.js';
import { useOracleTags } from '../cardDb/useOracleTags.js';
import { defaultSimOptions, type SimContribution, type SimResult } from '../analysis/simulate.js';
import { useSimulation } from '../analysis/useSimulation.js';
import { MulliganPanel } from './MulliganPanel.js';
import { librarySize, type GroupRow } from '../analysis/groups.js';
import { manaReport } from '../analysis/manaSources.js';
import type { ManaFix } from '../deck/manaFixes.js';
import type { PlacementIndex } from '../db/usePlacements.js';

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

/** Stable identity for the first render, before the live query has answered. */
const EMPTY_BEHAVIORS: ReadonlyMap<string, CardBehavior> = new Map();

/** The headline on the behavior line: what is worth going in there for. */
function behaviorNote(coverage: { blanks: number; authored: number }): string {
  if (coverage.authored > 0) return `${coverage.authored} card${plural(coverage.authored)} play out your way`;
  if (coverage.blanks > 0) return `${coverage.blanks} resolve as nothing`;
  return 'every card is modelled';
}

/**
 * Who is doing the most on the chip, which is the reason to tap the line. The
 * bigger of the two lenses wins the label rather than mana always taking it: in
 * a deck built around a draw engine, naming the best Forest would be the app
 * looking straight past the thing the deck is about.
 */
function contribNote(result: SimResult): string {
  let best: SimContribution | undefined;
  let bestShare = 0;
  const manaAll = result.manaByTurn.slice(1).reduce((a, b) => a + b, 0);
  const cardsAll = result.contributions.reduce((sum, c) => sum + c.cards, 0);
  for (const c of result.contributions) {
    const share = Math.max(manaAll > 0 ? c.mana / manaAll : 0, cardsAll > 0 ? c.cards / cardsAll : 0);
    if (share > bestShare) {
      bestShare = share;
      best = c;
    }
  }
  return best ? `${best.name} leads` : `${result.contributions.length} cards pull their weight`;
}

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
  deckId,
  name,
  format,
  placements,
  onAddFix,
  onClose,
}: {
  stats: DeckManaStats;
  /** The deck's slots, for the draw-odds panel to run its search against. */
  rows: readonly GroupRow[];
  deckId: string;
  name: string;
  format: DeckFormat | undefined;
  /** Where the cards are, for the fix panel's "spare or spoken for" question. */
  placements: PlacementIndex | undefined;
  onAddFix: (fix: ManaFix) => void;
  onClose: () => void;
}) {
  // On the play, always: it is the harsher of the two by one card, and a
  // deckbuilding check that only holds up when you win the die roll isn't one.
  // Lifted out of the panel because the fix panel answers the same report.
  const report = useMemo(() => manaReport(rows, librarySize(rows), format, { onPlay: true }), [rows, format]);

  // One simulation for the whole sheet. The trajectory charts and the on-curve
  // table are two readings of the same twenty thousand games, so they share a
  // worker and a play/draw toggle rather than each heating the phone on its own.
  const [onPlay, setOnPlay] = useState(true);
  const [tracing, setTracing] = useState(false);
  const [contribOpen, setContribOpen] = useState(false);
  const [behaviorsOpen, setBehaviorsOpen] = useState(false);
  // What the user said their cards do, which overrides the card database's
  // reading of them. Live, so saving a behavior re-runs the simulation behind
  // the sheet the editor is sitting on.
  const behaviors = useLiveQuery(() => deckBehaviorMap(deckId), [deckId]);
  const simDeck = useMemo(() => buildSimDeck(rows, behaviors), [rows, behaviors]);
  const simOpts = useMemo(() => defaultSimOptions(format, onPlay), [format, onPlay]);
  const sim = useSimulation(simDeck, simOpts);
  const simResult = sim.kind === 'done' ? sim.result : sim.kind === 'running' ? sim.previous : undefined;
  // How many of the deck's blanks the tags say should have drawn you something.
  // Depends on `tagsReady` because the vocabulary loads off IndexedDB after the
  // first render, and a memo that doesn't watch for it reports null forever.
  const tagsReady = useOracleTags();
  const missedDraw = useMemo(() => missedDrawCopies(rows), [rows, tagsReady]);

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
          {stats.sacrificedLands > 0 && (
            <p className="fine-print">
              Something here eats {stats.sacrificedLands} land{plural(stats.sacrificedLands)} as it enters, so the verdict is judged
              against {stats.effectiveLands}. A Lotus Field is three permanents becoming one.
            </p>
          )}
          {stats.bounceLands > 0 && (
            <p className="fine-print">
              {stats.bounceLands} of them {stats.bounceLands === 1 ? 'returns a land' : 'return a land'} to your hand on entry. That is
              land-count neutral — you get the card back as a spare land drop — and costs you a mana on the turn it lands.
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

          <ColorSourcesPanel report={report} />

          <ManaFixPanel
            report={report}
            rows={rows}
            deckId={deckId}
            format={format}
            placements={placements}
            onAdd={onAddFix}
          />

          <h3 className="deck-stats-head">How the game unfolds</h3>
          {/* The toggle serves both simulated panels, so it sits above the first
              of them. Wrapped in `.odds-controls` because `.odds-seg` is
              `flex: 1`, which inside a row means "fill the row" and inside the
              sheet's own column flexbox means "height zero, then grow" — dropped
              straight into the sheet it renders as a 2px line on a phone. */}
          <div className="odds-controls">
            <div className="seg-row odds-seg" role="radiogroup" aria-label="Play or draw">
              <button
                type="button"
                className={`seg${onPlay ? ' seg-active' : ''}`}
                role="radio"
                aria-checked={onPlay}
                onClick={() => setOnPlay(true)}
              >
                On the play
              </button>
              <button
                type="button"
                className={`seg${onPlay ? '' : ' seg-active'}`}
                role="radio"
                aria-checked={!onPlay}
                onClick={() => setOnPlay(false)}
              >
                On the draw
              </button>
            </div>
          </div>
          {!simDeck.hasManaData ? (
            <p className="fine-print">
              Your card database predates this data. Refresh it from About to see how this deck plays out.
            </p>
          ) : sim.kind === 'error' ? (
            <p className="fine-print">The simulator stopped: {sim.message}</p>
          ) : !simResult ? (
            <p className="deck-stats-verdict sim-waiting">Dealing {simOpts.games.toLocaleString()} games…</p>
          ) : (
            <DeckTrajectory result={simResult} coverage={simDeck.coverage} missedDraw={missedDraw} />
          )}
          {/* The other question about an average: which of the ninety-nine
              produced it. Only offered when somebody in there did something,
              which for a deck of nothing but basics and removal is nobody. */}
          {simResult && simResult.contributions.length > 0 && (
            <button type="button" className="deck-stats-line" onClick={() => setContribOpen(true)}>
              <span className="deck-stats-bits">
                <span>What each card is worth</span>
                <span className="deck-stats-tone tone-ok">{contribNote(simResult)}</span>
              </span>
              <Icon name="chevronRight" />
            </button>
          )}

          {/* Averages are either right or invisibly wrong. This is the way to
              check: the same sequencer, one game, written down. */}
          {simDeck.hasManaData && simDeck.library.length > 0 && (
            <button type="button" className="deck-stats-line" onClick={() => setTracing(true)}>
              <span className="deck-stats-bits">
                <span>Watch one game play out</span>
              </span>
              <Icon name="chevronRight" />
            </button>
          )}

          <button type="button" className="deck-stats-line" onClick={() => setBehaviorsOpen(true)}>
            <span className="deck-stats-bits">
              <span>Card behavior</span>
              <span className="deck-stats-tone tone-ok">{behaviorNote(simDeck.coverage)}</span>
            </span>
            <Icon name="chevronRight" />
          </button>

          <OnCurvePanel status={sim} opts={simOpts} hasManaData={simDeck.hasManaData} />

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
      {contribOpen && simResult && <ContributionsSheet result={simResult} onClose={() => setContribOpen(false)} />}
      {tracing && <GameTraceSheet deck={simDeck} opts={simOpts} onClose={() => setTracing(false)} />}
      {behaviorsOpen && (
        <CardBehaviorSheet
          deckId={deckId}
          deckName={name}
          rows={rows}
          behaviors={behaviors ?? EMPTY_BEHAVIORS}
          onClose={() => setBehaviorsOpen(false)}
        />
      )}
    </Sheet>
  );
}
