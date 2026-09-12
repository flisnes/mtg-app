import { useMemo } from 'react';
import type { DeckFormat } from '@mtg/shared';
import { ManaCost } from './ManaCost.js';
import { manaReport, shortfallHeadline, colorName, type CastCheck, type SourceRow } from '../analysis/manaSources.js';

// "Can I actually cast this?" — the colored-source half of the deck's mana,
// where the land-count verdict is the colorless half.
//
// It leads with the worst offender rather than a table, because a table of
// thirty cards at 94% buries the one at 61% that is losing you games. The
// table is still there underneath it, worst first, and stops before it becomes
// a decklist.

/** Enough rows to see a pattern, few enough that the sheet stays a sheet. */
const MAX_ROWS = 6;

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function ColorSourcesPanel({
  rows,
  library,
  format,
}: {
  rows: readonly SourceRow[];
  library: number;
  format: DeckFormat | undefined;
}) {
  // On the play, always: it is the harsher of the two by one card, and a
  // deckbuilding check that only holds up when you win the die roll isn't one.
  const report = useMemo(() => manaReport(rows, library, format, { onPlay: true }), [rows, library, format]);

  return (
    <>
      <h3 className="deck-stats-head">Colored sources</h3>
      {!report.hasManaData ? (
        <p className="fine-print">
          Your card database predates this data. Refresh it from About to see whether your colors line up with your costs.
        </p>
      ) : (
        <>
          <div className="source-chips">
            {report.byColor.map((c) => (
              <span key={c.color} className="source-chip" title={`${c.count} ${colorName([c.color])} sources`}>
                <ManaCost cost={`{${c.color}}`} />
                <strong>{c.count}</strong>
                {c.slow > 0 && <span className="source-chip-slow">{c.slow} tapped</span>}
              </span>
            ))}
          </div>
          <p className="deck-stats-verdict">{verdict(report.checks, report.shortfalls)}</p>
          {report.shortfalls.length > 0 && (
            <ul className="source-rows">
              {report.shortfalls.slice(0, MAX_ROWS).map((c) => (
                <li key={c.oracleId} className={c.uncastable ? 'source-row source-row-bad' : 'source-row'}>
                  <span className="source-row-name">{c.name}</span>
                  <ManaCost cost={c.manaCost} className="source-row-cost" />
                  <span className="source-row-p">{c.uncastable ? 'never' : pct(c.p)}</span>
                  <span className="source-row-note">{rowNote(c)}</span>
                </li>
              ))}
            </ul>
          )}
          {report.shortfalls.length > MAX_ROWS && (
            <p className="fine-print">And {report.shortfalls.length - MAX_ROWS} more below 90%.</p>
          )}
          <p className="fine-print">
            Each card is held to its mana value as the turn to cast it, at a 90% bar, worked out exactly for a library of{' '}
            {report.library} on the play with no mulligans. Karsten's published tables ask two to four fewer, because his simulations get
            to mulligan for a source. Lands that always enter tapped count from turn two, rocks and dorks a turn after you could cast them.
            Colors are checked one at a time, so a two-color card can pass both halves and still stumble on the draw that gives you one of
            each.
            {report.unmodelled > 0 && ` ${report.unmodelled} cost${report.unmodelled === 1 ? '' : 's'} here use {X} or snow, taken at face value.`}
          </p>
        </>
      )}
    </>
  );
}

function verdict(checks: readonly CastCheck[], shortfalls: readonly CastCheck[]) {
  if (checks.length === 0) return 'Nothing in this deck asks for colored mana.';
  if (shortfalls.length === 0) {
    return (
      <>
        <strong className="tone-ok">The mana is there.</strong> All {checks.length} colored card
        {checks.length === 1 ? '' : 's'} clear 90% on curve.
      </>
    );
  }
  const worst = shortfalls[0]!;
  const rest = shortfalls.length - 1;
  return (
    <>
      <strong>{shortfallHeadline(worst)}</strong>
      {rest > 0 && ` ${rest} other card${rest === 1 ? '' : 's'} ${rest === 1 ? 'is' : 'are'} short too.`}
    </>
  );
}

/** The right-hand clause: what is missing, or how far off the count is. */
function rowNote(c: CastCheck): string {
  if (c.uncastable) return `no ${c.missing.map((m) => colorName([m])).join(' or ')} mana`;
  const short = Math.max(1, c.needed - c.sources);
  return `turn ${c.turn} · ${c.sources} of ${c.needed} ${colorName(c.colors)} (${short} short)`;
}
