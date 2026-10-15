import { useState } from 'react';
import { DECK_FORMATS, type DeckFormat } from '@mtg/shared';
import { formatLabel, type LegalityReport } from '../deck/legality.js';
import type { DeckManaStats } from '../deck/manaStats.js';
import { DeckStatsLine } from './DeckStatsLine.js';
import { Icon } from './icons.js';

// The deck page's header under the name: one summary row, and the detail it
// folds away. Before this the format select, the owned line, a full-width
// legality box and the lands row stacked up to ~480px above the first card on
// a phone. Its own file so the ContainerDetail split can take it as it is.

const plural = (n: number) => (n === 1 ? '' : 's');

interface Counts {
  /** Cards the list asks for (tokens and Considering left out). */
  need: number;
  /** How many of those you own. */
  have: number;
}

/** A deck's summary: "Commander · 55/65 owned · Not legal 65/100 ⌄ | 33 lands ›". */
export function DeckSummary({
  format,
  onFormat,
  legality,
  counts,
  missingWorth,
  stats,
  onOpenMana,
}: {
  format: DeckFormat;
  onFormat: (f: DeckFormat) => void;
  legality: LegalityReport;
  counts: Counts;
  missingWorth?: string | undefined;
  stats: DeckManaStats;
  onOpenMana: () => void;
}) {
  // A fresh deck opens unfolded: picking the format is the first thing to do
  // with it, and there are no cards below to keep in view yet.
  const [open, setOpen] = useState(counts.need === 0);
  return (
    <div className="container-summary-wrap">
      <div className="container-summary">
        <button
          type="button"
          className="container-summary-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Hide format, legality and owned details' : 'Show format, legality and owned details'}
        >
          <span className="container-summary-bits">
            <span>{formatLabel(format)}</span>
            <span>{counts.need === 0 ? 'Empty' : `${counts.have}/${counts.need} owned`}</span>
            {legality.checked &&
              (legality.legal ? (
                <span className="summary-chip summary-chip-ok">Legal</span>
              ) : (
                <span className="summary-chip summary-chip-bad">
                  Not legal{legality.size && ` ${legality.size.count}/${legality.size.need}`}
                </span>
              ))}
          </span>
          <Icon name="chevronDown" size={16} />
        </button>
        {stats.total > 0 && (
          <button
            type="button"
            className="container-summary-lands"
            onClick={onOpenMana}
            aria-label={`${stats.lands} land${plural(stats.lands)}, ${stats.land.short}. Open the mana analysis`}
            title={stats.land.short}
          >
            <strong>{stats.lands}</strong>{' '}
            land{plural(stats.lands)}
            <Icon name="chevronRight" size={16} />
          </button>
        )}
      </div>
      {open && (
        <div className="container-summary-detail">
          <div className="deck-detail-meta">
            <label className="field" style={{ maxWidth: 160 }}>
              <span>Format</span>
              <select value={format} onChange={(e) => onFormat(e.target.value as DeckFormat)}>
                {DECK_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {formatLabel(f)}
                  </option>
                ))}
              </select>
            </label>
            {counts.need > 0 && (
              <p className="search-meta">
                You own <strong>{counts.have}</strong> of <strong>{counts.need}</strong> cards
                {missingWorth && <> · <strong>{missingWorth}</strong> missing</>}
              </p>
            )}
          </div>
          <LegalityPanel report={legality} format={format} />
          {stats.total > 0 && <DeckStatsLine stats={stats} onOpen={onOpenMana} />}
        </div>
      )}
    </div>
  );
}

/** A binder or box: no format, no legality, nothing to fold. */
export function StorageSummary({ counts, missingWorth }: { counts: Counts; missingWorth?: string | undefined }) {
  return (
    <p className="search-meta container-summary-static">
      <strong>{counts.need}</strong> card{plural(counts.need)} filed here
      {/* Filed but not in the collection: the app's records and the real
          shelf disagree, which is worth saying out loud. */}
      {counts.need > counts.have && (
        <> · <strong>{counts.need - counts.have}</strong> not in your collection</>
      )}
      {missingWorth && <> · <strong>{missingWorth}</strong> missing</>}
    </p>
  );
}

function LegalityPanel({ report, format }: { report: LegalityReport; format: DeckFormat }) {
  if (!report.checked) return <p className="fine-print">{formatLabel(format)} has no legality checks.</p>;
  // The summary row's chip already says it; a full-width green bar would only
  // repeat it.
  if (report.legal) return null;
  return (
    <div className="legality legality-bad">
      <strong>Not legal in {formatLabel(format)}</strong>
      <ul>
        {report.problems.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </div>
  );
}
