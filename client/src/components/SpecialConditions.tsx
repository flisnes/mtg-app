import { useState } from 'react';
import {
  SPECIAL_CONDITIONS,
  SPECIAL_CONDITION_LABELS,
  normalizeSpecialConditions,
  specialLabel,
  type SpecialCondition,
} from '@mtg/shared';
import { Icon } from './icons.js';

// What's remarkable about one piece of cardboard beyond its grade: altered,
// signed, misprint, miscut, crimped. Several can be true of the same card, so
// the picker is a checkbox list rather than a select, and the boxes unfold in
// flow under the trigger — the card sheet's body is a scroll container, and a
// floating panel would be clipped by it (the same reason EditionPicker does).
//
// This is an annotation on cardboard you own, never a fact about the card: no
// wish, deck slot or ownership count reads it (see SpecialCondition in
// shared/user.ts). It does split the collection row it sits on, so your altered
// Bolt is its own line next to the plain one.

/**
 * The "A" mark a copy with any special condition wears in lists and on tiles.
 * Shaped like the placement badge so CardItem can carry it the same way.
 */
export function specialMark(
  special: readonly SpecialCondition[] | undefined,
): { node: string; cls: string; title: string } | undefined {
  if (!special?.length) return undefined;
  return { node: 'A', cls: 'badge-special', title: specialLabel(special) };
}

export function SpecialConditionsField({
  value,
  onChange,
  disabled = false,
}: {
  value: SpecialCondition[];
  onChange: (next: SpecialCondition[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary = specialLabel(value) || 'None';

  function toggle(s: SpecialCondition) {
    const next = value.includes(s) ? value.filter((v) => v !== s) : [...value, s];
    onChange(normalizeSpecialConditions(next) ?? []);
  }

  return (
    <div className={`field special-field${open ? ' open' : ''}`}>
      <span>Special</span>
      <button
        type="button"
        className="special-trigger"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={value.length ? 'special-summary' : 'special-summary special-summary-none'}>{summary}</span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div className="special-list" role="group" aria-label="Special conditions">
          {SPECIAL_CONDITIONS.map((s) => {
            const checked = value.includes(s);
            return (
              <button
                key={s}
                type="button"
                className="special-row"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggle(s)}
              >
                <span className={`select-box${checked ? ' checked' : ''}`} aria-hidden>
                  {checked && <Icon name="check" size={14} />}
                </span>
                {SPECIAL_CONDITION_LABELS[s]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
