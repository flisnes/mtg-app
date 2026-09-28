import type { CollectionEntry, ContainerKind, DeckBoard, Printing } from '@mtg/shared';
import { collectionKey, type CopyRef, type ImportLine, type MarkForTradeRequest } from '../../db/dataAccess.js';
import { db } from '../../db/schema.js';
import { FINISH_LABELS } from '../../components/CardSheet.js';
import type { FilingClash, FilingCopy } from '../../deck/filing.js';
import type { ResolvedLine } from '../types.js';

// The one intake questionnaire. Every bulk way cards can arrive (a scan, a
// pasted list, a CSV, a wishlist purchase, a cracked box) used to end in two
// unrelated questionnaires: the collection's "already own this? add / update /
// skip" per card, and the filing engine's "already filed elsewhere? move / both"
// per copy. Each read the database at its own moment and neither knew what the
// other had been told, which is how a tester could mark a card as a new copy and
// be asked "did it move?" about the very same card a second later.
//
// This module is the shared answer record. Decisions are per *line* (one
// physical copy description plus the board it lands on), every write derives
// from them, and the move question is simulated against the collection as it
// will be after the write, not as it is now. No React in here; the sheet and
// the hook live next door.

/** Where the cards are going, which decides what the questions are. */
export type IntakeFlow =
  /** Import or scan into the collection. */
  | 'collection'
  /** Import or scan into the tradelist: everything gets marked for trade. */
  | 'tradelist'
  /** Scan into a deck, binder or box (an append). */
  | 'container'
  /** Deck re-scan: the container becomes exactly what was scanned. */
  | 'rescan'
  /** "I bought these" on the wishlist. */
  | 'bought'
  /** A sealed product opened into the collection. */
  | 'sealed';

/** What the collection should make of one incoming line. */
export type Collect =
  /** A copy you didn't have: add it. */
  | 'new'
  /** Cardboard already on your shelf: change nothing, file the copy you own. */
  | 'own'
  /** A correction: swap one copy you own for this description. */
  | 'correct'
  /** Not yours (a container flow lists it without claiming a copy); leave the collection alone. */
  | 'skip'
  /** Flag the copies you already own for trade, add nothing. */
  | 'trade';

export interface IntakeLine {
  /** collectionKey plus board — one decision per physical description per board. */
  key: string;
  line: ResolvedLine;
  board: DeckBoard;
  /** Copies of this exact printing + traits on your shelf. */
  exactOwned: number;
  /** Everything you own of the card, any printing. Empty means new to the collection. */
  owned: CollectionEntry[];
  /** Owned versions a correction could swap out: not the exact copy, and not empty rows. */
  candidates: CollectionEntry[];
}

export interface IntakeDecision {
  collect: Collect;
  /** For a swap with several candidates: the owned copy this line replaces. */
  replaceEntryId?: string;
}

export type IntakeStep = 'changes' | 'cards' | 'where' | 'moved';

export interface IntakeTarget {
  id: string;
  name: string;
  kind: ContainerKind;
}

export interface IntakeState {
  flow: IntakeFlow;
  lines: IntakeLine[];
  decisions: Map<string, IntakeDecision>;
  /** Set and collector number for every printing involved, for the row labels. */
  printings: Map<string, Printing>;
  /** Fixed for a container flow; chosen in the 'where' step otherwise. `null` = leave unfiled. */
  target: IntakeTarget | null | undefined;
  /** A step shown before the cards (the re-scan diff). */
  hasPreface: boolean;
  step: number;
  /** The move question, once simulated and found non-empty. */
  moved: { clashes: FilingClash[] } | null;
}

/** The chips a flow offers for a card you already own, first one the default. */
export function chipOptions(flow: IntakeFlow): { value: Collect; label: string }[] {
  switch (flow) {
    case 'collection':
      return [
        { value: 'new', label: 'Add' },
        { value: 'correct', label: 'Update' },
        { value: 'skip', label: 'Skip' },
      ];
    case 'tradelist':
      return [
        { value: 'trade', label: 'Trade' },
        { value: 'new', label: 'Add' },
        { value: 'skip', label: 'Skip' },
      ];
    case 'container':
    case 'rescan':
      return [
        { value: 'own', label: 'Already mine' },
        { value: 'new', label: 'New copy' },
        { value: 'skip', label: 'Not mine' },
      ];
    default:
      return [];
  }
}

/** A container flow: the destination is known and every line lands in it. */
export const hasFixedTarget = (flow: IntakeFlow): boolean => flow === 'container' || flow === 'rescan';

/** Flows where every line is new cardboard by definition, so there is nothing to ask per card. */
const allNew = (flow: IntakeFlow): boolean => flow === 'bought' || flow === 'sealed';

const lineKey = (l: ResolvedLine): string => `${collectionKey(l)}|${l.board ?? 'main'}`;

/**
 * Resolve the incoming lines against the collection. Lines describing the same
 * copy on the same board merge (an import can name a card twice), so there is
 * exactly one decision per key.
 */
export async function buildIntakeLines(lines: ResolvedLine[]): Promise<IntakeLine[]> {
  const merged = new Map<string, ResolvedLine>();
  for (const l of lines) {
    const k = lineKey(l);
    const cur = merged.get(k);
    if (cur) {
      merged.set(k, {
        ...cur,
        quantity: cur.quantity + l.quantity,
        quantityForTrade: cur.quantityForTrade + l.quantityForTrade,
      });
    } else merged.set(k, { ...l });
  }
  const oracleIds = [...new Set([...merged.values()].map((l) => l.oracleId))];
  const owned = oracleIds.length ? await db.collection.where('oracleId').anyOf(oracleIds).toArray() : [];
  const byOracle = new Map<string, CollectionEntry[]>();
  for (const e of owned) {
    const arr = byOracle.get(e.oracleId);
    if (arr) arr.push(e);
    else byOracle.set(e.oracleId, [e]);
  }
  const out: IntakeLine[] = [];
  for (const [key, line] of merged) {
    const mine = byOracle.get(line.oracleId) ?? [];
    const exact = collectionKey(line);
    out.push({
      key,
      line,
      board: line.board ?? 'main',
      exactOwned: mine.filter((e) => collectionKey(e) === exact).reduce((n, e) => n + e.quantity, 0),
      owned: mine,
      candidates: mine.filter((e) => e.quantity > 0 && collectionKey(e) !== exact),
    });
  }
  return out;
}

/** What every line starts on: the flow's first chip for an owned card, 'new' otherwise. */
export function defaultDecisions(flow: IntakeFlow, lines: IntakeLine[]): Map<string, IntakeDecision> {
  const first = chipOptions(flow)[0]?.value ?? 'new';
  return new Map(
    lines.map((l) => [l.key, { collect: l.owned.length > 0 && !allNew(flow) ? first : 'new' } as IntakeDecision]),
  );
}

export function decisionOf(st: IntakeState, l: IntakeLine): IntakeDecision {
  return st.decisions.get(l.key) ?? { collect: 'new' };
}

/** Every write one line turns into. */
export interface LinePlan {
  /** Copies to add to the collection (0 = don't). */
  write: number;
  /** Owned copies swapped out for them, oldest-chosen first. */
  removals: { id: string; qty: number; to: CopyRef }[];
  /** Flag the copies you own for trade instead of adding. */
  trade: boolean;
  /** The container slot names this exact copy (it is, or will be, cardboard on your shelf). */
  claims: boolean;
  /** The line does nothing to the collection and, outside a container, isn't filed either. */
  skipped: boolean;
}

/**
 * How many copies a swap could draw from, and where: the chosen version first,
 * then the rest, so N copies still net out when the picked version holds fewer.
 */
function swapRemovals(l: IntakeLine, need: number, chosenId?: string): LinePlan['removals'] {
  const order = [...l.candidates.filter((e) => e.id === chosenId), ...l.candidates.filter((e) => e.id !== chosenId)];
  const to: CopyRef = {
    scryfallId: l.line.scryfallId,
    condition: l.line.condition,
    finish: l.line.finish,
    lang: l.line.lang || 'en',
  };
  const out: LinePlan['removals'] = [];
  let left = need;
  for (const e of order) {
    if (left <= 0) break;
    const take = Math.min(left, e.quantity);
    if (take > 0) {
      out.push({ id: e.id, qty: take, to });
      left -= take;
    }
  }
  return out;
}

/** Copies a swap would move: what the candidates hold, at most the line's count. */
export function swapNeed(l: IntakeLine, d: IntakeDecision): number {
  const candidateQty = l.candidates.reduce((n, e) => n + e.quantity, 0);
  if (d.collect === 'correct') return Math.min(l.line.quantity, candidateQty);
  // "Already mine" of a copy you don't have in exactly this description: the
  // shelf has the card in another version, so it's a correction of the record,
  // sized to the copies the exact description is short.
  if (d.collect === 'own') return Math.min(Math.max(0, l.line.quantity - l.exactOwned), candidateQty);
  return 0;
}

export function planLine(l: IntakeLine, d: IntakeDecision, flow: IntakeFlow): LinePlan {
  const none: LinePlan = { write: 0, removals: [], trade: false, claims: false, skipped: true };
  switch (d.collect) {
    case 'new':
      return { write: l.line.quantity, removals: [], trade: false, claims: true, skipped: false };
    case 'trade':
      return { ...none, trade: true, skipped: false };
    case 'skip':
      // In a container the card still goes on the list, just claiming nothing.
      return hasFixedTarget(flow) ? { ...none, skipped: false } : none;
    case 'correct': {
      const need = swapNeed(l, d);
      // Nothing distinct to replace: an Update is a no-op, not an add.
      if (need === 0) return { ...none, claims: l.exactOwned > 0, skipped: l.exactOwned === 0 };
      return {
        write: l.line.quantity,
        removals: swapRemovals(l, need, d.replaceEntryId),
        trade: false,
        claims: true,
        skipped: false,
      };
    }
    case 'own': {
      const need = swapNeed(l, d);
      return {
        write: need,
        removals: need > 0 ? swapRemovals(l, need, d.replaceEntryId) : [],
        trade: false,
        claims: true,
        skipped: false,
      };
    }
  }
}

export function plansOf(st: IntakeState): { line: IntakeLine; plan: LinePlan }[] {
  return st.lines.map((line) => ({ line, plan: planLine(line, decisionOf(st, line), st.flow) }));
}

/** Lines that become collection rows, sized by their plan. */
export function importLines(st: IntakeState): ImportLine[] {
  return plansOf(st)
    .filter(({ plan }) => plan.write > 0)
    .map(({ line: l, plan }) => ({
      oracleId: l.line.oracleId,
      scryfallId: l.line.scryfallId,
      condition: l.line.condition,
      finish: l.line.finish,
      lang: l.line.lang,
      quantity: plan.write,
      quantityForTrade: Math.min(plan.write, l.line.quantityForTrade),
    }));
}

export function tradeRequests(st: IntakeState): MarkForTradeRequest[] {
  return plansOf(st)
    .filter(({ plan }) => plan.trade)
    .map(({ line: l }) => ({
      oracleId: l.line.oracleId,
      scryfallId: l.line.scryfallId,
      condition: l.line.condition,
      finish: l.line.finish,
      lang: l.line.lang,
      quantity: l.line.quantity,
    }));
}

/** Set · number · condition · finish · language, for the filing prompt. */
export function describeCopy(
  st: Pick<IntakeState, 'printings'>,
  v: { scryfallId: string; condition: string; finish: string; lang: string; quantity?: number },
): string {
  const p = st.printings.get(v.scryfallId);
  const parts = [
    p ? `${p.set.toUpperCase()} #${p.collectorNumber}` : null,
    v.condition,
    v.finish !== 'nonfoil' ? FINISH_LABELS[v.finish as keyof typeof FINISH_LABELS] ?? v.finish : null,
    v.lang && v.lang !== 'en' ? v.lang : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return v.quantity !== undefined ? `${v.quantity}× ${parts}` : parts;
}

/**
 * What goes into the container. A container flow files every line: with the
 * copy's traits when the cardboard is (or is about to be) yours, as a list-only
 * line claiming nothing when you said it isn't. Elsewhere only the lines that
 * landed in the collection are offered a home.
 */
export function filingCopies(st: IntakeState): FilingCopy[] {
  return plansOf(st)
    .filter(({ plan }) => (hasFixedTarget(st.flow) ? !plan.skipped || plan.claims : plan.claims))
    .map(({ line: l, plan }) => ({
      oracleId: l.line.oracleId,
      scryfallId: l.line.scryfallId,
      quantity: l.line.quantity,
      board: l.board,
      ...(plan.claims ? { wants: { condition: l.line.condition, finish: l.line.finish, lang: l.line.lang } } : {}),
      label: l.line.name,
      sub: describeCopy(st, l.line),
    }));
}

/**
 * How the collection changes before the filing runs, by copy key: what the
 * move question has to count with, since it's asked before anything is written.
 */
export function intakeDelta(st: IntakeState): Map<string, number> {
  const delta = new Map<string, number>();
  const bump = (k: string, n: number) => delta.set(k, (delta.get(k) ?? 0) + n);
  const byId = new Map(st.lines.flatMap((l) => l.owned).map((e) => [e.id, e]));
  for (const { line: l, plan } of plansOf(st)) {
    if (plan.write > 0) bump(collectionKey(l.line), plan.write);
    for (const r of plan.removals) {
      const e = byId.get(r.id);
      if (e) bump(collectionKey(e), -r.qty);
    }
  }
  return delta;
}

/**
 * Which copy keys the pending swaps rename: a swap that empties an owned row
 * takes every slot holding that copy along (applyImport's refile), so the
 * simulation reads those slots under the incoming key. A partial swap moves
 * only some slots, which can't be told apart before the write; those stay as
 * they are, and any clash they raise at commit is filed as 'copy' (a flag).
 */
export function intakeRekey(st: IntakeState): Map<string, string> {
  const rekey = new Map<string, string>();
  const byId = new Map(st.lines.flatMap((l) => l.owned).map((e) => [e.id, e]));
  for (const { line: l, plan } of plansOf(st)) {
    for (const r of plan.removals) {
      const e = byId.get(r.id);
      if (e && e.quantity - r.qty <= 0) rekey.set(collectionKey(e), collectionKey(l.line));
    }
  }
  return rekey;
}

/** Any line will be cardboard worth filing somewhere. */
export const anyClaims = (st: IntakeState): boolean => plansOf(st).some(({ plan }) => plan.claims);

/**
 * The steps this intake walks, recomputed from the answers so a step with
 * nothing to ask drops out. 'moved' only exists once the simulation found a clash.
 */
export function stepsFor(st: IntakeState): IntakeStep[] {
  const steps: IntakeStep[] = [];
  if (st.hasPreface) steps.push('changes');
  if (st.lines.length > 0 && !allNew(st.flow)) {
    // A container asks about every card (is this yours?); a collection intake
    // only about the ones already on the shelf, since the rest go in either way.
    if (hasFixedTarget(st.flow) || st.lines.some((l) => l.owned.length > 0)) steps.push('cards');
  }
  if (!hasFixedTarget(st.flow) && anyClaims(st)) steps.push('where');
  if (st.moved) steps.push('moved');
  return steps;
}

/** Copies added to the collection, for button labels. */
export function addedCount(st: IntakeState): number {
  return plansOf(st).reduce((n, { plan }) => n + plan.write, 0);
}

/** Copies going into the container (every line, whatever it claims). */
export function containerCount(st: IntakeState): number {
  return plansOf(st).reduce((n, { line, plan }) => n + (plan.skipped && !plan.claims ? 0 : line.line.quantity), 0);
}
