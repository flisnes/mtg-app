import { useMemo, useState, type ReactNode } from 'react';
import type { DeckFormat } from '@mtg/shared';
import { useOracleTags } from '../cardDb/useOracleTags.js';
import { librarySize, resolveGroup, type GroupRow } from '../analysis/groups.js';
import { handSize, MAX_TURN } from '../analysis/gameModel.js';
import { oddsCurve, turnReaching } from '../analysis/drawOdds.js';

// "What are the odds I've drawn N of these by turn T?" — phase 2 of the deck
// analysis, and the first piece with a question in it rather than a count.
//
// The group picker is the search bar. Every term the app already understands
// works here — `type:land`, `otag:removal`, `cmc<=2`, `c:r`, `-type:creature` —
// which means the feature shipped with a vocabulary of four thousand oracle
// tags on the day it was written, and a saved query is a saved group later.
//
// Exact, not simulated: this is a hypergeometric, so the number is the number.
// What it does *not* model is anything order-dependent (mana available,
// taplands, mulligan decisions) — those need the simulator, and the fine print
// says so rather than letting the precision imply more than it earns.

interface Preset {
  label: string;
  query: string;
  /** The copy count that makes this preset the question people actually ask. */
  min: number;
}

const PRESETS: readonly Preset[] = [
  { label: 'Lands', query: 'type:land', min: 3 },
  { label: 'Ramp', query: 'otag:ramp', min: 1 },
  { label: 'Removal', query: 'otag:removal', min: 1 },
  { label: 'Creatures', query: 'type:creature', min: 2 },
  { label: 'Cheap spells', query: 'cmc<=2 -type:land', min: 2 },
];

/** Nobody asks "the odds of at least seven" of anything; the stepper stops before it gets silly. */
const MAX_COPIES = 6;

const pct = (p: number) => `${Math.round(p * 100)}%`;
const turnLabel = (turn: number) => (turn === 0 ? 'Open' : String(turn));

export function DrawOddsPanel({ rows, format }: { rows: readonly GroupRow[]; format: DeckFormat | undefined }) {
  // `otag:` resolves its slug at parse time, so re-run once the vocabulary lands.
  const tagsVersion = useOracleTags();
  const [query, setQuery] = useState(PRESETS[0]!.query);
  const [min, setMin] = useState(PRESETS[0]!.min);
  const [onPlay, setOnPlay] = useState(true);

  const library = useMemo(() => librarySize(rows), [rows]);
  const group = useMemo(() => resolveGroup(rows, query), [rows, query, tagsVersion]);
  const curve = useMemo(
    () => oddsCurve({ library, handSize: handSize(format, 0), onPlay }, group.copies, min),
    [library, format, onPlay, group.copies, min],
  );

  const open = curve.points[0]!;
  const last = curve.points[curve.points.length - 1]!;
  const half = turnReaching(curve, 0.5);

  return (
    <>
      <h3 className="deck-stats-head">Draw odds</h3>
      <div className="odds-presets">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`odds-chip${query === p.query ? ' odds-chip-on' : ''}`}
            onClick={() => {
              setQuery(p.query);
              setMin(p.min);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <input
        className="odds-query"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="type:land, otag:removal, cmc<=2…"
        aria-label="Cards to count"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <div className="odds-controls">
        <div className="odds-stepper">
          <span>At least</span>
          <button type="button" onClick={() => setMin((n) => Math.max(1, n - 1))} disabled={min <= 1} aria-label="One fewer copy">
            −
          </button>
          <strong aria-live="polite">{min}</strong>
          <button
            type="button"
            onClick={() => setMin((n) => Math.min(MAX_COPIES, n + 1))}
            disabled={min >= MAX_COPIES}
            aria-label="One more copy"
          >
            +
          </button>
        </div>
        <div className="seg-row odds-seg" role="radiogroup" aria-label="Play or draw">
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
      </div>

      <p className="deck-stats-verdict">{headline(query, group.copies, library, min, open.p, last.p, curve.impossible)}</p>
      {/* Which cards a query caught is half the answer: a group picker made of
          search terms is only trustworthy if you can see what it matched. */}
      {group.names.length > 0 && <p className="fine-print odds-names">{nameList(group.names)}</p>}

      {group.copies > 0 && !curve.impossible && (
        <div className="curve odds-curve" role="img" aria-label={curveLabel(curve.points, min)}>
          {curve.points.map((pt) => (
            <div key={pt.turn} className="curve-col">
              {/* The bar measures against a track rather than the column, because
                  these heights are absolute (0-100%), not a share of a tallest
                  bucket: 59% has to *look* like 59%, and a percentage of the
                  column would be a percentage of a box the labels also live in.
                  The reading rides on the bar for the same reason — at 8% a
                  number parked at the top of the chart belongs to nothing. */}
              <div className="odds-track">
                <div className="curve-bar" style={{ height: `${pt.p * 100}%` }}>
                  <span className="curve-count">{Math.round(pt.p * 100)}</span>
                </div>
              </div>
              <span className="curve-tick">{turnLabel(pt.turn)}</span>
            </div>
          ))}
        </div>
      )}

      <p className="fine-print">
        {group.copies > 0 && !curve.impossible && half !== null && half > 0 && `More likely than not from turn ${half}. `}
        {group.inCommandZone > 0 && 'Your commander matches too, and you always have it. '}
        {group.unknown > 0 && `${group.unknown} cards here aren't in your card database, so they can't be counted. `}
        Exact odds for a library of {library}, no mulligans and no card selection. Fetching, scrying and digging all beat these numbers.
      </p>
    </>
  );
}

function headline(
  query: string,
  copies: number,
  library: number,
  min: number,
  open: number,
  last: number,
  impossible: boolean,
): ReactNode {
  if (library === 0) return 'Nothing in the mainboard to draw from yet.';
  // A blank field is unfilled, not a question with a boring answer.
  if (!query.trim()) return 'Pick a group above, or type any search: a card name, type:instant, otag:draw, c:r cmc<=3.';
  if (copies === 0) return 'Nothing in the library matches that search.';
  if (impossible) {
    return (
      <>
        <strong>
          {copies} cop{copies === 1 ? 'y' : 'ies'} in the deck.
        </strong>{' '}
        You can't draw {min} of them, so the answer is never.
      </>
    );
  }
  return (
    <>
      <strong>
        {copies} of your {library}.
      </strong>{' '}
      {pct(open)} chance of {min === 1 ? 'one' : min} in your opening hand, {pct(last)} by turn {MAX_TURN}.
    </>
  );
}

/** The matched cards, truncated — a 24-land list would bury the chart. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 4).join(', ');
  return names.length <= 4 ? shown : `${shown} and ${names.length - 4} more`;
}

function curveLabel(points: readonly { turn: number; p: number }[], min: number): string {
  const bits = points.map((pt) => `${pt.turn === 0 ? 'opening hand' : `turn ${pt.turn}`}: ${Math.round(pt.p * 100)}%`);
  return `Odds of at least ${min}. ${bits.join(', ')}.`;
}
