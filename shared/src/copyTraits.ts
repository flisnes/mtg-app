import type { Finish } from './card.js';
import { specialLabel, type SpecialCondition } from './user.js';

// The words and codes for a copy's finish and language, and the one way a
// copy's traits are spelled out on a line. Shared data: the scan session, the
// intake model and the sealed openers read it, none of which should pull a
// React component in for a label.

export const FINISH_LABELS: Record<Finish, string> = { nonfoil: 'Nonfoil', foil: 'Foil', etched: 'Etched' };

/** The languages a copy can be set to, as Scryfall codes. */
export const LANGS = ['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht'];

/** Language names, for tooltips and Settings. Keyed like Scryfall's codes. */
export const LANG_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  zhs: 'Chinese (Simplified)',
  zht: 'Chinese (Traditional)',
  ph: 'Phyrexian',
  la: 'Latin',
  grc: 'Ancient Greek',
  ar: 'Arabic',
  sa: 'Sanskrit',
  he: 'Hebrew',
  qya: 'Quenya',
};

/** Spelled-out language name, falling back to the raw code Scryfall gave us. */
export function langName(lang: string): string {
  return LANG_NAMES[lang] ?? lang;
}

/** The traits a copy, a slot or a wish can name. Empty and missing both read as "any". */
export interface CopyTraitsLike {
  condition?: string | null;
  finish?: Finish | (string & {}) | null;
  lang?: string | null;
  special?: readonly SpecialCondition[] | null;
}

export interface TraitsLineOptions {
  /** Leads the line: the edition's set name, or its set code and number. */
  lead?: string | null;
  /** The condition is a floor, as on a wish or a slot: "min NM". */
  min?: boolean;
  /** The plain values left unsaid. By default nonfoil and English go without
   *  saying and the condition is always said; `{ condition: 'NM' }` quiets that
   *  too, and `{ finish: null }` says every finish. */
  quiet?: { condition?: string | null; finish?: string | null; lang?: string | null };
}

/**
 * "NM · Foil · ja · Signed": a copy's traits on one line, the unremarkable
 * defaults left unsaid, with the set name in front when the caller has it.
 * Every sub-line, chip and filing prompt that names a copy goes through here,
 * so the same copy reads the same everywhere.
 */
export function traitsLine(copy: CopyTraitsLike, opts: TraitsLineOptions = {}): string {
  const quiet = { finish: 'nonfoil', lang: 'en', ...opts.quiet };
  const bits: string[] = [];
  if (opts.lead) bits.push(opts.lead);
  if (copy.condition && copy.condition !== quiet.condition) bits.push(opts.min ? `min ${copy.condition}` : copy.condition);
  if (copy.finish && copy.finish !== quiet.finish) bits.push(FINISH_LABELS[copy.finish as Finish] ?? copy.finish);
  if (copy.lang && copy.lang !== quiet.lang) bits.push(copy.lang);
  if (copy.special?.length) bits.push(specialLabel(copy.special));
  return bits.join(' · ');
}
