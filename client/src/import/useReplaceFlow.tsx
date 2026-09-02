import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CollectionEntry, Condition, Finish, Priced, Printing, SpecialCondition } from '@mtg/shared';
import { specialLabel } from '@mtg/shared';
import { collectionKey } from '../db/dataAccess.js';
import { getPrintingsByIds } from '../db/queries.js';
import { Icon } from '../components/icons.js';
import { useDismiss } from '../components/useDismiss.js';
import { useTapGuard } from '../components/useTapGuard.js';
import type { ConflictChoice, ImportConflict } from './conflicts.js';

/**
 * "Update": swap one copy you already own for the incoming printing, without
 * changing how many of the card you have.
 *
 * This used to live inside the scanner, which meant importing the same list
 * offered a "Replace" that deleted *every* copy of the card you owned, in every
 * printing and condition, and then added the file's lines on top. Same word,
 * wildly different blast radius. Both now come through here: the swap is
 * surgical, it's previewed, and when you own the card in more than one version
 * you pick which copy it replaces.
 */

/** One 'Update' conflict: the incoming card, the owned versions it could replace, and how many copies to swap. */
export interface ReplacePlan {
  conflict: ImportConflict;
  /** Owned variants eligible to be swapped out (excludes an exact match of the incoming printing). */
  candidates: CollectionEntry[];
  /** Copies to convert = min(incoming qty, owned candidate qty). */
  need: number;
}

/** What the caller needs to hand `applyImport`: surgical removals, plus the cards whose Update was a no-op. */
export interface ReplaceOutcome {
  removals: { id: string; qty: number }[];
  /** 'Update' conflicts with nothing distinct to replace — their lines are dropped. */
  noSource: Set<string>;
}

/**
 * Which owned copies a swap draws from: the chosen version first, then the rest
 * (so N copies still net out even if the picked version holds fewer).
 */
export function planRemovals(plan: ReplacePlan, chosenId?: string): { id: string; qty: number }[] {
  const order = [
    ...plan.candidates.filter((e) => e.id === chosenId),
    ...plan.candidates.filter((e) => e.id !== chosenId),
  ];
  let need = plan.need;
  const out: { id: string; qty: number }[] = [];
  for (const e of order) {
    if (need <= 0) break;
    const take = Math.min(need, e.quantity);
    if (take > 0) {
      out.push({ id: e.id, qty: take });
      need -= take;
    }
  }
  return out;
}

export function useReplaceFlow(): {
  /** Settle every 'replace' choice; null means the user backed out of a pick. */
  resolveReplacements: (
    conflicts: ImportConflict[],
    choices: Map<string, ConflictChoice>,
  ) => Promise<ReplaceOutcome | null>;
  sheet: ReactNode;
  busy: boolean;
} {
  const [flow, setFlow] = useState<{
    queue: ReplacePlan[];
    idx: number;
    removals: { id: string; qty: number }[];
    noSource: Set<string>;
    resolve: (out: ReplaceOutcome | null) => void;
  } | null>(null);

  const resolveReplacements = useCallback(
    async (conflicts: ImportConflict[], choices: Map<string, ConflictChoice>): Promise<ReplaceOutcome | null> => {
      const plans: ReplacePlan[] = conflicts
        .filter((c) => choices.get(c.oracleId) === 'replace')
        .map((c) => {
          // A version identical to the incoming one isn't something to swap out.
          const incomingKeys = new Set(c.incoming.map((l) => collectionKey(l)));
          const candidates = c.existing.filter((e) => e.quantity > 0 && !incomingKeys.has(collectionKey(e)));
          const incomingQty = c.incoming.reduce((s, l) => s + l.quantity, 0);
          const ownedQty = candidates.reduce((s, e) => s + e.quantity, 0);
          return { conflict: c, candidates, need: Math.min(incomingQty, ownedQty) };
        });
      // Nothing distinct to replace → "Update" is a no-op; don't add the line either.
      const noSource = new Set(plans.filter((p) => p.need === 0).map((p) => p.conflict.oracleId));
      const autoRemovals = plans
        .filter((p) => p.need > 0 && p.candidates.length === 1)
        .flatMap((p) => planRemovals(p, p.candidates[0]!.id));
      const queue = plans.filter((p) => p.need > 0 && p.candidates.length >= 2);

      if (queue.length === 0) return { removals: autoRemovals, noSource };
      return new Promise<ReplaceOutcome | null>((resolve) =>
        setFlow({ queue, idx: 0, removals: autoRemovals, noSource, resolve }),
      );
    },
    [],
  );

  const sheet = flow ? (
    <ReplaceCopySheet
      plan={flow.queue[flow.idx]!}
      index={flow.idx}
      total={flow.queue.length}
      onPick={(entryId) => {
        const plan = flow.queue[flow.idx]!;
        const removals = [...flow.removals, ...planRemovals(plan, entryId)];
        const nextIdx = flow.idx + 1;
        if (nextIdx >= flow.queue.length) {
          setFlow(null);
          flow.resolve({ removals, noSource: flow.noSource });
        } else {
          setFlow({ ...flow, removals, idx: nextIdx });
        }
      }}
      onBack={() => {
        setFlow(null);
        flow.resolve(null);
      }}
    />
  ) : null;

  return { resolveReplacements, sheet, busy: flow !== null };
}

/**
 * When you own the card in more than one version, pick which owned copy the
 * incoming printing swaps in for. One card at a time, with a counter when
 * several are queued. The total for the card never changes.
 */
function ReplaceCopySheet({
  plan,
  index,
  total,
  onPick,
  onBack,
}: {
  plan: ReplacePlan;
  index: number;
  total: number;
  onPick: (entryId: string) => void;
  onBack: () => void;
}) {
  const [picked, setPicked] = useState<string>('');
  const [printings, setPrintings] = useState<Map<string, Priced<Printing>>>(new Map());

  // Fresh default selection (and label lookup) whenever the queue advances.
  useEffect(() => {
    setPicked(plan.candidates[0]?.id ?? '');
    const ids = [...plan.candidates.map((e) => e.scryfallId), ...plan.conflict.incoming.map((l) => l.scryfallId)];
    void getPrintingsByIds(ids).then(setPrintings);
  }, [plan]);

  const describe = (v: {
    scryfallId: string;
    condition: Condition;
    finish: Finish;
    lang: string;
    special?: readonly SpecialCondition[];
  }) => {
    const p = printings.get(v.scryfallId);
    const parts: string[] = [];
    if (p) parts.push(`${p.set.toUpperCase()} #${p.collectorNumber}`);
    parts.push(v.condition);
    if (v.finish !== 'nonfoil') parts.push(v.finish);
    if (v.lang && v.lang !== 'en') parts.push(v.lang);
    // Named out loud: this list is how a copy gets swapped out, and nobody
    // should lose their signed one to an import without seeing it said.
    if (v.special?.length) parts.push(specialLabel(v.special));
    return parts.join(' · ');
  };
  const incoming = plan.conflict.incoming.map((l) => describe(l)).join(', ');
  useDismiss(onBack);
  const tapGuard = useTapGuard();

  return (
    <div className="sheet-backdrop" onClick={onBack} {...tapGuard}>
      <div className="sheet scan-list-sheet" role="dialog" aria-label="Which copy to replace" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>Which copy to replace?</h2>
          {total > 1 && (
            <span className="scan-target">
              {index + 1} / {total}
            </span>
          )}
          <button className="scan-close" onClick={onBack} aria-label="Cancel">
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="fine-print">
          You own <strong>{plan.conflict.name}</strong> in more than one version. Pick the copy the incoming{' '}
          {incoming ? <em>{incoming}</em> : 'printing'} should replace — one copy is swapped out, so your total for this
          card stays the same.
        </p>
        <ul className="scan-list">
          {plan.candidates.map((e) => (
            <li key={e.id} className="scan-list-row">
              <label className="scan-list-main" style={{ cursor: 'pointer' }}>
                <input type="radio" name="replace-copy" checked={picked === e.id} onChange={() => setPicked(e.id)} />
                <span className="scan-list-info">
                  <strong>{describe(e)}</strong>
                  <span className="scan-printing">You own ×{e.quantity}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="scan-confirm-actions">
          <button className="primary" disabled={!picked} onClick={() => onPick(picked)}>
            {index + 1 < total ? 'Next' : 'Replace'}
          </button>
          <button onClick={onBack}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
