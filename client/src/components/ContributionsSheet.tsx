import { useState } from 'react';
import { Sheet } from './Sheet.js';
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
// overlap is one a reader will add up and be wrong. These sum, exactly, to the
// line above them, which is the only promise worth making here.

/** Which line we are decomposing. Two units, so never one list. */
type Lens = 'mana' | 'cards';

const one = (n: number) => n.toFixed(1);
const two = (n: number) => n.toFixed(2);

export function ContributionsSheet({ result, onClose }: { result: SimResult; onClose: () => void }) {
  const [lens, setLens] = useState<Lens>('mana');
  const turns = result.maxTurn;

  const rows = result.contributions
    .filter((c) => value(c, lens) >= 0.05)
    .sort((a, b) => value(b, lens) - value(a, lens) || a.name.localeCompare(b.name));
  const peak = Math.max(0.01, ...rows.map((c) => value(c, lens)));
  const total = rows.reduce((sum, c) => sum + value(c, lens), 0);

  return (
    <Sheet onClose={onClose} title="What each card is worth" className="contrib-sheet">
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

      <p className="deck-stats-verdict">{headline(result, lens, rows, total, turns)}</p>

      {rows.length === 0 ? (
        <p className="fine-print">
          Nothing in this deck {lens === 'mana' ? 'makes mana' : 'draws you cards'} in a way this model can read, so there is
          nothing to split up.
        </p>
      ) : (
        <ul className="contrib-rows">
          {rows.map((c) => {
            const v = value(c, lens);
            return (
              <li key={c.oracleId} className="contrib-row">
                <span className="contrib-name">
                  {c.name}
                  {c.copies > 1 && <span className="contrib-copies"> ×{c.copies}</span>}
                </span>
                <span className="contrib-track">
                  <span className={`contrib-fill contrib-${lens}`} style={{ width: `${(v / peak) * 100}%` }} />
                </span>
                {/* The bar is the total, which is what sums to the chart, and a
                    twenty-Forest deck makes every other bar a stub. So the
                    multi-copy rows also say what one copy is worth: that is the
                    number that compares a basic to a Sol Ring, and on the total
                    alone the basic wins by twenty to one. */}
                <span className="contrib-v">
                  {v < 0.1 ? two(v) : one(v)}
                  {c.copies > 1 && <span className="contrib-each">{two(v / c.copies)} ea</span>}
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
        This is what happened, not what you would lose by cutting the card. Those are different numbers whenever two cards work
        together: cast an Opt with an Archmage Emeritus out and each of them drew you one card, which is what this counts, but cut
        the Opt and the trigger goes with it and you are down two. Cut-one-card numbers do not add up. These do: every row here is
        a slice of the {lens === 'mana' ? 'mana' : 'cards seen'} line on the trajectory chart.
      </p>
      {lens === 'mana' && (
        <p className="fine-print">
          A land another card went and got belongs to the card that got it, for as long as it is on the battlefield, which is the
          only way a Cultivate is ever worth anything. It is the generous reading: some of those lands would have turned up off
          the top anyway.
        </p>
      )}
      <p className="fine-print">
        A card this model cannot read resolves as a blank and earns nothing, so a zero here can mean the card does nothing or can
        mean we could not tell. Card behavior, back on the stats sheet, says which and lets you write the rule out yourself.
      </p>
    </Sheet>
  );
}

const value = (c: SimContribution, lens: Lens): number => (lens === 'mana' ? c.mana : c.cards);

/**
 * The one sentence somebody reads before the list. It names the top card rather
 * than restating the total, because the total is already the chart upstairs and
 * the reason to open this panel is to find out who is behind it.
 */
function headline(result: SimResult, lens: Lens, rows: SimContribution[], total: number, turns: number): string {
  const top = rows[0];
  if (!top) return 'Nothing here contributes anything this model can measure.';
  const share = total > 0 ? Math.round((value(top, lens) / total) * 100) : 0;
  const each = top.copies > 1 ? `, ${two(value(top, lens) / top.copies)} apiece` : '';
  if (lens === 'mana') {
    const all = result.manaByTurn.slice(1, turns + 1).reduce((a, b) => a + b, 0);
    return `Across the first ${turns} turns you have ${one(all)} mana to spend, counting each turn's pool afresh. ${
      top.name
    } is ${one(top.mana)} of it${each}, or ${share}% of everything your deck puts online.`;
  }
  return `By turn ${turns} your deck has found you ${one(total)} cards beyond your opener and your draw step. ${top.name} is ${one(
    top.cards,
  )} of them${each}, or ${share}% of the total.`;
}
