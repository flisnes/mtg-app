import { getPrefs } from '../prefs.js';
import { fmtEur, localeFor } from '../price/rates.js';

// Shared display formatters. Keep the date/money formatting identical
// everywhere it appears (history, event sheet, community, account…).
// Dates and counts follow the display currency's region, the same one the
// prices next to them use, so a page never mixes "02/10/2026" with "0,00 €".
// The language stays English: EUR's de-DE gives "2 Oct 2026", not "02.10.2026".

function locale(): string | undefined {
  const region = localeFor(getPrefs().displayCurrency)?.split('-')[1];
  return region ? `en-${region}` : undefined;
}

/** Medium date, e.g. "18 Jul 2026". */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(locale(), { dateStyle: 'medium' });
}

/** Medium date + short time, e.g. "18 Jul 2026, 14:32". */
export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/** A whole number with grouping, e.g. "36 789" or "36,789". */
export function fmtCount(n: number): string {
  return n.toLocaleString(locale());
}

/**
 * How big a list is, worded the same on every page: total copies first, then
 * how many distinct rows they fold into, e.g. "176 cards · 70 unique". The
 * second half drops out when every row is a single copy.
 */
export function fmtCardCount(cards: number, unique: number, noun: [string, string] = ['card', 'cards']): string {
  const head = `${fmtCount(cards)} ${cards === 1 ? noun[0] : noun[1]}`;
  return unique === cards ? head : `${head} · ${fmtCount(unique)} unique`;
}

/**
 * Integer EUR cents → money in the user's display currency, e.g. "€12.34" or
 * "kr 135". Recorded acquisition prices and price history are always stored in
 * EUR cents (see price/history.ts); only the display is converted, so changing
 * currency never rewrites what was recorded.
 */
export function fmtCents(cents: number): string {
  return fmtEur(cents / 100);
}
