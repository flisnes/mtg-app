import { Icon } from './icons.js';
import type { DeckManaStats } from '../deck/manaStats.js';
import { shortfallHeadline, type ManaReport } from '../analysis/manaSources.js';
import type { SimLimits, SimResult } from '../analysis/simulate.js';
import { heldBackBy } from './OnCurvePanel.js';
import type { SimCoverage } from '../analysis/simDeck.js';
import { FLOW_TURN } from './FlowTurnsPanel.js';

// The Overview tab (rebuild plan A5): one row per question, each a status, a
// sentence and the next thing to do, and each a way into the tab with the
// evidence. Nothing here is worked out fresh. It reads the same report and the
// same simulated run the other tabs print, so a row and its tab never disagree.
//
// Plan and Bracket get their rows when they have tabs to point at.

/** The bar every cost is read against, the same one On curve uses. */
const THRESHOLD = 0.9;
/** Screwed (or flooded) at least once by turn six in more games than this is worth a warning. */
const SCREW = 0.3;
const FLOOD = 0.3;
/** Mana left on the table on turn six worth saying out loud. */
const UNSPENT = 2;

const pct = (p: number) => `${Math.round(p * 100)}%`;
/** Below the bar never rounds onto it: "90%" on a row flagged for missing 90% reads as a bug. */
const pctShort = (p: number) => (p >= THRESHOLD ? pct(p) : `${Math.min(Math.round(p * 100), Math.round(THRESHOLD * 100) - 1)}%`);
const one = (n: number) => n.toFixed(1);
const plural = (n: number) => (n === 1 ? '' : 's');

type Tone = 'ok' | 'warn' | 'wait';

interface Answer {
  tone: Tone;
  /** Two or three words, beside the goal's name. */
  status: string;
  text: string;
  /** What to do about it, when there is something. */
  next?: string;
}

export type OverviewTarget = 'mana' | 'flow' | 'model';

export function AnalysisOverview({
  stats,
  report,
  result,
  hasManaData,
  games,
  coverage,
  toCheck,
  onTab,
}: {
  stats: DeckManaStats;
  report: ManaReport;
  /** The simulated run, or undefined while the first one is dealing. */
  result: SimResult | undefined;
  hasManaData: boolean;
  games: number;
  coverage: SimCoverage;
  /** Draw cards the tags say should draw and the model reads as nothing. */
  toCheck: number;
  onTab: (tab: OverviewTarget) => void;
}) {
  const rows: { goal: string; tab: OverviewTarget; answer: Answer }[] = [
    { goal: 'Mana', tab: 'mana', answer: manaAnswer(stats, report, result, hasManaData, games) },
    { goal: 'Flow', tab: 'flow', answer: flowAnswer(result, hasManaData, games) },
    { goal: 'Model', tab: 'model', answer: modelAnswer(coverage, toCheck) },
  ];
  return (
    <ul className="overview-rows">
      {rows.map(({ goal, tab, answer }) => (
        <li key={goal}>
          <button type="button" className="overview-row" onClick={() => onTab(tab)}>
            <span className="overview-main">
              <span className="overview-head">
                <strong>{goal}</strong>
                <span className={`overview-status tone-${answer.tone}`}>{answer.status}</span>
              </span>
              <span className="overview-text">{answer.text}</span>
              {answer.next && <span className="overview-next">{answer.next}</span>}
            </span>
            <Icon name="chevronRight" />
          </button>
        </li>
      ))}
    </ul>
  );
}

const waiting = (games: number): Answer => ({ tone: 'wait', status: 'dealing', text: `Dealing ${games.toLocaleString()} games…` });
const noData: Answer = { tone: 'wait', status: 'no data', text: 'Your card database predates this. Refresh it from About.' };

/**
 * Can you cast your cards on time. A color the deck cannot make at all leads,
 * because no amount of turns fixes it; then the commander, the one card in
 * every game; then the other costs; then the land count, which is the usual
 * reason for all of the above.
 */
function manaAnswer(
  stats: DeckManaStats,
  report: ManaReport,
  result: SimResult | undefined,
  hasManaData: boolean,
  games: number,
): Answer {
  const uncastable = report.checks.find((c) => c.uncastable);
  if (uncastable) {
    return { tone: 'warn', status: 'missing a color', text: shortfallHeadline(uncastable), next: 'Add a source of that color.' };
  }
  if (!hasManaData) return noData;
  if (!result) return waiting(games);

  const late = result.costs.filter((c) => c.onCurvePay < THRESHOLD);
  const commander = result.commanders[0];
  const commanderLate = commander !== undefined && commander.onCurvePay < THRESHOLD;
  const bits: string[] = [];
  if (commander) {
    bits.push(
      `You cast ${commander.name} on turn ${commander.curveTurn} ${pctShort(commander.onCurvePay)} of the time${commanderLate ? becauseOf(commander.limits) : ''}.`,
    );
  }
  if (late.length === 0) {
    bits.push(commander ? 'Every other cost is on time.' : 'Every cost clears 90% on its own turn.');
  } else {
    const worst = late[0]!;
    bits.push(
      `${late.length} cost${plural(late.length)} miss${late.length === 1 ? 'es' : ''} 90% on ${late.length === 1 ? 'its' : 'their'} own turn, worst ${worst.names[0]} at ${pctShort(worst.onCurvePay)} on turn ${worst.curveTurn}${becauseOf(worst.limits)}.`,
    );
  }
  if (stats.land.tone !== 'ok') bits.push(`${stats.lands} lands, ${stats.land.short}.`);

  const ok = !commanderLate && late.length === 0 && stats.land.tone === 'ok';
  // The fix follows the reason: the commander's when it is late, since it is
  // in every game, otherwise the worst cost's. The land count only speaks when
  // the reason is mana (or there is no late cost): more lands do not fix color.
  const lead = commanderLate ? commander : late[0];
  const leadWhy = lead ? heldBackBy(lead.limits) : null;
  const landsSpeak = !leadWhy || leadWhy.kind === 'mana';
  const next =
    landsSpeak && stats.land.tone === 'light'
      ? `Add ${-stats.land.diff} land${plural(-stats.land.diff)}, or cheap ramp.`
      : landsSpeak && stats.land.tone === 'heavy'
        ? `Cut ${stats.land.diff} land${plural(stats.land.diff)} for spells.`
        : ok || !lead
          ? undefined
          : fixFor(lead.limits);
  return {
    tone: ok ? 'ok' : 'warn',
    status: ok ? 'on time' : commanderLate ? 'commander late' : late.length > 0 ? `${late.length} late` : 'land count',
    text: bits.join(' '),
    next,
  };
}

/** ", held back by total mana", or nothing when the limiter has no answer. */
function becauseOf(limits: SimLimits): string {
  const why = heldBackBy(limits);
  return why ? `, held back by ${why.label}` : '';
}

/** The next step for what held a cost back. A dual does not fix a card short on mana. */
function fixFor(limits: SimLimits): string {
  const why = heldBackBy(limits);
  if (!why) return 'See which costs run late.';
  if (why.kind === 'tapped') return 'Fewer lands that enter tapped.';
  if (why.kind === 'mana') return 'More lands or cheap ramp. More duals will not help.';
  return `More ${why.label}. See the fixes you own.`;
}

/**
 * Does the deck keep doing things. Three ways it stops: it falls behind on mana
 * (screw), it has mana and nothing to spend it on (flood, or cards the model
 * cannot read), or it runs out of cards. The first one found leads. Screw and
 * flood are the Flow tab's own numbers, read on the same turn.
 */
function flowAnswer(result: SimResult | undefined, hasManaData: boolean, games: number): Answer {
  if (!hasManaData) return noData;
  if (!result) return waiting(games);
  const t = Math.min(FLOW_TURN, result.maxTurn);
  const mana = result.manaByTurn[t] ?? 0;
  const spent = result.manaSpentByTurn[t] ?? 0;
  const hand = result.handSizeByTurn[t] ?? 0;
  const screw = result.screwEverByTurn[t] ?? 0;
  const flood = result.floodEverByTurn[t] ?? 0;
  const facts = `By turn ${t} you are screwed at least once in ${pct(screw)} of games and flooded in ${pct(flood)}; on turn ${t} you hold ${one(hand)} cards and spend ${one(spent)} of ${one(mana)} mana.`;

  if (screw > SCREW) {
    return { tone: 'warn', status: 'screws', text: facts, next: 'More lands or cheap ramp.' };
  }
  if (flood > FLOOD) {
    return {
      tone: 'warn',
      status: 'floods',
      text: facts,
      next: 'More card draw or mana sinks, or model the cards that should be finding you some.',
    };
  }
  if (mana - spent >= UNSPENT) {
    return {
      tone: 'warn',
      status: 'mana unspent',
      text: `${one(mana - spent)} mana goes unspent on turn ${t}. ${facts}`,
      next: 'More to spend it on, or model the cards that should be finding you some.',
    };
  }
  if (hand < 1) {
    return { tone: 'warn', status: 'runs dry', text: `Your hand is empty by turn ${t}. ${facts}`, next: 'More card draw.' };
  }
  return { tone: 'ok', status: 'steady', text: facts };
}

/**
 * How far to trust the two rows above. Every card the model cannot read is an
 * effect it fails to apply, so the numbers are a floor, and the queue (cards
 * the tags say draw, ramp, tutor or build) is the part of that floor worth a tap.
 */
function modelAnswer(c: SimCoverage, toCheck: number): Answer {
  const modelled = c.lands + c.mana + c.effects;
  const head = `${modelled} of ${c.library} cards play out.`;
  if (toCheck > 0) {
    return {
      tone: 'warn',
      status: `${toCheck} to check`,
      text: `${head} ${toCheck} card${plural(toCheck)} that should draw, ramp or build ${toCheck === 1 ? 'does' : 'do'} nothing yet, so the numbers are a floor.`,
      next: 'Write what they do, top of the list first.',
    };
  }
  const rest = c.blanks > 0 ? ` The other ${c.blanks} do nothing, which is right for removal.` : '';
  return { tone: 'ok', status: `${modelled}/${c.library}`, text: `${head}${rest}` };
}
