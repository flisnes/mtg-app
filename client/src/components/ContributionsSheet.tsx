import { useState } from 'react';
import { Sheet } from './Sheet.js';
import { HowWorked } from './HowWorked.js';
import type { SimContribution, SimResult } from '../analysis/simulate.js';

// Who made the trajectory lines — phase 13, and the first panel in this sheet
// that answers "is this card pulling its weight" with a number.
//
// Everything on the trajectory chart is a deck-level average, and the obvious
// next question about an average is which of the ninety-nine produced it. This
// is the same twenty thousand games with the two lines split up by the card
// responsible for each point: whose rule drew the card, whose permanent made
// the mana.
//
// It is **accounting, not a counterfactual**, and that distinction is the whole
// reason the panel can exist at all. Accounting says what happened. A
// counterfactual says what would happen if you cut the card, which needs a
// second simulation per card and — worse — does not add up: cut an Opt from a
// deck with an Archmage Emeritus and you lose two cards, cut the Archmage and
// you lose one, and the two together lose you less than three. Marginal
// contributions in a deck full of synergy overlap, and a panel of numbers that
// overlap is one a reader will add up and be wrong. These do not overlap:
// weighted by copies they sum, exactly, to the line above them, which is the
// only promise worth making here.
//
// What is *shown* is one copy, though. The stacked total ranks a deck by how
// many of a thing it runs — twenty basics bury a Sol Ring that is worth twice
// any one of them — and "how many do I run" is the one thing the reader already
// knows. Per copy is the number that answers whether the slot is earning, and
// the row carries the total beside it so the sum is never out of reach.

/** Which line we are decomposing. Two units, so never one list. */
type Lens = 'mana' | 'cards';

const one = (n: number) => n.toFixed(1);
const two = (n: number) => n.toFixed(2);

export function ContributionsSheet({ result, onClose }: { result: SimResult; onClose: () => void }) {
  const [lens, setLens] = useState<Lens>('mana');
  const turns = result.maxTurn;

  // Everything on show is **one copy**. A deck's twenty Forests are one row
  // worth 0.89, not one row worth 17.8: the question this panel answers is
  // whether a card earns its slot, and on the stacked total a basic beats a Sol
  // Ring twenty to one for no reason except that you run twenty of it. The
  // totals are still here — the row says what all your copies come to, and that
  // is the number that sums back to the chart.
  const rows = result.contributions
    .filter((c) => perCopy(c, lens) >= 0.05)
    .sort((a, b) => perCopy(b, lens) - perCopy(a, lens) || a.name.localeCompare(b.name));
  const peak = Math.max(0.01, ...rows.map((c) => perCopy(c, lens)));
  /** Every copy of everything, which is the quantity the chart's line is. */
  const deckTotal = rows.reduce((sum, c) => sum + value(c, lens), 0);

  return (
    <Sheet onClose={onClose} title="Who does the work" className="contrib-sheet">
      <div className="odds-controls">
        <div className="seg-row odds-seg" role="radiogroup" aria-label="Mana or cards">
          <button
            type="button"
            className={`seg${lens === 'mana' ? ' seg-active' : ''}`}
            role="radio"
            aria-checked={lens === 'mana'}
            onClick={() => setLens('mana')}
          >
            Mana
          </button>
          <button
            type="button"
            className={`seg${lens === 'cards' ? ' seg-active' : ''}`}
            role="radio"
            aria-checked={lens === 'cards'}
            onClick={() => setLens('cards')}
          >
            Cards
          </button>
        </div>
      </div>

      <p className="deck-stats-verdict">{headline(result, lens, rows, deckTotal, turns)}</p>

      {rows.length === 0 ? (
        <p className="fine-print">
          Nothing in this deck {lens === 'mana' ? 'makes mana' : 'draws you cards'} in a way the simulator can read, so there is
          nothing to split up.
        </p>
      ) : (
        <ul className="contrib-rows">
          {rows.map((c) => {
            const each = perCopy(c, lens);
            return (
              <li key={c.oracleId} className="contrib-row">
                <span className="contrib-name">
                  {c.name}
                  {c.copies > 1 && <span className="contrib-copies"> ×{c.copies}</span>}
                </span>
                <span className="contrib-track">
                  <span className={`contrib-fill contrib-${lens}`} style={{ width: `${(each / peak) * 100}%` }} />
                </span>
                {/* One copy, and then what all of them come to. The second line
                    is only on the rows that have more than one, which in most
                    decks is the basics and nothing else. */}
                {/* Two decimals, not one. Per-copy values cluster hard — a
                    Forest at 0.89 against a Simic Signet at 0.90 — and at one
                    decimal half the list reads as ties in an order the reader
                    then has no way to explain. */}
                <span className="contrib-v">
                  {two(each)}
                  {c.copies > 1 && <span className="contrib-each">{one(value(c, lens))} total</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {lens === 'cards' && (
        <p className="fine-print">
          Your opening hand is worth {one(result.seenFromOpener[turns] ?? 0)} of the {one(result.cardsSeenByTurn[turns] ?? 0)} cards
          you have seen by turn {turns}, and your draw step another {one(result.seenFromDrawStep[turns] ?? 0)}. Neither is any
          card's doing, so neither is in the list. Everything above is cards your deck found you on top of them.
        </p>
      )}

      <p className="fine-print">
        One copy each, so a basic is judged against a Sol Ring rather than outnumbering it. A zero can mean the card does nothing
        or that the simulator can't read it yet: the Model tab says which.
      </p>
      <HowWorked>
        <p className="fine-print">
          Multiply a row by the copies you run and they add back up to the {lens === 'mana' ? 'mana' : 'cards seen'} line on the
          Flow tab.
        </p>
        <p className="fine-print">
          This is what happened, not what you would lose by cutting the card. Those differ whenever two cards work together: cast
          an Opt with an Archmage Emeritus out and each drew you one card, which is what this counts, but cut the Opt and the
          trigger goes with it and you are down two. Cut-one-card numbers never add up. These do.
        </p>
        {lens === 'mana' && (
          <p className="fine-print">
            A land another card went and got belongs to the card that got it, for as long as it is on the battlefield, which is
            the only way a Cultivate is ever worth anything. It is the generous reading: some of those lands would have turned up
            off the top anyway.
          </p>
        )}
      </HowWorked>
    </Sheet>
  );
}

/** Everything this card's copies did between them: the share of the chart's line. */
const value = (c: SimContribution, lens: Lens): number => (lens === 'mana' ? c.mana : c.cards);

/** What one of it did, which is the number that says whether the slot is earning. */
const perCopy = (c: SimContribution, lens: Lens): number => value(c, lens) / Math.max(1, c.copies);

/**
 * The one sentence somebody reads before the list. It names the best *slot*
 * rather than the biggest pile, because the total is already the chart upstairs
 * and the reason to open this panel is to find out which card is earning.
 */
function headline(result: SimResult, lens: Lens, rows: SimContribution[], deckTotal: number, turns: number): string {
  const top = rows[0];
  if (!top) return 'Nothing here contributes anything this model can measure.';
  const each = perCopy(top, lens);
  // What all of them come to, said only when there is more than one of it:
  // otherwise the sentence repeats the number it just gave.
  const all =
    top.copies > 1
      ? ` You run ${top.copies}, which is ${one(value(top, lens))} between them.`
      : '';
  if (lens === 'mana') {
    const pool = result.manaByTurn.slice(1, turns + 1).reduce((a, b) => a + b, 0);
    return `Across the first ${turns} turns you have ${one(pool)} mana to spend, counting each turn's pool afresh. One ${
      top.name
    } is worth ${two(each)} of that, more than any other card here.${all}`;
  }
  return `By turn ${turns} your deck has found you ${one(deckTotal)} cards beyond your opener and your draw step. One ${
    top.name
  } is worth ${two(each)} of them, more than any other card here.${all}`;
}
