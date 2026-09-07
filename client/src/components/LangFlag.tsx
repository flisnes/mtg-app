import type { ReactNode } from 'react';
import { getPrefs } from '../prefs.js';

// "This piece of cardboard isn't in my language." A tiny flag in the corner of a
// card, next to the ownership checkmark and the filing badge, whenever a copy's
// language differs from the one you set in Settings (English out of the box).
//
// Why a flag and not the two-letter code: the code is already in the subtitle
// line of every list row, and a subtitle is exactly what a grid tile doesn't
// have. A shape you recognise without reading survives being 14 pixels wide on
// top of a full-bleed card image; "zht" does not.
//
// The flags are hand-rolled SVG rather than emoji on purpose. Windows ships no
// glyphs for the regional-indicator pairs, so 🇪🇸 renders as the letters "ES" in
// a box there — and half this app's testing happens on Windows. Drawn shapes
// look the same everywhere, scale to any badge size, and cost no font.
//
// Approximations, deliberately: at this size the ROC sun is a white dot, Korea's
// taegeuk loses its trigrams, and China gets one star instead of five. Each is
// still the only flag in the set with that silhouette, which is all a badge has
// to do. A language with no flag here (Phyrexian, or anything Scryfall adds
// later) falls back to its code in the same chip.

/** Language names, for the badge's tooltip. Keyed like Scryfall's codes. */
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

/** A five-pointed star, points up, centred on the origin with outer radius 1. */
const STAR =
  'M0 -1 0.2245 -0.309 0.951 -0.309 0.363 0.118 0.588 0.809 0 0.382 -0.588 0.809 -0.363 0.118 -0.951 -0.309 -0.2245 -0.309Z';

// Every flag draws into the same 3:2 box, so they line up in a row and a caller
// only has to pick a height.
const FLAGS: Record<string, ReactNode> = {
  en: (
    <>
      <rect width="60" height="40" fill="#012169" />
      <path d="M0 0 60 40M60 0 0 40" fill="none" stroke="#fff" strokeWidth="9" />
      <path d="M30 0V40M0 20H60" fill="none" stroke="#fff" strokeWidth="14" />
      <path d="M30 0V40M0 20H60" fill="none" stroke="#c8102e" strokeWidth="8" />
    </>
  ),
  de: (
    <>
      <rect width="60" height="13.34" fill="#000" />
      <rect y="13.34" width="60" height="13.34" fill="#d00" />
      <rect y="26.67" width="60" height="13.34" fill="#ffce00" />
    </>
  ),
  fr: (
    <>
      <rect width="20" height="40" fill="#002395" />
      <rect x="20" width="20" height="40" fill="#fff" />
      <rect x="40" width="20" height="40" fill="#ed2939" />
    </>
  ),
  it: (
    <>
      <rect width="20" height="40" fill="#008c45" />
      <rect x="20" width="20" height="40" fill="#f4f5f0" />
      <rect x="40" width="20" height="40" fill="#cd212a" />
    </>
  ),
  es: (
    <>
      <rect width="60" height="40" fill="#aa151b" />
      <rect y="10" width="60" height="20" fill="#f1bf00" />
    </>
  ),
  pt: (
    <>
      <rect width="60" height="40" fill="#f00" />
      <rect width="24" height="40" fill="#060" />
      <circle cx="24" cy="20" r="8" fill="#ffff00" stroke="#f00" strokeWidth="2" />
    </>
  ),
  ja: (
    <>
      <rect width="60" height="40" fill="#fff" />
      <circle cx="30" cy="20" r="11" fill="#bc002d" />
    </>
  ),
  ko: (
    <>
      <rect width="60" height="40" fill="#fff" />
      <path d="M19 20A11 11 0 0 1 41 20A5.5 5.5 0 0 1 30 20A5.5 5.5 0 0 0 19 20Z" fill="#cd2e3a" />
      <path d="M19 20A11 11 0 0 0 41 20A5.5 5.5 0 0 1 30 20A5.5 5.5 0 0 0 19 20Z" fill="#0047a0" />
    </>
  ),
  ru: (
    <>
      <rect width="60" height="13.34" fill="#fff" />
      <rect y="13.34" width="60" height="13.34" fill="#0039a6" />
      <rect y="26.67" width="60" height="13.34" fill="#d52b1e" />
    </>
  ),
  zhs: (
    <>
      <rect width="60" height="40" fill="#ee1c25" />
      <path d={STAR} fill="#ffde00" transform="translate(15 14) scale(8)" />
    </>
  ),
  zht: (
    <>
      <rect width="60" height="40" fill="#fe0000" />
      <rect width="30" height="20" fill="#000095" />
      <circle cx="15" cy="10" r="6" fill="#fff" />
      <circle cx="15" cy="10" r="3" fill="#000095" />
    </>
  ),
};

/** Is there a flag drawn for this language code? */
export function hasFlag(lang: string): boolean {
  return lang in FLAGS;
}

/**
 * The flag itself, sized by height (the box is 3:2). Decorative: the tooltip
 * lives on whatever chip or row wraps it.
 */
export function LangFlag({ lang, size = 10 }: { lang: string; size?: number }) {
  const art = FLAGS[lang];
  if (!art) return <span className="lang-code">{lang}</span>;
  return (
    <svg
      className="lang-flag"
      viewBox="0 0 60 40"
      width={size * 1.5}
      height={size}
      aria-hidden
      focusable="false"
    >
      {art}
    </svg>
  );
}

/** Spelled-out language name, falling back to the raw code Scryfall gave us. */
export function langName(lang: string): string {
  return LANG_NAMES[lang] ?? lang;
}

/**
 * The corner mark a copy wears when it isn't in your language, shaped like the
 * placement badge and the special-conditions "A" so CardItem can carry it the
 * same way. `undefined` when the language matches (or we don't know one) —
 * nothing to say, no clutter.
 *
 * The comparison is against the *preferred* language, not against English: set
 * Settings to Spanish and it's your English cards that get flagged.
 */
export function langMark(
  lang: string | undefined | null,
  size = 10,
): { node: ReactNode; cls: string; title: string } | undefined {
  if (!lang) return undefined;
  const preferred = getPrefs().preferredLang;
  if (lang === preferred) return undefined;
  return {
    node: <LangFlag lang={lang} size={size} />,
    cls: 'badge-lang',
    title: `${langName(lang)} printing (you collect ${langName(preferred)})`,
  };
}
