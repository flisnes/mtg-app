import type { OracleCard } from '@mtg/shared';
import criteria from './bracketCriteria.json';
import type { OracleTagClosure } from './coverage.js';
import type { DeckRow } from './simDeck.js';

// Rebuild plan D1: what the Commander Brackets ask about a deck, counted off
// the cards. Game Changers are a flag on the card (OracleCard.gameChanger,
// from Scryfall); mass land denial and extra turns are read off the oracle
// text with the patterns in bracketCriteria.json; tutors are the Scryfall tag.
// The criteria themselves (how many Game Changers each bracket allows, which
// bracket mass land denial lands you in) are the JSON too, because WotC
// revises them and a revision should be an edit to data, not to this file.
//
// Not read here: two-card infinite combos (D3, waiting on a licensing check of
// a combo source) and how fast the deck is (D2, the simulator's own numbers).
// So the bracket this names is the one the cardboard puts a floor under, and
// the panel says so.

/** One card the brackets count, and how many of it the deck runs. */
export interface BracketCard {
  oracleId: string;
  name: string;
  copies: number;
  commander: boolean;
  /** The sentence that made it count, for mass land denial and extra turns. */
  why?: string;
}

export interface BracketLevel {
  id: number;
  name: string;
  /** Game Changers allowed, or null for any number. */
  gameChangers: number | null;
  massLandDenial: boolean;
  /** Extra-turn cards allowed before it counts as chaining, or null for any number. */
  extraTurnCards: number | null;
  /** Tutors allowed, or null for any number. */
  tutors: number | null;
}

export interface BracketReport {
  gameChangers: BracketCard[];
  massLandDenial: BracketCard[];
  extraTurns: BracketCard[];
  /** Null when the tag vocabulary is not loaded, so the count could not be asked. */
  tutors: BracketCard[] | null;
  /** The lowest bracket every count fits, and why it is not lower. */
  level: BracketLevel;
  reasons: string[];
  levels: readonly BracketLevel[];
  source: string;
}

interface Criteria {
  source: string;
  brackets: BracketLevel[];
  lowest: number;
  detect: {
    massLandDenial: { patterns: string[]; exclude: string[]; names: string[]; ignore: string[] };
    extraTurns: { patterns: string[]; exclude: string[] };
  };
}

const DATA = criteria as Criteria;
const MLD = DATA.detect.massLandDenial.patterns.map((p) => new RegExp(p, 'i'));
const MLD_EXCLUDE = DATA.detect.massLandDenial.exclude.map((p) => new RegExp(p, 'i'));
const MLD_NAMES = new Set(DATA.detect.massLandDenial.names);
const MLD_IGNORE = new Set(DATA.detect.massLandDenial.ignore);
const EXTRA = DATA.detect.extraTurns.patterns.map((p) => new RegExp(p, 'i'));
const EXTRA_EXCLUDE = DATA.detect.extraTurns.exclude.map((p) => new RegExp(p, 'i'));
const TUTOR_SLUG = 'tutor';

const plain = (text: string | null | undefined): string => (text ?? '').replace(/\([^)]*\)/g, '');

/** The sentence that makes a card mass land denial, or null. */
export function massLandDenialWhy(card: Pick<OracleCard, 'name' | 'oracleText'>): string | null {
  if (MLD_IGNORE.has(card.name)) return null;
  for (const raw of plain(card.oracleText).split(/\n|(?<=\.)\s+/)) {
    const line = raw.trim();
    if (line && MLD.some((re) => re.test(line)) && !MLD_EXCLUDE.some((re) => re.test(line))) return line.replace(/\.$/, '');
  }
  return MLD_NAMES.has(card.name) ? 'mass land denial, by name' : null;
}

/** The sentence that makes a card an extra turn for you, or null. */
export function extraTurnWhy(card: Pick<OracleCard, 'oracleText'>): string | null {
  for (const raw of plain(card.oracleText).split(/\n|(?<=\.)\s+/)) {
    const line = raw.trim();
    if (!line || !EXTRA.some((re) => re.test(line)) || EXTRA_EXCLUDE.some((re) => re.test(line))) continue;
    return line.replace(/\.$/, '');
  }
  return null;
}

/** The bracket levels, lowest first, for a panel that wants to show the ladder. */
export const BRACKET_LEVELS: readonly BracketLevel[] = DATA.brackets;

/**
 * What the brackets count in this deck, and the lowest bracket it fits. Main
 * deck and commander only; copies count once per card for the "how many"
 * questions, which is how the brackets ask them (a deck with four Demonic
 * Tutors is a Standard deck, not a different bracket).
 */
export function bracketReport(rows: readonly DeckRow[], oracleTagClosure: OracleTagClosure): BracketReport {
  const tutorTags = oracleTagClosure(TUTOR_SLUG);
  const seen = new Set<string>();
  const gameChangers: BracketCard[] = [];
  const massLandDenial: BracketCard[] = [];
  const extraTurns: BracketCard[] = [];
  const tutors: BracketCard[] = [];
  for (const r of rows) {
    const o = r.oracle;
    if (!o || r.quantity <= 0 || (r.board !== 'main' && r.board !== 'commander') || seen.has(o.oracleId)) continue;
    if (/^Token\b/i.test(o.typeLine)) continue;
    seen.add(o.oracleId);
    const entry = (why?: string): BracketCard => ({
      oracleId: o.oracleId,
      name: o.name,
      copies: r.board === 'main' ? r.quantity : 0,
      commander: r.board === 'commander',
      ...(why ? { why } : {}),
    });
    if (o.gameChanger) gameChangers.push(entry());
    const mld = massLandDenialWhy(o);
    if (mld) massLandDenial.push(entry(mld));
    const extra = extraTurnWhy(o);
    if (extra) extraTurns.push(entry(extra));
    if (tutorTags && o.tags?.some((t) => tutorTags.has(t))) tutors.push(entry());
  }
  const byName = (a: BracketCard, b: BracketCard) => Number(b.commander) - Number(a.commander) || a.name.localeCompare(b.name);
  for (const list of [gameChangers, massLandDenial, extraTurns, tutors]) list.sort(byName);

  // The lowest level every count fits. Nothing here can tell Exhibition from
  // Core (that is intent, not cardboard), so the floor is `lowest`.
  const levels = DATA.brackets;
  const fits = (l: BracketLevel): string[] => {
    const out: string[] = [];
    if (l.gameChangers !== null && gameChangers.length > l.gameChangers) {
      out.push(l.gameChangers === 0 ? `${gameChangers.length} Game Changer${gameChangers.length === 1 ? '' : 's'}` : `more than ${l.gameChangers} Game Changers`);
    }
    if (!l.massLandDenial && massLandDenial.length > 0) out.push('mass land denial');
    if (l.extraTurnCards !== null && extraTurns.length > l.extraTurnCards) out.push(`${extraTurns.length} extra-turn cards, which can chain`);
    if (l.tutors !== null && tutors.length > l.tutors && tutorTags) out.push(`${tutors.length} tutors`);
    return out;
  };
  let level = levels.find((l) => l.id === DATA.lowest) ?? levels[0]!;
  let reasons: string[] = [];
  for (const l of levels) {
    if (l.id < DATA.lowest) continue;
    const why = fits(l);
    if (why.length === 0) {
      level = l;
      break;
    }
    // The reasons the level below this one was not enough.
    reasons = why;
    level = l;
  }
  return { gameChangers, massLandDenial, extraTurns, tutors: tutorTags ? tutors : null, level, reasons, levels, source: DATA.source };
}
