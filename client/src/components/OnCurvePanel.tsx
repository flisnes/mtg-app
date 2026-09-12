import { useMemo, useState, type ReactNode } from 'react';
import type { DeckFormat } from '@mtg/shared';
import { ManaCost } from './ManaCost.js';
import { buildSimDeck, type DeckRow } from '../analysis/simDeck.js';
import { defaultSimOptions, halfWidth, type SimCardResult, type SimCostGroup, type SimResult } from '../analysis/simulate.js';
import { useSimulation } from '../analysis/useSimulation.js';

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

export function OnCurvePanel({ rows, format }: { rows: readonly DeckRow[]; format: DeckFormat | undefined }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [onPlay, setOnPlay] = useState(true);
  const deck = useMemo(() => buildSimDeck(rows), [rows]);
  const opts = useMemo(() => defaultSimOptions(format, onPlay), [format, onPlay]);
  const status = useSimulation(deck, opts);

  const result = status.kind === 'done' ? status.result : status.kind === 'running' ? status.previous : undefined;

  if (!deck.hasManaData) {
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

  if (!card) return <p className="deck-stats-verdict">Nothing in this deck has a cost to pay.</p>;

  const ci = halfWidth(card.onCurvePay, card.paySample);

  return (
    <>
      <p className={`deck-stats-verdict${shortfalls.length === 0 ? ' tone-ok' : ''}`}>{verdict(result, shortfalls)}</p>

      <select className="sim-pick" value={card.oracleId} onChange={(e) => onPick(e.target.value)} aria-label="Card to chart">
        {result.cards.map((c) => (
          <option key={c.oracleId} value={c.oracleId}>
            {c.name} · {pctShort(c.onCurvePay)} on turn {c.curveTurn}
          </option>
        ))}
      </select>
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
      <p className="fine-print">
        How often your mana pays for {card.name} by each turn, counting only the games you are holding it. Turn {card.curveTurn} is its
        curve: you have drawn it by then {pct(card.heldByTurn[card.curveTurn] ?? 0)} of the time, so you actually cast it on curve{' '}
        {pct(card.onCurveCast)} of games.
        {card.commander && ' It is your commander, so it is in hand every game.'} ±{(ci * 100).toFixed(1)} points.
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
      {shortfalls.length > MAX_ROWS && <p className="fine-print">And {shortfalls.length - MAX_ROWS} more costs below 90% on curve.</p>}

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
        A goldfish: nobody is across the table and the play pattern is fixed. It keeps a seven holding two to five lands, bottoms the
        spare land or the priciest spell, plays a land every turn (an untapped one when a card in hand costs exactly one more than it
        has, otherwise the tapland while it is free), cracks a fetch for the land that widens its colors, and casts one rock, dork or
        land-ramp spell a turn. Rituals, cost reducers, Treasure and card selection are all left out, so a deck built on those reads
        worse here than it plays.
      </p>
    </>
  );
}

function verdict(result: SimResult, shortfalls: readonly SimCostGroup[]): ReactNode {
  const total = result.costs.length;
  if (shortfalls.length === 0) {
    return (
      <>
        <strong>The mana is there on time.</strong> All {total} cost{total === 1 ? '' : 's'} in this deck clear 90% on their own curve,
        and the deck averages {pct(result.deckOnCurve)}.
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
