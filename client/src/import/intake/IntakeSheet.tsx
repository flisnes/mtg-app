import type { ReactNode } from 'react';
import type { CollectionEntry, DeckBoard } from '@mtg/shared';
import { specialLabel } from '@mtg/shared';
import { ContainerPickerBody } from '../../components/ContainerPickerSheet.js';
import { FilingChoiceBody } from '../../components/FilingChoiceSheet.js';
import { Icon } from '../../components/icons.js';
import { Sheet } from '../../components/Sheet.js';
import type { FilingMode } from '../../deck/filing.js';
import type { IntakeConfig } from './useIntakeReview.js';
import {
  addedCount,
  chipOptions,
  containerCount,
  decisionOf,
  describeCopy,
  hasFixedTarget,
  stepsFor,
  swapNeed,
  tradeRequests,
  type Collect,
  type IntakeDecision,
  type IntakeLine,
  type IntakeState,
  type IntakeStep,
} from './model.js';

// One sheet for the whole questionnaire. It stays open from the first step to
// the write, so there is never a second sheet stacked under the one you're
// answering, and every step has the same shape: a heading with "Step k of n",
// the question, Back on the left and one primary action on the right.

const BOARD_LABELS: Record<DeckBoard, string> = {
  main: 'mainboard',
  side: 'sideboard',
  commander: 'command zone',
  token: 'tokens',
};

export function IntakeSheet({
  state,
  cfg,
  busy,
  onSet,
  onSetAll,
  onBack,
  onNext,
  onPickTarget,
  onLeaveUnfiled,
  onChooseMode,
}: {
  state: IntakeState;
  cfg: IntakeConfig;
  busy: boolean;
  onSet: (key: string, d: IntakeDecision) => void;
  onSetAll: (collect: Collect) => void;
  onBack: () => void;
  onNext: () => void;
  onPickTarget: (id: string) => void;
  onLeaveUnfiled: () => void;
  onChooseMode: (mode: FilingMode) => void;
}) {
  const steps = stepsFor(state);
  const step: IntakeStep = steps[state.step] ?? 'cards';
  const last = state.step === steps.length - 1;
  const container = hasFixedTarget(state.flow);

  const title =
    step === 'changes'
      ? cfg.preface?.title ?? 'Changes'
      : step === 'cards'
        ? container
          ? 'Are these yours?'
          : 'Already in your collection'
        : step === 'where'
          ? 'Where do these live?'
          : 'Already filed somewhere else';
  const label =
    step === 'where' ? 'Choose where these cards are kept' : step === 'moved' ? 'Choose how to file these cards' : title;

  /** The final button's text: what applying will do, in numbers. */
  const applyLabel = (): string => {
    const added = addedCount(state);
    const addSuffix = added > 0 ? ` · add ${added} to collection` : '';
    if (state.flow === 'rescan') return `Update ${state.target?.name ?? 'deck'}${addSuffix}`;
    if (state.flow === 'container') {
      const n = containerCount(state);
      return `File ${n} in ${state.target?.name ?? 'here'}${addSuffix}`;
    }
    const traded = tradeRequests(state).reduce((n, r) => n + r.quantity, 0);
    if (state.flow === 'tradelist') {
      const n = added + traded;
      return n === 0 ? 'Nothing to add' : `Add ${n} to tradelist`;
    }
    return added === 0 ? 'Skip everything' : `Import ${added} card${added === 1 ? '' : 's'}`;
  };

  const primary =
    step === 'changes'
      ? last
        ? cfg.preface?.nextLabel ?? 'Apply'
        : 'Next'
      : step === 'cards'
        ? last
          ? applyLabel()
          : 'Next'
        : null;

  return (
    <Sheet
      onClose={onBack}
      dismiss={busy ? null : onBack}
      className={`scan-list-sheet intake-sheet${step === 'where' ? ' container-picker' : ''}`}
      label={label}
      resetKey={state.step}
    >
      <div className="scan-sheet-head">
        <h2>{title}</h2>
        {steps.length > 1 && (
          <span className="scan-target">
            Step {state.step + 1} of {steps.length}
          </span>
        )}
        <button className="scan-close" onClick={onBack} aria-label={state.step === 0 ? 'Cancel' : 'Back'} disabled={busy}>
          <Icon name="close" size={18} />
        </button>
      </div>

      {step === 'changes' && cfg.preface?.body}

      {step === 'cards' && <CardsStep state={state} cfg={cfg} onSet={onSet} onSetAll={onSetAll} />}

      {step === 'where' && (
        <>
          <p className="search-meta">
            {addedCount(state)} card{addedCount(state) === 1 ? ' is' : 's are'} going into your collection. File{' '}
            {addedCount(state) === 1 ? 'it' : 'them'} in a deck, binder or box while you have the pile in your hands?
          </p>
          <ContainerPickerBody onPick={(id) => onPickTarget(id)} />
        </>
      )}

      {step === 'moved' && state.moved && state.target && (
        <FilingChoiceBody
          clashes={state.moved.clashes}
          targetName={state.target.name}
          targetKind={state.target.kind}
          onChoose={onChooseMode}
        >
          <button onClick={onBack} disabled={busy}>
            Back
          </button>
        </FilingChoiceBody>
      )}

      {step !== 'moved' && (
        <div className="sheet-actions">
          <button onClick={onBack} disabled={busy}>
            {state.step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step === 'where' ? (
            <button onClick={onLeaveUnfiled} disabled={busy}>
              {busy ? 'Working…' : `Leave ${addedCount(state) === 1 ? 'it' : 'them'} unfiled`}
            </button>
          ) : (
            <button className="primary" onClick={onNext} disabled={busy}>
              {busy ? 'Working…' : primary}
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}

/**
 * "Are these yours?" / "Already in your collection": one row per card, one
 * chip group per incoming line, and the "which copy?" pick folded into the row
 * of a swap instead of a sheet of its own afterwards.
 */
function CardsStep({
  state,
  cfg,
  onSet,
  onSetAll,
}: {
  state: IntakeState;
  cfg: IntakeConfig;
  onSet: (key: string, d: IntakeDecision) => void;
  onSetAll: (collect: Collect) => void;
}) {
  const container = hasFixedTarget(state.flow);
  const incoming = cfg.incomingLabel ?? 'Import';
  const options = chipOptions(state.flow);
  const unowned = state.lines.filter((l) => l.owned.length === 0);
  const owned = state.lines.filter((l) => l.owned.length > 0);
  const showBoards = container && state.target?.kind === 'deck' && state.lines.some((l) => l.board !== 'main');

  // Grouped by card: the "you have" line is the card's, the chips are each line's.
  const groups = new Map<string, { name: string; owned: CollectionEntry[]; lines: IntakeLine[] }>();
  for (const l of owned) {
    const g = groups.get(l.line.oracleId);
    if (g) g.lines.push(l);
    else groups.set(l.line.oracleId, { name: l.line.name, owned: l.owned, lines: [l] });
  }
  const sorted = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Named out loud: this is how a copy gets swapped out, and nobody should lose
  // their signed one to an import without seeing it said.
  const describeOwned = (e: CollectionEntry, withQty = true) =>
    [describeCopy(state, { ...e, quantity: withQty ? e.quantity : undefined }), e.special?.length ? specialLabel(e.special) : null]
      .filter(Boolean)
      .join(' · ');

  const allNewPicked = unowned.every((l) => decisionOf(state, l).collect === 'new');
  const newCount = unowned.filter((l) => decisionOf(state, l).collect === 'new').length;

  return (
    <div className="intake-body">
      {unowned.length > 0 &&
        (container ? (
          <section className="intake-section">
            <h3 className="intake-heading">
              New to your collection <span className="search-meta">({unowned.length})</span>
            </h3>
            <p className="fine-print">
              You don’t own {unowned.length === 1 ? 'this card' : 'these cards'} yet. Ticked ones are added to your
              collection and filed here; unticked ones just go on the list.
            </p>
            <div className="list-toolbar">
              <label className="chip" style={{ alignSelf: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={allNewPicked}
                  onChange={() => {
                    for (const l of unowned) onSet(l.key, { collect: allNewPicked ? 'skip' : 'new' });
                  }}
                />{' '}
                {allNewPicked ? 'Unselect all' : 'Select all'}
              </label>
              <span className="search-meta grow">
                {newCount} of {unowned.length} selected
              </span>
            </div>
            <ul className="scan-list">
              {unowned.map((l) => {
                const p = state.printings.get(l.line.scryfallId);
                return (
                  <li key={l.key} className="scan-list-row">
                    <label className="scan-list-main" style={{ cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={decisionOf(state, l).collect === 'new'}
                        onChange={(e) => onSet(l.key, { collect: e.target.checked ? 'new' : 'skip' })}
                      />
                      {p?.imageSmall ? (
                        <img className="scan-list-thumb" src={p.imageSmall} alt="" />
                      ) : (
                        <span className="scan-list-thumb" />
                      )}
                      <span className="scan-list-info">
                        <strong>{l.line.name}</strong>
                        <span className="scan-printing">
                          {describeCopy(state, { ...l.line, quantity: l.line.quantity > 1 ? l.line.quantity : undefined })}
                          {showBoards ? ` · ${BOARD_LABELS[l.board]}` : ''}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <p className="fine-print">
            {unowned.length} card{unowned.length === 1 ? '' : 's'} in this {incoming.toLowerCase() === 'scanned' ? 'scan' : 'list'}{' '}
            {unowned.length === 1 ? "isn't" : "aren't"} in your collection yet and {unowned.length === 1 ? 'goes' : 'go'} in
            either way.
          </p>
        ))}

      {sorted.length > 0 && (
        <section className="intake-section">
          <h3 className="intake-heading">
            You already have {sorted.length === 1 ? 'this card' : 'these cards'}{' '}
            <span className="search-meta">({sorted.length})</span>
          </h3>
          <p className="fine-print">{intro(state.flow)}</p>
          <div className="chips" role="group" aria-label="Resolve all cards">
            {options.map((o) => (
              <button key={o.value} className="chip" onClick={() => onSetAll(o.value)}>
                {o.label} all
              </button>
            ))}
          </div>
          <ul className="result-list">
            {sorted.map((g) => (
              <li key={g.lines[0]!.line.oracleId} className="result-row intake-card">
                <div className="result-main">
                  <div className="result-name">{g.name}</div>
                  <div className="result-sub intake-wrap">You have: {g.owned.map((e) => describeOwned(e)).join(', ')}</div>
                </div>
                {g.lines.map((l) => {
                  const d = decisionOf(state, l);
                  const need = swapNeed(l, d);
                  const picked = d.replaceEntryId ?? l.candidates[0]?.id;
                  return (
                    <div key={l.key} className="intake-line">
                      <div className="result-sub intake-wrap">
                        {incoming}: {describeCopy(state, { ...l.line, quantity: l.line.quantity })}
                        {showBoards ? ` · ${BOARD_LABELS[l.board]}` : ''}
                      </div>
                      <div className="chips" role="group" aria-label={`Resolve ${g.name}`}>
                        {options.map((o) => (
                          <button
                            key={o.value}
                            className="chip"
                            aria-pressed={d.collect === o.value}
                            onClick={() => onSet(l.key, { ...d, collect: o.value })}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                      {need > 0 && l.candidates.length >= 2 && (
                        <div className="intake-swap" role="radiogroup" aria-label={`Which copy of ${g.name} to replace`}>
                          <span className="fine-print">Replaces which copy?</span>
                          {l.candidates.map((e) => (
                            <label key={e.id} className="intake-swap-row">
                              <input
                                type="radio"
                                name={`swap-${l.key}`}
                                checked={picked === e.id}
                                onChange={() => onSet(l.key, { ...d, replaceEntryId: e.id })}
                              />
                              <span>
                                {describeOwned(e, false)} <span className="search-meta">you own ×{e.quantity}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                      {need > 0 && l.candidates.length === 1 && (
                        <p className="fine-print intake-hint">
                          Replaces {need === 1 ? 'one' : need} of your {describeOwned(l.candidates[0]!, false)}
                          {l.candidates[0]!.quantity > need ? ` (you own ${l.candidates[0]!.quantity})` : ''}.
                        </p>
                      )}
                      {need === 0 && d.collect === 'own' && l.exactOwned >= l.line.quantity && (
                        <p className="fine-print intake-hint">You have this exact copy; nothing changes in your collection.</p>
                      )}
                      {need === 0 && d.collect === 'correct' && (
                        <p className="fine-print intake-hint">Nothing distinct to swap; your collection stays as it is.</p>
                      )}
                    </div>
                  );
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function intro(flow: IntakeState['flow']): ReactNode {
  switch (flow) {
    case 'tradelist':
      return (
        <>
          Per card: <strong>Trade</strong> marks the copies you already own for trade (adds nothing), <strong>Add</strong>{' '}
          adds new copies and marks them, <strong>Skip</strong> leaves it off your tradelist.
        </>
      );
    case 'container':
    case 'rescan':
      return (
        <>
          Any printing counts. Per card: <strong>Already mine</strong> files the copy you own (a different printing
          corrects your record), <strong>New copy</strong> adds it to your collection too, <strong>Not mine</strong> lists
          it here without claiming a copy.
        </>
      );
    default:
      return (
        <>
          Any printing counts. Per card: <strong>Add</strong> adds the copies on top, <strong>Update</strong> swaps one copy
          you already own for this printing (your total stays the same), <strong>Skip</strong> changes nothing.
        </>
      );
  }
}
