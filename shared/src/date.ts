// Date helpers shared by the client price history and the server price archive,
// which store readings indexed by whole UTC days from a start day.

export const DAY_MS = 86_400_000;

/** Whole days from `startDay` to `day` (both YYYY-MM-DD, parsed as UTC). -1 if unparseable. */
export function dayOffset(startDay: string, day: string): number {
  const d = (Date.parse(day) - Date.parse(startDay)) / DAY_MS;
  return Number.isFinite(d) ? Math.round(d) : -1;
}
