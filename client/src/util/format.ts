import { fmtEur } from '../price/rates.js';

// Shared display formatters. Keep the date/money formatting identical
// everywhere it appears (history, event sheet, community, account…).

/** Medium date, e.g. "18 Jul 2026". */
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Medium date + short time, e.g. "18 Jul 2026, 14:32". */
export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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
