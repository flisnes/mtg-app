import { useEffect, useRef, useState } from 'react';
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

export function DeckTrajectory({ result }: { result: SimResult }) {
  const turns = Math.min(CHART_TURNS, result.maxTurn);
  const mana: Series[] = [
    { name: 'available', values: result.manaByTurn, color: SERIES_A, dashed: false },
    { name: 'spent', values: result.manaSpentByTurn, color: SERIES_B, dashed: true },
  ];
  const cards: Series[] = [
    { name: 'seen', values: result.cardsSeenByTurn, color: SERIES_A, dashed: false },
    { name: 'in hand', values: result.handSizeByTurn, color: SERIES_B, dashed: true },
  ];

  return (
    <>
      <h4 className="deck-stats-head">Mana</h4>
      <TrendChart series={mana} turns={turns} unit="mana" />
      <p className="fine-print">{manaNote(result, turns)}</p>

      <h4 className="deck-stats-head">Cards</h4>
      <TrendChart series={cards} turns={turns} unit="cards" />
      <p className="fine-print">{cardsNote(result, turns)}</p>
    </>
  );
}

/**
 * The gap between the two mana lines, which is the point of the chart. It runs
 * wide on purpose and the reason has to be said out loud: a spell that draws
 * you a card resolves here as a blank, so nothing it would have bought is in
 * hand to spend the next turn's mana on.
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
  return `${at}. That gap is the widest in the game, and some of it is real: the rest is this model casting your draw spells as blanks, so nothing they would have found is in hand to spend it on.`;
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
