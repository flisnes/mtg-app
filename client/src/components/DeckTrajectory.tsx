import { useEffect, useRef, useState } from 'react';
import type { SimCoverage } from '../analysis/simDeck.js';
import type { SimResult } from '../analysis/simulate.js';

// How the game unfolds, turn by turn — phase 7, and the first thing in this
// sheet that is about the *deck* rather than about a card in it.
//
// Every other panel here answers a question about one card: can I cast this,
// am I short of that colour, which land in my binder fixes it. The simulator is
// the only engine that plays a game, and until now it spent that power
// producing a per-card table. These are the same twenty thousand games read
// sideways: what the average one looked like on each turn.
//
// Two charts rather than one, and that is not a layout preference. Mana and
// cards are different units, and putting them on one pair of axes means two
// y-scales, which is the way to make any two lines tell whatever story you
// wanted. Same unit, same axis, or a separate chart.

/** Turns worth charting. Past six the curves go flat and the hand is empty. */
const CHART_TURNS = 8;

/**
 * Two series, in fixed order, and never cycled. Purple is the app's accent and
 * amber is the one that separates from it under every kind of colour blindness
 * (worst-case ΔE 21.9 against this surface, checked rather than eyeballed).
 * Line style carries the same distinction, so the chart survives being printed,
 * screenshotted in greyscale, or read by someone who sees neither hue.
 */
const SERIES_A = '#7c6cff';
const SERIES_B = '#c98230';

const one = (n: number) => n.toFixed(1);

interface Series {
  name: string;
  /** Indexed by turn; index 0 unused, the way every other per-turn array here is. */
  values: number[];
  color: string;
  dashed: boolean;
}

export function DeckTrajectory({
  result,
  coverage,
  missedDraw,
}: {
  result: SimResult;
  coverage: SimCoverage;
  /** Draw-tagged copies that resolve as blanks, or null if the tags never loaded. */
  missedDraw: number | null;
}) {
  const turns = Math.min(CHART_TURNS, result.maxTurn);
  const mana: Series[] = [
    { name: 'available', values: result.manaByTurn, color: SERIES_A, dashed: false },
    { name: 'spent', values: result.manaSpentByTurn, color: SERIES_B, dashed: true },
  ];
  const cards: Series[] = [
    { name: 'seen', values: result.cardsSeenByTurn, color: SERIES_A, dashed: false },
    { name: 'in hand', values: result.handSizeByTurn, color: SERIES_B, dashed: true },
  ];
  // Only for the decks that deal any. A flat pair of zeroes under a combo deck
  // is a chart that says nothing and takes a screenful to say it.
  const dealt = result.damageByTurn[turns] ?? 0;
  const damage: Series[] = [
    { name: 'total', values: result.damageByTurn, color: SERIES_A, dashed: false },
    { name: 'combat', values: result.combatDamageByTurn, color: SERIES_B, dashed: true },
  ];

  return (
    <>
      <h4 className="deck-stats-head">Mana</h4>
      <TrendChart series={mana} turns={turns} unit="mana" />
      <p className="fine-print">{manaNote(result, turns)}</p>

      <h4 className="deck-stats-head">Cards</h4>
      <TrendChart series={cards} turns={turns} unit="cards" />
      <p className="fine-print">{cardsNote(result, turns)}</p>

      {dealt > 0 && (
        <>
          <h4 className="deck-stats-head">Damage</h4>
          <TrendChart series={damage} turns={turns} unit="damage" />
          <p className="fine-print">{damageNote(result, turns)}</p>
        </>
      )}

      <p className="fine-print">
        An average game, over {result.games.toLocaleString()} of them. Each turn it plays its land drops, then spends what it has
        in whatever order the play style under Card behavior asks for, with a coin flip between cards it has no reason to prefer.
        The policy is part of the answer, so changing it moves every line here.
      </p>
      <p className="fine-print">{coverageNote(coverage, missedDraw)}</p>
    </>
  );
}

/**
 * §11.4's coverage report, and the only thing on this panel that is about the
 * model rather than about the deck.
 *
 * Every card the sequencer cannot read is an effect it fails to *apply*, never
 * one it invents, so these curves are systematically pessimistic and the bias
 * is worst for the decks doing the most interesting things. The fix is not to
 * model more cards, it is to say how many were modelled, which turns the
 * pessimism from something load-bearing into something a reader can price in.
 *
 * "Resolves as nothing" is not an accusation. A removal spell doing nothing to
 * your hand, your library or your mana is the model being right about it. The
 * sentence that follows is the one that matters.
 */
function coverageNote(c: SimCoverage, missedDraw: number | null): string {
  const modelled = c.lands + c.mana + c.effects;
  const parts: string[] = [];
  if (c.mana > 0) parts.push(`${c.mana} that make mana`);
  if (c.effects > 0) parts.push(`${c.effects} for what they do to your hand`);
  const how = parts.length > 0 ? `: ${c.lands} lands, ${parts.join(', ')}` : `, all of them lands`;
  const head = `Of ${c.library} cards in your library, this model plays out ${modelled}${how}.`;

  const rest: string[] = [];
  if (c.blanks > 0) {
    rest.push(`The other ${c.blanks} are cast and resolve as nothing, which is the right answer for a removal spell.`);
  }
  if (missedDraw && missedDraw > 0) {
    rest.push(
      `${missedDraw} of them ${missedDraw === 1 ? 'is a card' : 'are cards'} the database calls a draw spell whose draw hangs off a trigger or a condition we don't read, so every line above is a floor rather than an estimate.`,
    );
  } else if (c.blanks > 0) {
    rest.push('Anything they would have drawn you is missing from the lines above, so read them as a floor.');
  }
  if (c.floored > 0) {
    rest.push(`${c.floored} of the amounts we do read are floors, the way a "draw X" has to be.`);
  }
  // The one line here that points the other way, and the reason it has to be
  // said out loud: everything above is an argument that the curves are
  // pessimistic. An authored card plays out exactly as written, so for this
  // deck they stop being a pure floor, and only the reader can price that in.
  if (c.authored > 0) {
    rest.push(
      `${c.authored} card${c.authored === 1 ? '' : 's'} play out the way you told them to rather than the way we read them, so the lines above are only as good as your own reading of those.`,
    );
  }
  return [head, ...rest].join(' ');
}

/**
 * What the damage chart is and, more to the point, what it is not.
 *
 * Nobody blocks, nothing gains life and there is no life total to run out, so
 * this is the ceiling a goldfish reaches and never a clock. Said plainly every
 * time, because "deals 21 by turn six" is exactly the sort of number that gets
 * quoted with the word "goldfish" left off.
 */
function damageNote(result: SimResult, turns: number): string {
  const total = result.damageByTurn[turns] ?? 0;
  const combat = result.combatDamageByTurn[turns] ?? 0;
  const other = Math.max(0, total - combat);
  const split =
    combat > 0.05 && other > 0.05
      ? `${one(combat)} of it in combat and ${one(other)} from everything else`
      : combat > other
        ? 'all of it in combat'
        : 'none of it in combat';
  return `An opponent is down ${one(total)} by turn ${turns}, ${split}. Nothing blocks and nobody gains life here, so that is the ceiling rather than a clock, and only the cards this model can read are swinging or burning, so it is a low ceiling.`;
}

/**
 * The gap between the two mana lines, which is the point of the chart. Some of
 * it is a real curve problem and some of it is still the model: the cards it
 * cannot read resolve as blanks, so nothing they would have found is in hand to
 * spend the next turn's mana on. The coverage line below says how much of the
 * deck that is, so this note no longer has to guess at it.
 */
function manaNote(result: SimResult, turns: number): string {
  let worstTurn = 1;
  let worstGap = 0;
  for (let t = 1; t <= turns; t++) {
    const gap = (result.manaByTurn[t] ?? 0) - (result.manaSpentByTurn[t] ?? 0);
    if (gap > worstGap) {
      worstGap = gap;
      worstTurn = t;
    }
  }
  const at = `On turn ${worstTurn} you have ${one(result.manaByTurn[worstTurn] ?? 0)} mana and spend ${one(
    result.manaSpentByTurn[worstTurn] ?? 0,
  )} of it`;
  if (worstGap < 0.75) return `${at}, which is about as tight as a curve gets.`;
  return `${at}. That gap is the widest in the game, and some of it is real: the rest is the cards this model can't read, which cost you the mana and find you nothing.`;
}

function cardsNote(result: SimResult, turns: number): string {
  const hand = result.handSizeByTurn[turns] ?? 0;
  const seen = result.cardsSeenByTurn[turns] ?? 0;
  const tail =
    hand < 1
      ? ' Your hand is empty by then, so everything after it is whatever you draw for the turn.'
      : ' Cards left in hand are cards the mana never reached.';
  return `By turn ${turns} you have seen ${one(seen)} cards and are holding ${one(hand)}.${tail}`;
}

/**
 * A line per series over the turns, one y-axis, ticks at whole units.
 *
 * Drawn as SVG rather than with the sheet's CSS bar idiom because these are
 * trajectories and a bar chart of a trajectory makes the reader do the joining
 * up themselves. The numbers under it are the table view: the same data for
 * anyone the chart doesn't work for.
 */
function TrendChart({ series, turns, unit }: { series: Series[]; turns: number; unit: string }) {
  const [at, setAt] = useState<number | null>(null);
  // The viewBox is measured rather than fixed, so one user unit is one CSS
  // pixel and nothing is ever scaled. A fixed viewBox stretched across this
  // sheet's 560px would widen every label by half again; letterboxing it
  // instead would strand a 340px chart in the middle of the sheet. Measuring
  // is the only option that neither distorts the text nor wastes the width.
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(340);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = Math.max(260, width);
  const H = 150;
  const padL = 22;
  const padR = 54;
  const padT = 10;
  const padB = 20;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const peak = Math.max(1, ...series.flatMap((s) => s.values.slice(1, turns + 1)));
  // A whole-unit ceiling, so the gridlines land on numbers a reader recognises.
  const top = Math.ceil(peak * 1.05);
  const x = (turn: number) => padL + ((turn - 1) / Math.max(1, turns - 1)) * plotW;
  const y = (v: number) => padT + plotH - (v / top) * plotH;

  const ticks: number[] = [];
  const step = top <= 6 ? 1 : top <= 12 ? 2 : 5;
  for (let v = 0; v <= top; v += step) ticks.push(v);

  return (
    <div className="trend" ref={box}>
      <div className="trend-legend">
        {series.map((s) => (
          <span key={s.name} className="trend-key">
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={s.dashed ? '4 3' : undefined}
              />
            </svg>
            {s.name}
          </span>
        ))}
      </div>
      <svg
        className="trend-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={chartLabel(series, turns, unit)}
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          if (box.width === 0) return;
          const px = ((e.clientX - box.left) / box.width) * W;
          const turn = Math.round(((px - padL) / plotW) * Math.max(1, turns - 1)) + 1;
          setAt(Math.min(turns, Math.max(1, turn)));
        }}
        onPointerLeave={() => setAt(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} y1={y(v)} x2={padL + plotW} y2={y(v)} className="trend-grid" />
            <text x={padL - 5} y={y(v) + 3} className="trend-axis" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {Array.from({ length: turns }, (_, i) => i + 1).map((turn) => (
          <text key={turn} x={x(turn)} y={H - 6} className="trend-axis" textAnchor="middle">
            {turn}
          </text>
        ))}

        {at !== null && <line x1={x(at)} y1={padT} x2={x(at)} y2={padT + plotH} className="trend-cross" />}

        {series.map((s) => (
          <polyline
            key={s.name}
            className="trend-line"
            points={Array.from({ length: turns }, (_, i) => `${x(i + 1)},${y(s.values[i + 1] ?? 0)}`).join(' ')}
            stroke={s.color}
            strokeDasharray={s.dashed ? '5 4' : undefined}
          />
        ))}
        {series.map((s) =>
          Array.from({ length: turns }, (_, i) => i + 1).map((turn) => (
            <circle
              key={`${s.name}-${turn}`}
              cx={x(turn)}
              cy={y(s.values[turn] ?? 0)}
              r={at === turn ? 4 : 2.5}
              fill={s.color}
              className="trend-dot"
            />
          )),
        )}

        {/* Direct labels at the right end, so identity never rests on hue alone.
            The upper series is always the larger one here (you cannot spend mana
            you do not have, or hold a card you have not seen), so the two labels
            cannot swap places and collide. */}
        {series.map((s) => (
          <text key={s.name} x={padL + plotW + 6} y={y(s.values[turns] ?? 0) + 3} className="trend-label" fill={s.color}>
            {s.name}
          </text>
        ))}
      </svg>
      <p className="trend-readout">
        {at === null
          ? `Turn ${turns}: ${series.map((s) => `${one(s.values[turns] ?? 0)} ${s.name}`).join(', ')}`
          : `Turn ${at}: ${series.map((s) => `${one(s.values[at] ?? 0)} ${s.name}`).join(', ')}`}
      </p>
    </div>
  );
}

function chartLabel(series: Series[], turns: number, unit: string): string {
  const lines = series.map(
    (s) => `${s.name}: ${Array.from({ length: turns }, (_, i) => `turn ${i + 1} ${one(s.values[i + 1] ?? 0)}`).join(', ')}`,
  );
  return `${unit} by turn. ${lines.join('. ')}.`;
}
