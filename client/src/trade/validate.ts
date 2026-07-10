import { CONDITIONS, FINISHES, type Condition, type Finish, type TradeLine, type WishLine } from '@mtg/shared';

// A trade partner is untrusted (no auth on the relay). Sanitize every incoming
// offer line before it's displayed or written to the collection: clamp
// quantities, enforce the condition/finish enums, bound string lengths, and
// require ids. (Existence-in-card-DB is verified separately at completion.)

const CONDS = new Set<string>(CONDITIONS);
const FINS = new Set<string>(FINISHES);
const MAX_QTY = 999;
const MAX_LINES = 500;

export function sanitizeTradeLine(raw: unknown): TradeLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;

  const oracleId = typeof l.oracleId === 'string' ? l.oracleId.slice(0, 64) : '';
  const scryfallId = typeof l.scryfallId === 'string' ? l.scryfallId.slice(0, 64) : '';
  if (!oracleId || !scryfallId) return null;

  const n = Math.floor(Number(l.quantity));
  const quantity = Number.isFinite(n) ? Math.min(MAX_QTY, Math.max(1, n)) : 1;

  return {
    oracleId,
    scryfallId,
    name: typeof l.name === 'string' ? l.name.slice(0, 200) : '(unknown card)',
    quantity,
    condition: (CONDS.has(l.condition as string) ? l.condition : 'NM') as Condition,
    finish: (FINS.has(l.finish as string) ? l.finish : 'nonfoil') as Finish,
    lang: typeof l.lang === 'string' && l.lang ? l.lang.slice(0, 10) : 'en',
  };
}

export function sanitizeOffer(lines: unknown): TradeLine[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, MAX_LINES)
    .map(sanitizeTradeLine)
    .filter((l): l is TradeLine => l !== null);
}

export function sanitizeWishLine(raw: unknown): WishLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;

  const oracleId = typeof l.oracleId === 'string' ? l.oracleId.slice(0, 64) : '';
  if (!oracleId) return null;

  const n = Math.floor(Number(l.quantity));
  const quantity = Number.isFinite(n) ? Math.min(MAX_QTY, Math.max(1, n)) : 1;

  return {
    oracleId,
    scryfallId: typeof l.scryfallId === 'string' ? l.scryfallId.slice(0, 64) : null,
    name: typeof l.name === 'string' ? l.name.slice(0, 200) : '(unknown card)',
    quantity,
  };
}

export function sanitizeWishlist(lines: unknown): WishLine[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, MAX_LINES)
    .map(sanitizeWishLine)
    .filter((l): l is WishLine => l !== null);
}
