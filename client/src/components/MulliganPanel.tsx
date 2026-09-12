import { useMemo, useState, type ReactNode } from 'react';
import type { DeckFormat } from '@mtg/shared';
import { useOracleTags } from '../cardDb/useOracleTags.js';
import { librarySize, resolveGroup, type GroupRow } from '../analysis/groups.js';
import { KEEP_ANYTHING_AT, mulliganOutlook, type HandRow, type MulliganOutlook } from '../analysis/mulligan.js';

// "How often does this deck give me a hand worth keeping?" — phase 4.
//
// The group picker is the search bar again, so a keep rule is "two to five
// type:land" and nothing here is hard-coded to lands. What the panel refuses to
// do is tell you to mulligan: shipping a hand trades a card for a better land
// count, and this layer counts lands, not cards. It shows what each hand is
// worth against a hand you would have kept, which is a comparison between
// equals, and leaves the trade to you. The simulator gets to answer the rest.

interface Preset {
  label: string;
  query: string;
  /** Singular and plural, for the prose: "a seven with two lands". */
  noun: string;
  many: string;
  min: number;
  max: number;
  /** N of the group by turn N — "your third land by turn three". */
  need: number;
}

const PRESETS: readonly Preset[] = [
  { label: 'Lands', query: 'type:land', noun: 'land', many: 'lands', min: 2, max: 5, need: 3 },
  { label: 'Mana sources', query: 'is:manasource', noun: 'source', many: 'sources', min: 2, max: 5, need: 3 },
  { label: 'Cheap spells', query: 'cmc<=2 -type:land', noun: 'cheap spell', many: 'cheap spells', min: 1, max: 7, need: 2 },
];

/** A hand-typed query gets a neutral noun: "3 matches" is clumsy and true, "3 lands" would be neither. */
const ANY: Pick<Preset, 'noun' | 'many'> = { noun: 'match', many: 'matches' };

const MAX_IN_HAND = 7;
/** Below this, a row is a hand you will not be dealt this decade. */
const RARE = 0.005;

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function MulliganPanel({ rows, format }: { rows: readonly GroupRow[]; format: DeckFormat | undefined }) {
  // `otag:` and `is:` resolve their slugs at parse time, so re-run once the
  // tag vocabulary lands.
  const tagsVersion = useOracleTags();
  const [query, setQuery] = useState(PRESETS[0]!.query);
  const [min, setMin] = useState(PRESETS[0]!.min);
  const [max, setMax] = useState(PRESETS[0]!.max);
  const [need, setNeed] = useState(PRESETS[0]!.need);
  const [onPlay, setOnPlay] = useState(true);

  const { noun, many } = PRESETS.find((p) => p.query === query) ?? ANY;

  const library = useMemo(() => librarySize(rows), [rows]);
  const group = useMemo(() => resolveGroup(rows, query), [rows, query, tagsVersion]);
  const out = useMemo(
    // The goal turn is the goal count: your third land wants to be there on
    // turn three. One number, and it is the one people already think in.
    () => mulliganOutlook(library, format, { copies: group.copies, min, max }, { need, turn: need }, { onPlay }),
    [library, format, group.copies, min, max, need, onPlay],
  );

  const usable = library > 0 && group.copies > 0;
  const shown = out.rows.filter((r) => r.pDealt >= RARE);
  const count = (n: number) => `${n} ${n === 1 ? noun : many}`;

  const apply = (p: Preset) => {
    setQuery(p.query);
    setMin(p.min);
    setMax(p.max);
    setNeed(p.need);
  };

  return (
    <>
      <h3 className="deck-stats-head">Opening hand</h3>
      <div className="odds-presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className={`odds-chip${query === p.query ? ' odds-chip-on' : ''}`} onClick={() => apply(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <input
        className="odds-query"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="type:land, is:manasource, cmc<=2…"
        aria-label="Cards the keep rule counts"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <div className="odds-controls">
        <div className="odds-stepper">
          <span>Keep</span>
          <Step
            value={min}
            lo={0}
            hi={MAX_IN_HAND}
            label="keep minimum"
            onChange={(n) => {
              setMin(n);
              if (n > max) setMax(n);
            }}
          />
          <span>to</span>
          <Step
            value={max}
            lo={0}
            hi={MAX_IN_HAND}
            label="keep maximum"
            onChange={(n) => {
              setMax(n);
              if (n < min) setMin(n);
            }}
          />
          <span>{many}</span>
        </div>
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
      </div>

      <p className="deck-stats-verdict">{headline(query, library, group.copies, out, count)}</p>

      {usable && (
        <>
          <ul className="mull-sizes">
            {out.handSizes.map((r) => (
              <li key={r.cards} className="mull-size">
                <span className="mull-size-n">
                  {r.cards} card{r.cards === 1 ? '' : 's'}
                  {r.cards === KEEP_ANYTHING_AT && ' or fewer'}
                </span>
                <span className="mull-size-track">
                  <span className="mull-size-fill" style={{ width: `${r.p * 100}%` }} />
                </span>
                <span className="mull-size-p">{r.p > 0 && r.p < 0.005 ? '<1%' : pct(r.p)}</span>
              </li>
            ))}
          </ul>
          <p className="fine-print">
            Average opening hand {out.expectedHandSize.toFixed(1)} cards.
            {out.freeMulligan && ' Your first mulligan in Commander is free, so a seven is still a seven.'} The rule stops applying at{' '}
            {KEEP_ANYTHING_AT}: nobody ships a five over a {noun} count.
          </p>

          <div className="odds-controls">
            <div className="odds-stepper">
              <span>On track:</span>
              <Step value={need} lo={1} hi={5} label="goal count" onChange={setNeed} />
              <span>
                {many} by turn {need}
              </span>
            </div>
          </div>
          <p className="deck-stats-verdict">
            {/* Set the keep minimum at or above the goal and every hand you keep
                is there before you draw, so a reference of 100% says nothing. */}
            {min >= need ? (
              <>
                <strong>Every seven you would keep already holds {count(need)}.</strong> The hands below are the ones your rule ships.
              </>
            ) : (
              <>
                <strong>A seven you would keep gets there {pct(out.pTypical)} of the time.</strong> Every hand below is measured against
                that.
              </>
            )}
          </p>
          <ul className="mull-hands">
            {shown.map((r) => (
              <li key={r.inHand} className={`mull-hand mull-hand-${r.verdict}`}>
                <span className="mull-hand-n">{count(r.inHand)}</span>
                <span className="mull-hand-tag">{TAGS[r.verdict]}</span>
                <span className="mull-hand-freq">{pct(r.pDealt)} of sevens</span>
                {/* A hand already holding the goal is at 100% by definition, and a
                    column of identical hundreds says nothing. Name it instead. */}
                {r.inHand >= need ? <span className="mull-hand-p mull-hand-done">already there</span> : <span className="mull-hand-p">{pct(r.pGoal)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="fine-print">
        {group.inCommandZone > 0 && 'Your commander matches too, and it is never in your opening hand. '}
        {group.unknown > 0 && `${group.unknown} cards here aren't in your card database, so they can't be counted. `}
        London: every mulligan deals a fresh seven from the whole deck, so your odds of seeing a keepable hand never change. What a
        mulligan costs is a card. That is also why nothing here tells you to take one: shipping a hand trades a card for a better {noun}{' '}
        count, this panel counts {many} and not cards, and only you know what the card was.
      </p>
    </>
  );
}

const TAGS: Record<HandRow['verdict'], string> = { keep: 'keep', short: 'too few', flood: 'too many' };

/** The minus/plus pair. Two of them make the keep range, which is why it is its own thing. */
function Step({
  value,
  lo,
  hi,
  label,
  onChange,
}: {
  value: number;
  lo: number;
  hi: number;
  label: string;
  onChange: (n: number) => void;
}) {
  return (
    <>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= lo} aria-label={`Lower ${label}`}>
        −
      </button>
      <strong aria-live="polite">{value}</strong>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= hi} aria-label={`Raise ${label}`}>
        +
      </button>
    </>
  );
}

function headline(query: string, library: number, copies: number, out: MulliganOutlook, count: (n: number) => string): ReactNode {
  if (library === 0) return 'Nothing in the mainboard to shuffle up yet.';
  // A blank field is unfilled, not a rule that rejects everything.
  if (!query.trim()) return 'Pick a group above, or type any search: type:land, is:untappedsource, cmc<=2.';
  if (copies === 0) return 'Nothing in the library matches that search, so every hand fails the rule.';
  return (
    <>
      <strong>{pct(out.pKeepable)} of your sevens are keepable.</strong> {pct(out.pMulligan)} of your games start a card down, on{' '}
      {count(copies)} in {library}.
    </>
  );
}
