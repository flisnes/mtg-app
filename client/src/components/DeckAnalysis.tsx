import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CardBehavior, DeckFormat } from '@mtg/shared';
import { Icon } from './icons.js';
import { CURVE_MAX, TAX_TURNS, type DeckManaStats } from '../deck/manaStats.js';
import { DrawOddsPanel } from './DrawOddsPanel.js';
import { ColorSourcesPanel } from './ColorSourcesPanel.js';
import { ManaFixPanel } from './ManaFixPanel.js';
import { heldBackBy, OnCurvePanel } from './OnCurvePanel.js';
import { ContributionsSheet } from './ContributionsSheet.js';
import { FlowTurnsPanel } from './FlowTurnsPanel.js';
import { DeckTrajectory } from './DeckTrajectory.js';
import { GameTraceSheet } from './GameTraceSheet.js';
import { CardBehaviorPanel } from './CardBehaviorPanel.js';
import { AnalysisOverview } from './AnalysisOverview.js';
import { HowWorked } from './HowWorked.js';
import { buildSimDeck } from '../analysis/simDeck.js';
import { idleEngines, missedDrawCopies, modelQueue, type IdleEngines } from '../analysis/coverage.js';
import { deckBehaviorMap } from '../db/dataAccess.js';
import { useOracleTags } from '../cardDb/useOracleTags.js';
import {
  COMBAT_POLICIES,
  DEFAULT_POLICY,
  INTERACTION_POLICIES,
  SPEND_POLICIES,
  defaultSimOptions,
  type SimContribution,
  type SimPolicy,
  type SimResult,
} from '../analysis/simulate.js';
import { useSimulation } from '../analysis/useSimulation.js';
import { DEFAULT_KEEP_RULE, MulliganPanel, type KeepRule } from './MulliganPanel.js';
import { librarySize, type GroupRow } from '../analysis/groups.js';
import { manaReport } from '../analysis/manaSources.js';
import type { ManaFix } from '../deck/manaFixes.js';
import type { PlacementIndex } from '../db/usePlacements.js';

// What the deck's mana looks like before a single card is drawn: the curve, the
// tempo the tapped lands cost you, and whether there are enough lands for what
// you're casting. Arithmetic only — see deck/manaStats.ts for the model and its
// deliberate omissions.
//
// It lives on its own page rather than on the deck page because the deck page
// is a decklist. It used to be a sheet; notes/deck-analysis-rebuild.md has why
// the sheet became a page with tabs.

const one = (n: number) => n.toFixed(1);
const plural = (n: number) => (n === 1 ? '' : 's');

/** Stable identity for the first render, before the live query has answered. */
const EMPTY_BEHAVIORS: ReadonlyMap<string, CardBehavior> = new Map();

/**
 * How the simulator plays *this* deck, remembered per deck.
 *
 * localStorage rather than the deck row, and that is a judgement rather than a
 * shortcut: this is a lens you look at the deck through, not a fact about the
 * decklist. Nobody trading a deck wants your sequencing preferences with it,
 * and a synced field costs a schema change, a sanitizer and a repair on every
 * older device — for a setting you change while staring at the chart it moves.
 */
const policyKey = (deckId: string) => `sim-policy:${deckId}`;

function loadPolicy(deckId: string): SimPolicy {
  try {
    const raw = localStorage.getItem(policyKey(deckId));
    if (!raw) return DEFAULT_POLICY;
    const saved = JSON.parse(raw) as Partial<SimPolicy>;
    // Merged over the default rather than trusted: a policy saved by a later
    // release may name a spend order this build has never heard of, and the
    // simulator would then quietly fall through to "ramp" without saying so.
    return {
      spend: SPEND_POLICIES.some((o) => o.id === saved.spend) ? saved.spend! : DEFAULT_POLICY.spend,
      combat: COMBAT_POLICIES.some((o) => o.id === saved.combat) ? saved.combat! : DEFAULT_POLICY.combat,
      interaction: INTERACTION_POLICIES.some((o) => o.id === saved.interaction) ? saved.interaction! : DEFAULT_POLICY.interaction,
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

/**
 * The Opening hand keep rule, remembered per deck beside the policy and for the
 * same reason: it is how you play the deck, not a fact about the list. The
 * simulator mulligans on it, so it has to outlive the sheet being closed.
 */
const keepKey = (deckId: string) => `sim-keep:${deckId}`;

function loadKeepRule(deckId: string): KeepRule {
  try {
    const raw = localStorage.getItem(keepKey(deckId));
    if (!raw) return DEFAULT_KEEP_RULE;
    const saved = JSON.parse(raw) as Partial<KeepRule>;
    const n = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 && v <= 7 ? Math.round(v) : fallback);
    const min = n(saved.min, DEFAULT_KEEP_RULE.min);
    return {
      query: typeof saved.query === 'string' ? saved.query : DEFAULT_KEEP_RULE.query,
      min,
      max: Math.max(min, n(saved.max, DEFAULT_KEEP_RULE.max)),
    };
  } catch {
    return DEFAULT_KEEP_RULE;
  }
}

/**
 * The headline on the behavior line: what is worth going in there for.
 *
 * The queue leads when there is one (rebuild plan C1). `blanks` counts every
 * removal spell in the deck and a removal spell resolving as nothing is the
 * model being right, so it is the wrong thing to put first: it reads as a
 * complaint about cards that work. The queue is the subset the tags say should
 * be drawing, ramping, tutoring or building something, which is the part
 * actually costing the numbers anything, and the only part worth a tap.
 */
function behaviorNote(coverage: { blanks: number; authored: number }, queued: number): string {
  if (queued > 0) return `${queued} card${plural(queued)} worth writing first: the tags say they do something, the simulator plays them as nothing`;
  if (coverage.authored > 0) return `${coverage.authored} card${plural(coverage.authored)} play out the way you wrote them`;
  if (coverage.blanks > 0) return `${coverage.blanks} cards do nothing in the simulator, which is right for removal`;
  return 'The simulator plays out every card';
}

/**
 * Who is doing the most on the chip, which is the reason to tap the line. The
 * bigger of the two lenses wins the label rather than mana always taking it: in
 * a deck built around a draw engine, naming the best Forest would be the app
 * looking straight past the thing the deck is about.
 */
function contribNote(result: SimResult, idle: IdleEngines | null): string {
  let best: SimContribution | undefined;
  let bestShare = 0;
  const manaAll = result.manaByTurn.slice(1).reduce((a, b) => a + b, 0);
  const cardsAll = result.contributions.reduce((sum, c) => sum + c.cards, 0);
  for (const c of result.contributions) {
    // Per copy, the same as the panel: a chip reading "Forest leads" is the app
    // telling you that you run a lot of Forests.
    const copies = Math.max(1, c.copies);
    const share = Math.max(manaAll > 0 ? c.mana / copies / manaAll : 0, cardsAll > 0 ? c.cards / copies / cardsAll : 0);
    if (share > bestShare) {
      bestShare = share;
      best = c;
    }
  }
  const lead = best ? `${best.name} leads` : `${result.contributions.length} cards pull their weight`;
  // The gap is the reason to open the sheet when there is one, so it goes on
  // the chip rather than waiting at the bottom of the list.
  const n = idleCount(idle);
  if (n === 0) return lead;
  const gap = `${n} doing nothing yet`;
  return result.contributions.length > 0 ? `${lead}, ${gap}` : gap;
}

/** Distinct cards stuck at zero in either lens. */
function idleCount(idle: IdleEngines | null): number {
  if (!idle) return 0;
  return new Set([...idle.mana, ...idle.cards].map((c) => c.oracleId)).size;
}

/** One tappable line under the legality panel: the headline, and the way in. */
export function DeckStatsLine({ stats, onOpen }: { stats: DeckManaStats; onOpen: () => void }) {
  return (
    <button type="button" className="deck-stats-line" onClick={onOpen} aria-label="Open deck analysis">
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

/** Is any late cost, the commander's included, held back by color rather than by mana. */
function colorLate(result: SimResult): boolean {
  return [...result.commanders, ...result.costs].some((c) => c.onCurvePay < 0.9 && heldBackBy(c.limits)?.kind === 'color');
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

/**
 * The tabs, in the order a deck gets looked at: the answers, then can it cast
 * its cards, how does a game go, and what the model knows.
 */
export const ANALYSIS_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'mana', label: 'Mana' },
  { id: 'flow', label: 'Flow' },
  { id: 'model', label: 'Model' },
] as const;
export type AnalysisTab = (typeof ANALYSIS_TABS)[number]['id'];

/** The policy chip's text: the spend order always, the other two only when they are not the default. */
function policyLabel(policy: SimPolicy): string {
  const bits = [SPEND_POLICIES.find((o) => o.id === policy.spend)?.short ?? policy.spend];
  if (policy.combat !== DEFAULT_POLICY.combat) bits.push(COMBAT_POLICIES.find((o) => o.id === policy.combat)?.short ?? policy.combat);
  if (policy.interaction !== DEFAULT_POLICY.interaction) {
    bits.push(INTERACTION_POLICIES.find((o) => o.id === policy.interaction)?.short ?? policy.interaction);
  }
  return bits.join(' · ');
}

/**
 * The deck analysis, as a page rather than a sheet (rebuild plan A4). One
 * context bar above the tabs says which game every number is about (play or
 * draw, the play policy, how much of the deck the model can read), and the
 * panels that used to be one long scroll are split by the question they answer.
 */
export function DeckAnalysis({
  stats,
  rows,
  deckId,
  format,
  placements,
  onAddFix,
  tab,
  onTab,
}: {
  stats: DeckManaStats;
  /** The deck's slots, for the draw-odds panel to run its search against. */
  rows: readonly GroupRow[];
  deckId: string;
  format: DeckFormat | undefined;
  /** Where the cards are, for the fix panel's "spare or spoken for" question. */
  placements: PlacementIndex | undefined;
  onAddFix: (fix: ManaFix) => void;
  tab: AnalysisTab;
  onTab: (tab: AnalysisTab) => void;
}) {
  // One play/draw toggle for everything. There used to be three, plus a
  // colored-source report pinned to the play, and flipping one left the rest
  // answering a different game. On the play is the default because it is the
  // harsher of the two by one card.
  const [onPlay, setOnPlay] = useState(true);
  // Lifted out of the panel because the fix panel answers the same report.
  const report = useMemo(() => manaReport(rows, librarySize(rows), format, { onPlay }), [rows, format, onPlay]);
  const [keepRule, setKeepRule] = useState<KeepRule>(() => loadKeepRule(deckId));
  const saveKeepRule = (next: KeepRule) => {
    setKeepRule(next);
    try {
      localStorage.setItem(keepKey(deckId), JSON.stringify(next));
    } catch {
      // Same as the policy: the session keeps it even when storage refuses.
    }
  };

  const [tracing, setTracing] = useState(false);
  const [contribOpen, setContribOpen] = useState(false);
  // The card open in the Model tab's editor, lifted here so a row in "Who does
  // the work" can open one from the Flow tab.
  const [modelCard, setModelCard] = useState<string | null>(null);
  // How the sequencer plays this deck. Set on the Model tab, where the rest of
  // "what happens in a simulated game" is decided, and named in the bar above
  // every tab because it moves every simulated number.
  const [policy, setPolicy] = useState<SimPolicy>(() => loadPolicy(deckId));
  const savePolicy = (next: SimPolicy) => {
    setPolicy(next);
    try {
      localStorage.setItem(policyKey(deckId), JSON.stringify(next));
    } catch {
      // A private window with storage off still gets the setting for this
      // session; losing it on close beats refusing to change it.
    }
  };
  // What the user said their cards do, which overrides the card database's
  // reading of them. Live, so saving a behavior re-runs the simulation.
  const behaviors = useLiveQuery(() => deckBehaviorMap(deckId), [deckId]);
  // `otag:` in a keep query resolves its slug at parse time, so the deck is
  // rebuilt once the tag vocabulary lands, the same way the panels re-run.
  const tagsReady = useOracleTags();
  const simDeck = useMemo(() => buildSimDeck(rows, behaviors, keepRule.query), [rows, behaviors, keepRule.query, tagsReady]);
  const simOpts = useMemo(
    () => ({ ...defaultSimOptions(format, onPlay), ...policy, keepMin: keepRule.min, keepMax: keepRule.max }),
    [format, onPlay, policy, keepRule.min, keepRule.max],
  );
  const sim = useSimulation(simDeck, simOpts);
  const simResult = sim.kind === 'done' ? sim.result : sim.kind === 'running' ? sim.previous : undefined;
  // How many of the deck's blanks the tags say should have drawn you something.
  // Depends on `tagsReady` because the vocabulary loads off IndexedDB after the
  // first render, and a memo that doesn't watch for it reports null forever.
  // The same question per card, for "Who does the work" to list at zero. Off
  // the built deck, so a card with a behavior on it drops out of both.
  const idle = useMemo(() => idleEngines(rows, simDeck), [rows, simDeck, tagsReady]);
  const missedDraw = useMemo(() => missedDrawCopies(idle), [idle]);
  // The Model tab's queue, which is also what the coverage chip counts.
  const queue = useMemo(() => modelQueue(rows, simDeck), [rows, simDeck, tagsReady]);
  // Lands, mana sources and cards with an effect the sequencer resolves. The
  // same arithmetic `coverageNote` does, because the chip and the paragraph
  // explaining it disagreeing would be worse than either of them being absent.
  const { lands: covLands, mana: covMana, effects: covEffects } = simDeck.coverage;
  const modelled = covLands + covMana + covEffects;
  const toCheck = queue?.length ?? 0;

  // The bar's height, for the card editor to scroll clear of it. Measured
  // rather than guessed, because the chips wrap differently on every phone.
  const root = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => root.current?.style.setProperty('--analysis-bar-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [stats.total]);

  // A new tab starts at its top. Only when the bar is pinned: at rest the page
  // header is still on screen and jumping past it would be the app scrolling
  // for no reason.
  // Leaving the Model tab closes its editor, the way unmounting it used to.
  useEffect(() => {
    if (tab !== 'model') setModelCard(null);
  }, [tab]);

  const shownTab = useRef(tab);
  useEffect(() => {
    if (shownTab.current === tab) return;
    shownTab.current = tab;
    const r = root.current;
    const b = bar.current;
    if (r && b && r.getBoundingClientRect().top < b.getBoundingClientRect().top - 1) r.scrollIntoView({ block: 'start' });
  }, [tab]);

  if (stats.total === 0) return <p className="fine-print">Nothing in the mainboard yet.</p>;

  return (
    <div className="deck-analysis" ref={root}>
      <div className="analysis-context" ref={bar}>
        <div className="seg-row analysis-play" role="radiogroup" aria-label="Play or draw">
          <button type="button" className={`seg${onPlay ? ' seg-active' : ''}`} role="radio" aria-checked={onPlay} onClick={() => setOnPlay(true)}>
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
        {/* Both chips go to the Model tab: the policy is set there, and so is
            what the model reads a card as. */}
        <button type="button" className="analysis-chip" onClick={() => onTab('model')} title="Play style: change it on the Model tab">
          {policyLabel(policy)}
        </button>
        <button
          type="button"
          className={`analysis-chip${toCheck > 0 ? ' analysis-chip-warn' : ''}`}
          onClick={() => onTab('model')}
          title="How much of the deck the simulator plays out"
        >
          {modelled}/{simDeck.coverage.library} modelled{toCheck > 0 && ` · ${toCheck} to check`}
        </button>
        <div className="seg-row sheet-tabs analysis-tabs" role="tablist" aria-label="Analysis">
          {ANALYSIS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'seg seg-active' : 'seg'}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="deck-analysis-body" role="tabpanel">
        {tab === 'overview' && (
          <AnalysisOverview
            stats={stats}
            report={report}
            result={simResult}
            hasManaData={simDeck.hasManaData}
            games={simOpts.games}
            coverage={simDeck.coverage}
            toCheck={toCheck}
            onTab={onTab}
          />
        )}

        {tab === 'mana' && (
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
            {(stats.modalLands > 0 || stats.sacrificedLands > 0 || stats.bounceLands > 0) && (
              <HowWorked label="What counts as a land here">
              {stats.modalLands > 0 && (
                <p className="fine-print">
                  {stats.modalLands} of them {stats.modalLands === 1 ? 'is a modal card' : 'are modal cards'} with a land on the back,
                  counted here as {stats.modalLands === 1 ? 'a land' : 'lands'} and in the curve as{' '}
                  {stats.modalLands === 1 ? 'a spell' : 'spells'}, which is what {stats.modalLands === 1 ? 'it is' : 'they are'}.
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
                  {stats.bounceLands} of them {stats.bounceLands === 1 ? 'returns a land' : 'return a land'} to your hand on entry. That
                  is land-count neutral (you get the card back as a spare land drop) and costs you a mana on the turn it lands.
                </p>
              )}
              </HowWorked>
            )}

            <h3 className="deck-stats-head">Taplands</h3>
            {stats.hasManaData ? (
              <>
                <p className="deck-stats-verdict">{taplandText(stats)}</p>
                {stats.tappedMaybe > 0 && (
                  <p className="fine-print">
                    Shocks, checklands and fastlands stay out of that number: you decide when they cost you.
                  </p>
                )}
              </>
            ) : (
              <p className="fine-print">
                Your card database predates this data. Refresh it from About to see which of your lands enter tapped.
              </p>
            )}

            <OnCurvePanel status={sim} opts={simOpts} hasManaData={simDeck.hasManaData} />

            <ColorSourcesPanel report={report} sim={simResult ?? null} />

            {/* Only when color is what the simulation says is holding a cost
                back. A dual does not fix a commander that is short on mana. */}
            {(!simResult || colorLate(simResult)) && (
              <ManaFixPanel report={report} rows={rows} deckId={deckId} format={format} placements={placements} onAdd={onAddFix} />
            )}
          </>
        )}

        {tab === 'flow' && (
          <>
            {simDeck.hasManaData && simResult && <FlowTurnsPanel result={simResult} />}
            <h3 className="deck-stats-head">How the game unfolds</h3>
            {!simDeck.hasManaData ? (
              <p className="fine-print">Your card database predates this data. Refresh it from About to see how this deck plays out.</p>
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
            {simResult && (simResult.contributions.length > 0 || idleCount(idle) > 0) && (
              <button type="button" className="deck-stats-line" onClick={() => setContribOpen(true)}>
                <span className="deck-stats-bits">
                  <span>Who does the work</span>
                  <span className={`deck-stats-tone ${idleCount(idle) > 0 ? 'tone-warn' : 'tone-ok'}`}>{contribNote(simResult, idle)}</span>
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

            <MulliganPanel rows={rows} format={format} onPlay={onPlay} rule={keepRule} onRule={saveKeepRule} />

            <DrawOddsPanel rows={rows} format={format} onPlay={onPlay} />
          </>
        )}

        {tab === 'model' && (
          <>
            <p className={`deck-stats-verdict${toCheck > 0 ? ' tone-warn' : ''}`}>{behaviorNote(simDeck.coverage, toCheck)}.</p>
            <CardBehaviorPanel
              deckId={deckId}
              rows={rows}
              behaviors={behaviors ?? EMPTY_BEHAVIORS}
              policy={policy}
              onPolicy={savePolicy}
              openId={modelCard}
              onOpenId={setModelCard}
              queue={queue}
            />
          </>
        )}

        <p className="fine-print deck-stats-note">
          Goldfish numbers: they assume a land drop every turn and nobody on the other side of the table.
          {format === 'commander' && ' Your commander counts as a card you cast.'}
          {stats.unknown > 0 &&
            ` ${stats.unknown} card${plural(stats.unknown)} here produce${stats.unknown === 1 ? 's' : ''} mana in a way we can't put a number on.`}
        </p>
      </div>

      {contribOpen && simResult && (
        <ContributionsSheet
          result={simResult}
          idle={idle}
          onClose={() => setContribOpen(false)}
          onModel={(oracleId) => {
            setContribOpen(false);
            setModelCard(oracleId);
            onTab('model');
          }}
        />
      )}
      {tracing && <GameTraceSheet deck={simDeck} opts={simOpts} onClose={() => setTracing(false)} />}
    </div>
  );
}
