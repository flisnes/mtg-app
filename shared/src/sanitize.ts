// Single source of truth for clamping untrusted trade/wishlist lines. Used in
// two contexts with different bounds, but the same field rules and — crucially
// — the same condition/finish enums, so adding a finish in user.ts can't drift
// between them:
//   - client trade session: a live offer from an unauthenticated peer
//   - server publish: a user's whole tradelist/wishlist going into public_lists
// Existence-in-card-DB is verified separately (at trade completion / on display).

import type { Finish } from './card.js';
import { CONDITIONS, FINISHES, type Condition, type TradeLine, type WishLine } from './user.js';

const CONDS = new Set<string>(CONDITIONS);
const FINS = new Set<string>(FINISHES);

const MAX_ID_CHARS = 64;
const MAX_NAME_CHARS = 200;
const MAX_LANG_CHARS = 10;
const UNKNOWN_NAME = '(unknown card)';

/** Bounds a given call site enforces; the field-shape rules are fixed. */
export interface LineLimits {
  maxQty: number;
  maxLines: number;
}

function clampQty(v: unknown, maxQty: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(maxQty, Math.max(1, n)) : 1;
}

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function sanitizeTradeLine(raw: unknown, maxQty: number): TradeLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;

  const oracleId = clampStr(l.oracleId, MAX_ID_CHARS);
  const scryfallId = clampStr(l.scryfallId, MAX_ID_CHARS);
  if (!oracleId || !scryfallId) return null;

  return {
    oracleId,
    scryfallId,
    name: clampStr(l.name, MAX_NAME_CHARS) || UNKNOWN_NAME,
    quantity: clampQty(l.quantity, maxQty),
    condition: (CONDS.has(l.condition as string) ? l.condition : 'NM') as Condition,
    finish: (FINS.has(l.finish as string) ? l.finish : 'nonfoil') as Finish,
    lang: clampStr(l.lang, MAX_LANG_CHARS) || 'en',
  };
}

export function sanitizeWishLine(raw: unknown, maxQty: number): WishLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;

  const oracleId = clampStr(l.oracleId, MAX_ID_CHARS);
  if (!oracleId) return null;

  return {
    oracleId,
    // Empty string would match no printing at all; treat it as "any printing".
    scryfallId: clampStr(l.scryfallId, MAX_ID_CHARS) || null,
    name: clampStr(l.name, MAX_NAME_CHARS) || UNKNOWN_NAME,
    quantity: clampQty(l.quantity, maxQty),
  };
}

export function sanitizeTradeLines(lines: unknown, limits: LineLimits): TradeLine[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, limits.maxLines)
    .map((l) => sanitizeTradeLine(l, limits.maxQty))
    .filter((l): l is TradeLine => l !== null);
}

export function sanitizeWishLines(lines: unknown, limits: LineLimits): WishLine[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, limits.maxLines)
    .map((l) => sanitizeWishLine(l, limits.maxQty))
    .filter((l): l is WishLine => l !== null);
}
