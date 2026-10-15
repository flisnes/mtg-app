import type { Finish } from '@mtg/shared';

// The words and codes for a copy's finish and language, in one place so a
// picker doesn't have to import the whole card sheet to label its options.

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
