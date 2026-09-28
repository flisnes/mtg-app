import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { EventSource } from '@mtg/shared';
import { db } from '../../db/schema.js';
import { getPrintingsByIds } from '../../db/queries.js';
import { containerKind } from '../../deck/containers.js';
import { capToOwnedCopies, findFilingClashes, type FilingMode } from '../../deck/filing.js';
import { getPrefs } from '../../prefs.js';
import type { ResolvedLine } from '../types.js';
import { clashKey, commitIntake, policyMode, type FilingAnswer, type IntakeResult } from './commit.js';
import { IntakeSheet } from './IntakeSheet.js';
import {
  buildIntakeLines,
  defaultDecisions,
  filingCopies,
  hasFixedTarget,
  intakeDelta,
  intakeRekey,
  stepsFor,
  type IntakeDecision,
  type IntakeFlow,
  type IntakeState,
  type IntakeTarget,
} from './model.js';

/**
 * Await `open(...)` where the old code wrote to the collection and then asked
 * its questions. It shows the questionnaire (render `sheet` in your tree), and
 * resolves with what was written once the user applies it, or null when they
 * backed all the way out, in which case nothing at all was written.
 *
 * The answers live here, beside the caller, not inside the sheet: Back and
 * forward again finds every chip and radio where it was left.
 */
export interface IntakeConfig {
  flow: IntakeFlow;
  lines: ResolvedLine[];
  source: Extract<EventSource, 'import' | 'scan' | 'sealed'>;
  /** History label for the batch (e.g. the product name). */
  label?: string;
  /** The container, for a container flow. */
  target?: IntakeTarget;
  /** A step shown first, before the cards: the re-scan diff. */
  preface?: { title: string; body: ReactNode; nextLabel?: string };
  /** What the incoming lines are called on a row: "Scanned", "Import". */
  incomingLabel?: string;
}

export function useIntakeReview(): {
  open: (cfg: IntakeConfig) => Promise<IntakeResult | null>;
  sheet: ReactNode;
} {
  const [state, setStateRaw] = useState<IntakeState | null>(null);
  const [busy, setBusy] = useState(false);
  // Async handlers read the latest state through the ref, and every setter
  // keeps the two in step: a stale closure here would apply a stale answer.
  const stateRef = useRef<IntakeState | null>(null);
  const cfgRef = useRef<IntakeConfig | null>(null);
  const resolveRef = useRef<((r: IntakeResult | null) => void) | null>(null);

  const setState = (next: IntakeState | null) => {
    stateRef.current = next;
    setStateRaw(next);
  };

  const finish = (result: IntakeResult | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    cfgRef.current = null;
    setState(null);
    resolve?.(result);
  };

  const commit = async (st: IntakeState, answer: FilingAnswer | null) => {
    const cfg = cfgRef.current;
    if (!cfg) return;
    setBusy(true);
    try {
      const result = await commitIntake(st, { source: cfg.source, ...(cfg.label ? { label: cfg.label } : {}) }, answer);
      finish(result);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Past the last question: simulate the filing against the collection as it
   * will be after the write. A clash under 'ask' becomes the move step; anything
   * else commits straight away with the policy's answer.
   */
  const settle = async (st: IntakeState) => {
    if (!st.target) {
      await commit(st, null);
      return;
    }
    if (getPrefs().filingPolicy !== 'ask') {
      await commit(st, null);
      return;
    }
    setBusy(true);
    let clashes;
    try {
      const pending = { delta: intakeDelta(st), rekey: intakeRekey(st) };
      const copies = filingCopies(st);
      const going = st.flow === 'rescan' ? copies : await capToOwnedCopies(st.target.id, copies, pending);
      clashes = await findFilingClashes(st.target.id, going, { replacing: st.flow === 'rescan', ...pending });
    } finally {
      setBusy(false);
    }
    if (clashes.length === 0) {
      await commit(st, null);
      return;
    }
    const next: IntakeState = { ...st, moved: { clashes } };
    setState({ ...next, step: stepsFor(next).length - 1 });
  };

  const open = useCallback(async (cfg: IntakeConfig): Promise<IntakeResult | null> => {
    // One questionnaire at a time: a second tap on the button that opened it
    // must not start a parallel one over the same pile.
    if (stateRef.current) return null;
    const lines = await buildIntakeLines(cfg.lines);
    const printings = await getPrintingsByIds([
      ...lines.map((l) => l.line.scryfallId),
      ...lines.flatMap((l) => l.owned.map((e) => e.scryfallId)),
    ]);
    let target: IntakeTarget | null | undefined = cfg.target;
    if (hasFixedTarget(cfg.flow) && !target) {
      throw new Error('a container intake needs its target');
    }
    if (!hasFixedTarget(cfg.flow)) target = undefined;
    const st: IntakeState = {
      flow: cfg.flow,
      lines,
      decisions: defaultDecisions(cfg.flow, lines),
      printings,
      target,
      hasPreface: !!cfg.preface,
      step: 0,
      moved: null,
    };
    cfgRef.current = cfg;
    return new Promise<IntakeResult | null>((resolve) => {
      resolveRef.current = resolve;
      if (stepsFor(st).length === 0) {
        // Nothing to ask (a wishlist purchase with nothing to file): straight to the write.
        stateRef.current = st;
        void settle(st);
        return;
      }
      setState(st);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key: string, d: IntakeDecision) => {
    const st = stateRef.current;
    if (!st) return;
    setState({ ...st, decisions: new Map(st.decisions).set(key, d), moved: null });
  };

  const setAll = (collect: IntakeDecision['collect']) => {
    const st = stateRef.current;
    if (!st) return;
    const next = new Map(st.decisions);
    for (const l of st.lines) if (l.owned.length > 0) next.set(l.key, { collect });
    setState({ ...st, decisions: next, moved: null });
  };

  const back = () => {
    const st = stateRef.current;
    if (!st || busy) return;
    if (st.step === 0) {
      finish(null);
      return;
    }
    // Leaving the move step forgets its simulation: the answers before it may change.
    const steps = stepsFor(st);
    const leavingMoved = steps[st.step] === 'moved';
    const next = { ...st, moved: leavingMoved ? null : st.moved };
    // A step that dropped out (every card set to Skip removes 'where') can't be
    // stepped back onto; clamp to what's left.
    setState({ ...next, step: Math.min(st.step - 1, stepsFor(next).length - 1) });
  };

  const next = async () => {
    const st = stateRef.current;
    if (!st || busy) return;
    const steps = stepsFor(st);
    if (st.step + 1 < steps.length) {
      setState({ ...st, step: st.step + 1 });
      return;
    }
    await settle(st);
  };

  const pickTarget = async (id: string) => {
    const st = stateRef.current;
    if (!st || busy) return;
    const row = await db.decks.get(id);
    const target: IntakeTarget = { id, name: row?.name ?? 'there', kind: containerKind(row) };
    const withTarget = { ...st, target };
    stateRef.current = withTarget;
    await settle(withTarget);
  };

  const leaveUnfiled = async () => {
    const st = stateRef.current;
    if (!st || busy) return;
    const withNone = { ...st, target: null };
    stateRef.current = withNone;
    await commit(withNone, null);
  };

  const chooseMode = async (mode: FilingMode) => {
    const st = stateRef.current;
    if (!st || busy || !st.moved) return;
    await commit(st, { mode, askedKeys: new Set(st.moved.clashes.map(clashKey)) });
  };

  const sheet =
    state && cfgRef.current ? (
      <IntakeSheet
        state={state}
        cfg={cfgRef.current}
        busy={busy}
        onSet={set}
        onSetAll={setAll}
        onBack={back}
        onNext={() => void next()}
        onPickTarget={(id) => void pickTarget(id)}
        onLeaveUnfiled={() => void leaveUnfiled()}
        onChooseMode={(m) => void chooseMode(m)}
      />
    ) : null;

  return { open, sheet };
}

export { policyMode };
export type { IntakeResult };

/** ", filed 3 in Box" / ", moved 2 to Deck A" for the caller's toast; '' when nothing was filed. */
export function describeFiling(res: IntakeResult): string {
  if (!res.target) return '';
  const n = res.filed;
  if (n === 0 && res.listed === 0) return '';
  if (n === 0) return `, listed in ${res.target.name}`;
  return res.mode === 'move'
    ? `, moved ${n} to ${res.target.name}`
    : `, filed ${n} in ${res.target.name}`;
}
