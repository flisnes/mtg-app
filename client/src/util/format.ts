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

/** Integer EUR cents → "€12.34". */
export function fmtCents(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}
