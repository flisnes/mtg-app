import type { DeckBoard, DeckFormat, Format, OracleCard } from '@mtg/shared';

// Deck legality checking. Covers per-card format legality (banned / not-legal /
// restricted) plus the common construction rules (deck size, copy limits,
// singleton for Commander). Not a full rules engine — no commander color
// identity or companion checks — but catches the mistakes that matter.

interface FormatRule {
  label: string;
  /** Minimum mainboard size (constructed). */
  minMain?: number;
  /** Exact total deck size (Commander = 100). */
  exactTotal?: number;
  maxCopies?: number;
  maxSideboard?: number;
}

const RULES: Record<DeckFormat, FormatRule> = {
  casual: { label: 'Casual' },
  standard: { label: 'Standard', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  pioneer: { label: 'Pioneer', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  modern: { label: 'Modern', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  legacy: { label: 'Legacy', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  vintage: { label: 'Vintage', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  pauper: { label: 'Pauper', minMain: 60, maxCopies: 4, maxSideboard: 15 },
  commander: { label: 'Commander', exactTotal: 100, maxCopies: 1 },
};

export function formatLabel(format: DeckFormat | undefined): string {
  return RULES[format ?? 'casual']?.label ?? 'Casual';
}

export interface LegalityCard {
  oracleId: string;
  quantity: number;
  board: DeckBoard;
  oracle?: OracleCard;
}

export interface LegalityReport {
  /** false for Casual (no checks run). */
  checked: boolean;
  legal: boolean;
  problems: string[];
  /** oracleId → short reason, for per-card markers. */
  issues: Map<string, string>;
}

export function checkDeckLegality(format: DeckFormat | undefined, cards: LegalityCard[]): LegalityReport {
  const fmt = format ?? 'casual';
  const rule = RULES[fmt];
  if (fmt === 'casual') return { checked: false, legal: true, problems: [], issues: new Map() };
  const key = fmt as Format;

  const problems: string[] = [];
  const issues = new Map<string, string>();

  // Aggregate quantities per oracle card across boards.
  const agg = new Map<string, { qty: number; oracle?: OracleCard }>();
  let mainCount = 0;
  let sideCount = 0;
  let total = 0;
  for (const c of cards) {
    total += c.quantity;
    if (c.board === 'main') mainCount += c.quantity;
    else sideCount += c.quantity;
    const a = agg.get(c.oracleId) ?? { qty: 0, oracle: c.oracle };
    a.qty += c.quantity;
    a.oracle = c.oracle ?? a.oracle;
    agg.set(c.oracleId, a);
  }

  let missingData = false;
  for (const [oracleId, { qty, oracle }] of agg) {
    if (!oracle) continue;
    const name = oracle.name;
    const isBasic = /\bBasic\b/.test(oracle.typeLine);
    const status = oracle.legalities?.[key];

    if (!status) {
      missingData = true;
      continue;
    }
    if (status === 'banned') {
      problems.push(`${name} is banned in ${rule.label}.`);
      issues.set(oracleId, 'banned');
    } else if (status === 'not_legal') {
      problems.push(`${name} is not legal in ${rule.label}.`);
      issues.set(oracleId, 'not legal');
    } else if (status === 'restricted' && qty > 1) {
      problems.push(`${name} is restricted (max 1) in ${rule.label}.`);
      issues.set(oracleId, 'restricted');
    } else if (rule.maxCopies && !isBasic && status !== 'restricted' && qty > rule.maxCopies) {
      problems.push(`${qty}× ${name} exceeds the ${rule.maxCopies}-copy limit.`);
      issues.set(oracleId, `max ${rule.maxCopies}`);
    }
  }

  if (rule.exactTotal != null) {
    if (total < rule.exactTotal) problems.push(`Deck has ${total} cards; ${rule.label} needs ${rule.exactTotal}.`);
    else if (total > rule.exactTotal) problems.push(`Deck has ${total} cards; ${rule.label} allows ${rule.exactTotal}.`);
  } else if (rule.minMain != null && mainCount < rule.minMain) {
    problems.push(`Mainboard has ${mainCount} cards; ${rule.label} needs at least ${rule.minMain}.`);
  }
  if (rule.maxSideboard != null && sideCount > rule.maxSideboard) {
    problems.push(`Sideboard has ${sideCount} cards; max ${rule.maxSideboard}.`);
  }
  if (missingData) problems.push('Some cards have no legality data yet — refresh the card database from About.');

  return { checked: true, legal: problems.length === 0, problems, issues };
}
