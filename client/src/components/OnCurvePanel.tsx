import { useState, type ReactNode } from 'react';
import { ManaCost } from './ManaCost.js';
import { halfWidth, type SimCardResult, type SimCostGroup, type SimLimits, type SimOptions, type SimResult } from '@mtg/sim';
import { colorName } from '@mtg/sim';
import type { PipColor } from '@mtg/sim';
import { MASK_BITS } from '@mtg/sim';
import type { SimStatus } from '../analysis/useSimulation.js';
import { HowWorked } from './HowWorked.js';

// "Do I actually cast this on turn four?" — phase 5, and the first panel in
// this sheet whose number is simulated rather than exact.
//
// It is here because the exact engine cannot answer it. Whether a tapland cost
// you a turn depends on which turn you played it; whether the ramp spell
// resolved depends on whether you had two mana for it; whether five sources pay
// {2}{W}{W} is a matching problem over the draw you actually got; and the
// colored-source report never checks you had four mana at all, only two white
// ones. Every one of those is a fact about the order of your deck, and a
// hypergeometric never sees an order.
//
// So it says "simulated" on its face, prints its confidence interval, and
// states the play pattern it assumes. Users who play Magic know a goldfish
// number when they see one; users who do not deserve to be told.
//
// Rebuild plan B1 made it the castability answer for the whole Mana tab: one
// table, one number per late cost, and a "held back by" column from the
// simulator's limiter. It replaced Colored sources' exact shortfall rows, which
// were a second castability number that disagreed with this one whenever a
// card was short on mana rather than on color.

/** The bar every card is read against, and the same one the colored-source report uses. */
const THRESHOLD = 0.9;

/** Enough rows to see a pattern, few enough that the sheet stays a sheet. */
const MAX_ROWS = 6;

const pct = (p: number) => `${Math.round(p * 100)}%`;
/**
 * The same, except a number below the bar never rounds up onto it. A row listed
 * for missing 90% and labelled "90%" reads as a bug, and 89.98% is genuinely
 * short.
 */
const pctShort = (p: number) => (p >= THRESHOLD ? pct(p) : `${Math.min(Math.round(p * 100), Math.round(THRESHOLD * 100) - 1)}%`);
const one = (n: number) => n.toFixed(1);

/**
 * The simulation itself now lives in the sheet, because the trajectory panel
 * above reads the same run. Two panels, one worker: a second `useSimulation`
 * here would deal another twenty thousand games to answer a question the first
 * one already answered, on a phone, for nothing.
 */
export function OnCurvePanel({
  status,
  opts,
  hasManaData,
}: {
  status: SimStatus;
  opts: SimOptions;
  hasManaData: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const result = status.kind === 'done' ? status.result : status.kind === 'running' ? status.previous : undefined;

  if (!hasManaData) {
    return (
      <>
        <h3 className="deck-stats-head">Cast on time</h3>
        <p className="fine-print">
          Your card database predates this data. Refresh it from About to see what this deck actually casts on time.
        </p>
      </>
    );
  }

  return (
    <>
      <h3 className="deck-stats-head">Cast on time</h3>
      {status.kind === 'error' ? (
        <p className="fine-print">The simulator stopped: {status.message}</p>
      ) : !result ? (
        <p className="deck-stats-verdict sim-waiting">Dealing {opts.games.toLocaleString()} games…</p>
      ) : (
        <Report result={result} running={status.kind === 'running'} picked={picked} onPick={setPicked} />
      )}
    </>
  );
}

function Report({
  result,
  running,
  picked,
  onPick,
}: {
  result: SimResult;
  running: boolean;
  picked: string | null;
  onPick: (id: string) => void;
}) {
  const shortfalls = result.costs.filter((c) => c.onCurvePay < THRESHOLD);
  const commander = result.commanders[0];
  // The commander is the default chart: it is in every game and usually the
  // card the deck is built to cast. Otherwise the worst card in the library.
  const everyCard = [...result.commanders, ...result.cards];
  const card = everyCard.find((c) => c.oracleId === picked) ?? everyCard[0];

  if (!card) {
    return <p className="deck-stats-verdict">Nothing in this deck has a cost to pay.</p>;
  }

  const commanderLate = commander !== undefined && commander.onCurvePay < THRESHOLD;
  return (
    <>
      <p className={`deck-stats-verdict${shortfalls.length === 0 && !commanderLate ? ' tone-ok' : ''}`}>
        {verdict(result, shortfalls, commanderLate)}
      </p>
      <p className="fine-print">The bar: payable on its own turn in 9 of 10 games where you hold it.</p>

      {(result.commanders.length > 0 || shortfalls.length > 0) && (
        <table className="cast-table">
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Turn</th>
              <th scope="col" className="cast-p">
                On time
              </th>
              <th scope="col">Held back by</th>
            </tr>
          </thead>
          <tbody>
            {/* The command zone first, on time or not. It is the one card you
                have in every game, so its row is the one a reader looks for. */}
            {result.commanders.map((c) => (
              <CastRow
                key={c.oracleId}
                name={c.name}
                note="commander"
                manaCost={c.manaCost}
                turn={c.curveTurn}
                p={c.onCurvePay}
                limits={c.limits}
              />
            ))}
            {shortfalls.slice(0, MAX_ROWS).map((c) => (
              <CastRow
                key={c.manaCost}
                name={nameList(c.names)}
                manaCost={c.manaCost}
                turn={c.curveTurn}
                p={c.onCurvePay}
                limits={c.limits}
              />
            ))}
          </tbody>
        </table>
      )}
      {shortfalls.length > MAX_ROWS && (
        <p className="fine-print">And {shortfalls.length - MAX_ROWS} more costs below 90% on their own turn.</p>
      )}

      <h4 className="source-live-head">By turn</h4>
      <select className="sim-pick" value={card.oracleId} onChange={(e) => onPick(e.target.value)} aria-label="Card to chart">
        {everyCard.map((c) => (
          <option key={c.oracleId} value={c.oracleId}>
            {c.name} · {pctShort(c.onCurvePay)} on turn {c.curveTurn}
          </option>
        ))}
      </select>
      <PayChart card={card} />
      <p className="fine-print">{cardCaption(card)}</p>

      <p className="fine-print">
        Simulated, {result.games.toLocaleString()} games.{running && ' Re-dealing…'} Effects the simulator can't read yet do
        nothing, so a deck built on them reads worse here than it plays.
      </p>
      <HowWorked>
        <p className="fine-print">
          You average {manaLine(result)}. {pct(result.pMulligan)} of games started below seven cards, at{' '}
          {one(result.meanHandSize)} cards on average. Cards sharing a printed cost share a number: they have the same answer, and
          pooling them is what makes it precise in a singleton deck. The deck averages {pct(result.deckOnCurve)} on time across
          every copy.
        </p>
        <p className="fine-print">
          Held back by is asked on the card's own turn, in the games you hold it and can't pay for it, in this order. Taplands: the
          land that came down tapped this turn would have paid it. Total mana: too little mana in play whatever its colors, which
          lands and ramp fix and a dual does not. A color: enough mana, not the right kind.
        </p>
        <p className="fine-print">
          Nobody is across the table. It mulligans on your Opening hand rule, plays a land every turn, cracks a fetch for the land
          that widens its colors, then spends the turn in the play style set on the Model tab, with a coin flip between equals.
          Spells that draw, loot, mill, dig, make Treasure or add mana do it, and so does anything you have written a rule for.
          Cost reducers, and effects behind a trigger or a condition, do nothing until you write them on the Model tab. Commander
          tax is not counted, so a commander's number is the first cast.
        </p>
      </HowWorked>
    </>
  );
}

function CastRow({
  name,
  note,
  manaCost,
  turn,
  p,
  limits,
}: {
  name: string;
  note?: string;
  manaCost: string;
  turn: number;
  p: number;
  limits: SimLimits;
}) {
  const late = p < THRESHOLD;
  const why = late ? heldBackBy(limits) : null;
  return (
    <tr>
      <td>
        <span className="cast-name">{name}</span>
        {note && <span className="cast-note"> ({note})</span>} <ManaCost cost={manaCost} className="source-row-cost" />
      </td>
      <td className="cast-turn">{turn}</td>
      <td className={`cast-p${late ? ' cast-late' : ' tone-ok'}`}>{pctShort(p)}</td>
      <td>
        {why ? (
          <span className={`cast-limit cast-limit-${why.kind}`} title={limitBreakdown(limits)}>
            {why.label}
          </span>
        ) : (
          <span className="cast-note">{late ? '' : 'on time'}</span>
        )}
      </td>
    </tr>
  );
}

export type LimitKind = 'mana' | 'color' | 'tapped';

/**
 * The one reason to print in the column: whichever held the cost back in the
 * most games. Null when nothing measurable did, which on a late row means the
 * card left your hand before its turn (a loot, a discard).
 */
export function heldBackBy(limits: SimLimits): { kind: LimitKind; label: string; colors: PipColor[] } | null {
  const ranked: [LimitKind, number][] = [
    ['tapped', limits.tapped],
    ['mana', limits.mana],
    ['color', limits.color],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const [kind, share] = ranked[0]!;
  if (share < 0.005) return null;
  if (kind === 'tapped') return { kind, label: 'taplands', colors: [] };
  if (kind === 'mana') return { kind, label: 'total mana', colors: [] };
  const colors = shortColors(limits);
  return { kind, label: colors.length > 0 ? `${colors.map((c) => colorName([c])).join(' and ')} sources` : 'colors', colors };
}

/**
 * The colors worth naming: the one short most often, and any other short at
 * least half as often, so a {B}{R} card starved of both says both.
 */
function shortColors(limits: SimLimits): PipColor[] {
  const top = Math.max(...limits.colors);
  if (top <= 0) return [];
  return [...MASK_BITS].filter((_c, i) => (limits.colors[i] ?? 0) >= top / 2) as PipColor[];
}

/** "71% total mana, 29% red sources", as shares of the misses. */
function limitBreakdown(limits: SimLimits): string {
  const misses = limits.tapped + limits.mana + limits.color;
  if (misses <= 0) return '';
  const colors = shortColors(limits);
  const parts: [string, number][] = [
    ['total mana', limits.mana],
    [colors.length > 0 ? `${colors.map((c) => colorName([c])).join(' and ')} sources` : 'colors', limits.color],
    ['taplands', limits.tapped],
  ];
  const shown = parts.filter(([, x]) => x / misses >= 0.05).sort((a, b) => b[1] - a[1]);
  // One reason needs no share: "97% green sources" beside nothing reads as a typo.
  if (shown.length === 1) return shown[0]![0];
  return shown.map(([label, x]) => `${pct(x / misses)} ${label}`).join(', ');
}

/** Under the chart: when it is payable, how often you have it, and what stops it. */
function cardCaption(card: SimCardResult): string {
  const ci = `±${(halfWidth(card.onCurvePay, card.paySample) * 100).toFixed(1)} points`;
  const why = limitBreakdown(card.limits);
  const late = card.onCurvePay < THRESHOLD && why ? ` When it isn't: ${why}.` : '';
  if (card.commander) {
    const t = Math.min(card.curveTurn + 2, card.payByTurn.length - 1);
    return `Waiting in the command zone every game, so this is your mana and nothing else: ${pctShort(card.onCurvePay)} on turn ${card.curveTurn}, ${pct(card.payByTurn[t] ?? 0)} by turn ${t}, ${ci}.${late}`;
  }
  return `How often your mana pays for ${card.name} by each turn, in the games you hold it: ${pctShort(card.onCurvePay)} on turn ${card.curveTurn}, ${ci}. You have drawn it by then ${pct(card.heldByTurn[card.curveTurn] ?? 0)} of the time.${late}`;
}


/** The per-turn bars, with the turn the card is trying to be cast on marked. */
function PayChart({ card }: { card: SimCardResult }) {
  return (
    <div className="curve odds-curve" role="img" aria-label={chartLabel(card)}>
      {card.payByTurn.slice(1).map((p, i) => {
        const turn = i + 1;
        return (
          <div key={turn} className="curve-col">
            <div className="odds-track">
              <div className={`curve-bar${turn === card.curveTurn ? ' sim-bar-curve' : ''}`} style={{ height: `${p * 100}%` }}>
                <span className="curve-count">{Math.round(p * 100)}</span>
              </div>
            </div>
            <span className={`curve-tick${turn === card.curveTurn ? ' sim-tick-curve' : ''}`}>{turn}</span>
          </div>
        );
      })}
    </div>
  );
}

function verdict(result: SimResult, shortfalls: readonly SimCostGroup[], commanderLate: boolean): ReactNode {
  const total = result.costs.length + result.commanders.length;
  const late = shortfalls.length + (commanderLate ? 1 : 0);
  if (late === 0) {
    return (
      <>
        <strong>The mana is there on time.</strong> All {total} cost{total === 1 ? '' : 's'} clear 90% on their own turn.
      </>
    );
  }
  return (
    <>
      <strong>
        {late} of {total} cost{total === 1 ? '' : 's'} miss the bar.
      </strong>
      {commanderLate && ' Your commander is one of them.'}
    </>
  );
}

const ORDINALS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

/** "1.0, 2.0, 2.9 and 3.8 mana on turns one to four" — the manabase in four numbers. */
function manaLine(result: SimResult): string {
  const turns = result.manaByTurn.slice(1, 5).map(one);
  return `${turns.join(', ')} mana on turns one to ${ORDINALS[turns.length] ?? turns.length}`;
}

/** The cards written at one cost, truncated — a singleton deck can have a dozen. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(', ');
  return names.length <= 2 ? shown : `${shown} and ${names.length - 2} more`;
}

function chartLabel(card: SimCardResult): string {
  const bits = card.payByTurn.slice(1).map((p, i) => `turn ${i + 1}: ${Math.round(p * 100)}%`);
  return `Odds your mana pays for ${card.name}. ${bits.join(', ')}.`;
}
