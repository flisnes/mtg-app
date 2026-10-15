// String rules every sanitizer shares. A leaf module (no imports) so profile.ts
// and sanitize.ts can both use it without joining the user.ts import cycle.

/** Placeholder name for a line whose own name is missing or unusable. */
export const UNKNOWN_CARD_NAME = '(unknown card)';

/** A non-empty string cut to `max` chars, or null for anything else. */
export function clampStr(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}
