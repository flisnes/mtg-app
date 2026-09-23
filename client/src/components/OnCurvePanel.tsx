import { useState, type ReactNode } from 'react';
import { ManaCost } from './ManaCost.js';
import { halfWidth, type SimCardResult, type SimCostGroup, type SimOptions, type SimResult } from '../analysis/simulate.js';
import type { SimStatus } from '../analysis/useSimulation.js';

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
        <h3 className="deck-stats-head">On curve</h3>
        <p className="fine-print">
          Your card database predates this data. Refresh it from About to see what this deck actually casts on time.
        </p>
      </>
    );
  }

  return (
    <>
      <h3 className="deck-stats-head">On curve</h3>
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
  const card = result.cards.find((c) => c.oracleId === picked) ?? result.cards[0];

  if (!card && result.commanders.length === 0) {
    return <p className="deck-stats-verdict">Nothing in this deck has a cost to pay.</p>;
  }

  return (
    <>
      {/* The command zone first. It is the one card you are guaranteed to have
          in every game, it is usually the card the deck was built around, and
          it is the only one here whose odds are purely about your mana. */}
      {result.commanders.map((c) => (
        <Commander key={c.oracleId} card={c} />
      ))}

      {card && (
        <>
          {result.commanders.length > 0 && <h4 className="deck-stats-head">The rest of the deck</h4>}
          <p className={`deck-stats-verdict${shortfalls.length === 0 ? ' tone-ok' : ''}`}>{verdict(result, shortfalls)}</p>

          <select className="sim-pick" value={card.oracleId} onChange={(e) => onPick(e.target.value)} aria-label="Card to chart">
            {result.cards.map((c) => (
              <option key={c.oracleId} value={c.oracleId}>
                {c.name} · {pctShort(c.onCurvePay)} on turn {c.curveTurn}
              </option>
            ))}
          </select>
          <PayChart card={card} />
          <p className="fine-print">
            How often your mana pays for {card.name} by each turn, counting only the games you are holding it. Turn {card.curveTurn} is
            its curve: you have drawn it by then {pct(card.heldByTurn[card.curveTurn] ?? 0)} of the time, so you actually cast it on
            curve {pct(card.onCurveCast)} of games. ±{(halfWidth(card.onCurvePay, card.paySample) * 100).toFixed(1)} points.
          </p>

          {shortfalls.length > 0 && (
            <ul className="source-rows">
              {shortfalls.slice(0, MAX_ROWS).map((c) => (
                <li key={c.manaCost} className="source-row">
                  <ManaCost cost={c.manaCost} className="source-row-cost" />
                  <span className="source-row-name">{nameList(c.names)}</span>
                  <span className="source-row-p">{pctShort(c.onCurvePay)}</span>
                  <span className="source-row-note">
                    turn {c.curveTurn} · {c.copies} card{c.copies === 1 ? '' : 's'} at this cost
                  </span>
                </li>
              ))}
            </ul>
          )}
          {shortfalls.length > MAX_ROWS && (
            <p className="fine-print">And {shortfalls.length - MAX_ROWS} more costs below 90% on curve.</p>
          )}
        </>
      )}

      <p className="fine-print">
        Simulated, {result.games.toLocaleString()} games.{running && ' Re-dealing…'} You average {manaLine(result)}.{' '}
        {pct(result.pMulligan)} of those games started below seven cards, at {one(result.meanHandSize)} cards on average. Cards sharing a
        printed cost share a number, because they have the same answer and pooling them is what makes it precise in a singleton deck.
      </p>
      <p className="fine-print">
        Where this disagrees with the colored sources above, it is usually not about color. That check counts the sources you have seen
        and stops there; this one plays the turns out, so it also charges you for the lands you never drew and the ones that came down
        tapped. A four-drop can have plenty of white and still not have four mana.
      </p>
      <p className="fine-print">
        A goldfish: nobody is across the table. It mulligans on your Opening hand rule, plays a land every turn, cracks a fetch for
        the land that widens its colors, then spends the turn in the order set under Card behavior, with a coin flip between equals.
        Spells that draw, loot, mill, dig, make Treasure or add mana do it, and so does anything you have written a rule for. Cost
        reducers, and effects behind a trigger or a condition the card database cannot read, resolve as nothing until you write them
        under Card behavior, so a deck built on those reads worse here than it plays.
      </p>
    </>
  );
}

/**
 * The commander's own block, ahead of everything else.
 *
 * It earns the place: it waits in the command zone, so unlike every other card
 * in the deck there is no question of drawing it, and the whole deck is usually
 * built on the assumption that it resolves. That also makes it the one card
 * here whose number is *only* about the mana, which is why it needs no "you
 * have drawn it by then" clause and gets the full run behind its interval.
 */
function Commander({ card }: { card: SimCardResult }) {
  const ci = halfWidth(card.onCurvePay, card.paySample);
  const late = card.payByTurn[Math.min(card.curveTurn + 2, card.payByTurn.length - 1)] ?? 0;
  return (
    <>
      <p className={`deck-stats-verdict${card.onCurvePay >= THRESHOLD ? ' tone-ok' : ''}`}>
        <strong>
          You cast {card.name} on turn {card.curveTurn} {pctShort(card.onCurvePay)} of the time.
        </strong>{' '}
        It is waiting in the command zone every game, so this is your mana and nothing else.
      </p>
      <PayChart card={card} />
      <p className="fine-print">
        <ManaCost cost={card.manaCost} /> on turn {card.curveTurn}, and {pct(late)} by turn{' '}
        {Math.min(card.curveTurn + 2, card.payByTurn.length - 1)}. ±{(ci * 100).toFixed(1)} points. Commander tax is not counted, so
        this is the first cast, not the one after they killed it.
      </p>
    </>
  );
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

function verdict(result: SimResult, shortfalls: readonly SimCostGroup[]): ReactNode {
  const total = result.costs.length;
  if (shortfalls.length === 0) {
    return (
      <>
        <strong>The mana is there on time.</strong> All {total} cost{total === 1 ? '' : 's'} in the library clear 90% on their own
        curve, and the deck averages {pct(result.deckOnCurve)}.
      </>
    );
  }
  const worst = shortfalls[0]!;
  const rest = shortfalls.length - 1;
  return (
    <>
      <strong>
        {worst.names[0]} has the mana for it on turn {worst.curveTurn} {pctShort(worst.onCurvePay)} of the time.
      </strong>{' '}
      {rest > 0 && `${rest} other cost${rest === 1 ? '' : 's'} ${rest === 1 ? 'is' : 'are'} late too. `}
      The deck averages {pct(result.deckOnCurve)} across every copy.
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
