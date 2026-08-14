import { CONDITIONS, FINISHES, type Condition, type Finish } from '@mtg/shared';
import { FINISH_LABELS, LANGS } from '../components/CardSheet.js';
import type { ImportDefaults } from './types.js';

// Two controls the import screens were missing, both borrowed from things the
// scanner already does well.

/**
 * The scanner's pile pins, for a pasted list: say once that the whole file is
 * lightly played Japanese foils. Only fills in what a line doesn't state for
 * itself — a CSV with condition/language/finish columns still wins, line by line.
 */
export const IMPORT_DEFAULTS: ImportDefaults = { condition: 'NM', finish: 'nonfoil', lang: 'en' };

export function ImportDefaultsRow({
  value,
  onChange,
  /** Wishes are for a printing, not a graded copy, so the wishlist hides condition. */
  showCondition = true,
}: {
  value: ImportDefaults;
  onChange: (v: ImportDefaults) => void;
  showCondition?: boolean;
}) {
  return (
    <>
      <div className="chips" role="group" aria-label="Details for the whole list">
        {showCondition && (
          <label className="chip">
            Condition:{' '}
            <select
              value={value.condition}
              onChange={(e) => onChange({ ...value, condition: e.target.value as Condition })}
              aria-label="Condition for the whole list"
            >
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="chip">
          Finish:{' '}
          <select
            value={value.finish}
            onChange={(e) => onChange({ ...value, finish: e.target.value as Finish })}
            aria-label="Finish for the whole list"
          >
            {FINISHES.map((f) => (
              <option key={f} value={f}>
                {FINISH_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="chip">
          Language:{' '}
          <select
            value={value.lang}
            onChange={(e) => onChange({ ...value, lang: e.target.value })}
            aria-label="Language for the whole list"
          >
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="fine-print">
        Lines that name their own condition, finish or language keep it — this only fills in the rest.
      </p>
    </>
  );
}

/**
 * "You already have some of these." The collection's duplicate screen decides
 * card by card because a collection is a heap of individual copies; a decklist
 * or a wishlist is a statement about quantities, so one answer for the whole
 * list is the honest shape of the question.
 */
export type OverlapMode = 'add' | 'skip' | 'top-up';

const OVERLAP_OPTIONS: { value: OverlapMode; label: string }[] = [
  { value: 'add', label: 'Add on top' },
  { value: 'skip', label: 'Skip those' },
  { value: 'top-up', label: 'Top up to the listed count' },
];

export function OverlapChoice({
  count,
  where,
  value,
  onChange,
}: {
  /** How many of the list's cards are already there. */
  count: number;
  /** "in this deck" / "on your wishlist". */
  where: string;
  value: OverlapMode;
  onChange: (m: OverlapMode) => void;
}) {
  return (
    <div className="about-section">
      <h2>Already {where}</h2>
      <p className="fine-print">
        {count} card{count === 1 ? '' : 's'} in this list {count === 1 ? 'is' : 'are'} already {where}.{' '}
        <strong>Add on top</strong> stacks the list onto what's there, <strong>Skip those</strong> imports only the rest,
        and <strong>Top up</strong> adds just enough to reach the count the list asks for.
      </p>
      <div className="chips" role="group" aria-label="What to do about cards already there">
        {OVERLAP_OPTIONS.map((o) => (
          <button
            key={o.value}
            className="chip"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Apply an overlap choice to the lines about to be written, given how many of
 * each card is already there. Returns the lines that should actually land.
 */
export function applyOverlap<T extends { quantity: number }>(
  lines: T[],
  mode: OverlapMode,
  /** Copies already there, per target key. */
  have: Map<string, number>,
  keyOf: (line: T) => string,
): T[] {
  if (mode === 'add') return lines;
  // A list can name the same card twice (two boards, or a sloppy paste), so the
  // copies already there are spent down rather than counted against every line.
  const remaining = new Map(have);
  const out: T[] = [];
  for (const l of lines) {
    const key = keyOf(l);
    const already = remaining.get(key) ?? 0;
    if (mode === 'skip') {
      if (already <= 0) out.push(l);
      continue;
    }
    const take = l.quantity - already;
    if (take <= 0) {
      remaining.set(key, already - l.quantity);
      continue;
    }
    remaining.set(key, 0);
    out.push({ ...l, quantity: take });
  }
  return out;
}
