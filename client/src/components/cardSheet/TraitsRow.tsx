import { useState } from 'react';
import type { Condition, Finish, SpecialCondition } from '@mtg/shared';
import { CONDITIONS, SPECIAL_CONDITIONS, SPECIAL_CONDITION_LABELS, normalizeSpecialConditions, specialLabel } from '@mtg/shared';
import { FINISH_LABELS, LANGS } from '@mtg/shared';
import { Icon } from '../icons.js';
import { SheetSelectField, SheetSelectList, type SheetSelectOption } from '../SheetSelect.js';
import type { ModeFlags } from './modeFlags.js';
import type { CardForm } from './useCardForm.js';
import type { TraitKey } from './types.js';

type Flags = Pick<ModeFlags, 'showCondition' | 'showFinish' | 'showLang' | 'anyPrefs' | 'collectionFields' | 'formEditable' | 'wishInfo'>;

/** The copy's traits as words, in the same words the fields use, so the
 *  summary and the open form never disagree. */
function traitWordsOf(flags: Flags, form: Pick<CardForm, 'condition' | 'finish' | 'lang'>): string[] {
  const { condition, finish, lang } = form;
  const words: string[] = [];
  if (flags.showCondition) words.push(condition ? (flags.anyPrefs ? `${condition} or better` : condition) : 'Any condition');
  if (flags.showFinish) words.push(finish ? FINISH_LABELS[finish] : 'Any finish');
  if (flags.showLang) words.push(lang ? lang.toUpperCase() : 'Any language');
  return words;
}

/**
 * Condition, finish, language and special conditions as one line.
 *
 * Nothing to change here (a copy you're only looking at, someone else's wish):
 * the answers as text, with the quantity riding along since there's no stepper
 * to carry it. Yours to change: the same line, tappable, unfolding into four
 * dropdowns on one row. Remount it (key) to fold it back up.
 */
export function TraitsRow({
  flags,
  form,
  forTrade,
  availableFinishes,
  hidden,
  onChange,
}: {
  flags: Flags;
  /** The form, with the finish already clamped to the printing. */
  form: CardForm;
  /** For trade, clamped to the quantity. */
  forTrade: number;
  availableFinishes: readonly Finish[];
  /** A lands-box basic claims no copy of yours, so it prefers nothing. */
  hidden: boolean;
  onChange: (patch: Partial<CardForm>) => void;
}) {
  // 'row': the four triggers are unfolded; a key: that one's list is open too.
  // One piece of state, because they behave as one control: opening Language
  // puts Condition away.
  const [open, setOpen] = useState<TraitKey | 'row' | null>(null);
  const { special, quantity } = form;
  const words = traitWordsOf(flags, form);
  if (words.length === 0 || hidden) return null;

  if (!flags.formEditable) {
    return (
      <div className="sheet-copy-summary">
        {flags.wishInfo && <span className="sheet-copy-label">Wants</span>}
        {words.map((w) => (
          <span key={w}>{w}</span>
        ))}
        {special.length > 0 && <span className="sheet-copy-special">{specialLabel(special)}</span>}
        <span className="sheet-copy-qty">
          ×{quantity}
          {forTrade > 0 ? ` · ${forTrade} for trade` : ''}
        </span>
      </div>
    );
  }

  // Folded up, the line has to account for the fourth dropdown as well.
  const summary = [...words, ...(special.length > 0 ? [specialLabel(special)] : [])].join(' · ');
  const fields = traitFields(flags, form, availableFinishes, onChange);
  const openField = fields.find((f) => f.key === open);
  return (
    <div className={open ? 'sheet-traits open' : 'sheet-traits'}>
      <button
        type="button"
        className="sheet-traits-trigger"
        aria-expanded={!!open}
        onClick={() => setOpen((v) => (v ? null : 'row'))}
      >
        <span className="sheet-traits-summary">{summary}</span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div className="field-row">
          {fields.map((f) => (
            <SheetSelectField
              key={f.key}
              label={f.label}
              summary={f.summary}
              detail={f.detail}
              muted={f.muted}
              open={open === f.key}
              onToggle={() => setOpen((cur) => (cur === f.key ? 'row' : f.key))}
            />
          ))}
        </div>
      )}
      {/* The one open list, under the whole row. Picking a single answer is the
          end of the question, so it closes; ticking one of several isn't, so
          Special stays open. */}
      {openField && (
        <SheetSelectList
          key={openField.key}
          label={openField.label}
          options={openField.options}
          selected={openField.selected}
          multi={openField.multi}
          onPick={(v) => {
            openField.onPick(v);
            if (!openField.multi) setOpen('row');
          }}
        />
      )}
    </div>
  );
}

interface TraitField {
  key: TraitKey;
  label: string;
  summary: string;
  detail?: string;
  muted: boolean;
  options: SheetSelectOption[];
  selected: string[];
  multi?: boolean;
  onPick: (value: string) => void;
}

/** The traits row as data. Written out once rather than four near-identical
 *  blocks of JSX, because the trigger and its list are rendered in two
 *  different places and had to agree. */
function traitFields(
  flags: Flags,
  form: CardForm,
  availableFinishes: readonly Finish[],
  onChange: (patch: Partial<CardForm>) => void,
): TraitField[] {
  const { condition, finish, lang, special } = form;
  const anyOption: SheetSelectOption[] = flags.anyPrefs ? [{ value: '', label: 'Any' }] : [];
  const fields: TraitField[] = [];
  if (flags.showCondition) {
    fields.push({
      key: 'condition',
      label: flags.anyPrefs ? 'Min. condition' : 'Condition',
      summary: condition || 'Any',
      muted: !condition,
      options: [...anyOption, ...CONDITIONS.map((c) => ({ value: c, label: c }))],
      selected: [condition],
      onPick: (v) => onChange({ condition: v as Condition | '' }),
    });
  }
  if (flags.showFinish) {
    fields.push({
      key: 'finish',
      label: 'Finish',
      summary: finish ? FINISH_LABELS[finish] : 'Any',
      muted: !finish,
      options: [...anyOption, ...availableFinishes.map((f) => ({ value: f, label: FINISH_LABELS[f] }))],
      selected: [finish],
      onPick: (v) => onChange({ finish: v as Finish | '' }),
    });
  }
  if (flags.showLang) {
    fields.push({
      key: 'lang',
      label: 'Language',
      summary: lang ? lang.toUpperCase() : 'Any',
      muted: !lang,
      options: [...anyOption, ...LANGS.map((l) => ({ value: l, label: l.toUpperCase() }))],
      selected: [lang],
      onPick: (v) => onChange({ lang: v }),
    });
  }
  // Altered, signed, misprint …: a fact about this piece of cardboard, not about
  // the card, so only a collection copy is asked, and the one field here that
  // takes more than one answer. Ticking a box splits the copy onto its own line
  // — your altered Bolt stops sharing a row with the plain one — while every
  // match (wish, deck slot, owned count) carries on ignoring it.
  if (flags.collectionFields) {
    fields.push({
      key: 'special',
      label: 'Special',
      // In a quarter of a phone's width "Altered, Signed" truncates to
      // "Altere…", which says less than a count does. The line above spells
      // them all out.
      summary: special.length === 0 ? 'None' : special.length === 1 ? specialLabel(special) : `${special.length} selected`,
      detail: special.length > 1 ? specialLabel(special) : undefined,
      muted: special.length === 0,
      options: SPECIAL_CONDITIONS.map((sc) => ({ value: sc, label: SPECIAL_CONDITION_LABELS[sc] })),
      selected: special,
      multi: true,
      onPick: (v) => {
        const sc = v as SpecialCondition;
        const next = special.includes(sc) ? special.filter((x) => x !== sc) : [...special, sc];
        onChange({ special: normalizeSpecialConditions(next) ?? [] });
      },
    });
  }
  return fields;
}
