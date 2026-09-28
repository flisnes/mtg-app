import { useState, type ReactNode } from 'react';
import type { ContainerKind } from '@mtg/shared';
import { CONTAINER_META } from '../deck/containers.js';
import type { FilingClash, FilingMode } from '../deck/filing.js';
import { setPrefs } from '../prefs.js';
import { Icon } from './icons.js';
import { Sheet } from './Sheet.js';

/**
 * "This card is already filed somewhere else." A card can only be in one place at
 * a time, so filing a copy that's already promised to a deck, binder or box and
 * that you own no spare of is a question, not an instruction: did you move it, or
 * are you brewing two lists around the same card?
 *
 * One sheet for the whole batch — filing forty cards out of the collection asks
 * once and applies the answer to all of them, rather than forty modals. Ticking
 * "don't ask again" writes `prefs.filingPolicy`, changeable later in Settings.
 */
export function FilingChoiceSheet({
  clashes,
  targetName,
  targetKind,
  onChoose,
  onClose,
}: {
  clashes: FilingClash[];
  targetName: string;
  targetKind: ContainerKind;
  onChoose: (mode: FilingMode) => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} title="Already filed somewhere else" label="Choose how to file these cards">
      <FilingChoiceBody clashes={clashes} targetName={targetName} targetKind={targetKind} onChoose={onChoose}>
        <button onClick={onClose}>Cancel</button>
      </FilingChoiceBody>
    </Sheet>
  );
}

/**
 * The question itself, without the sheet: the intake questionnaire asks it as
 * one of its steps, inside its own sheet. `children` are extra actions under
 * the two answers (Cancel here, Back there).
 */
export function FilingChoiceBody({
  clashes,
  targetName,
  targetKind,
  onChoose,
  children,
}: {
  clashes: FilingClash[];
  targetName: string;
  targetKind: ContainerKind;
  onChoose: (mode: FilingMode) => void;
  children?: ReactNode;
}) {
  const [remember, setRemember] = useState(false);
  const meta = CONTAINER_META[targetKind];
  const n = clashes.length;

  function choose(mode: FilingMode) {
    if (remember) setPrefs({ filingPolicy: mode });
    onChoose(mode);
  }

  return (
    <>
      <p className="search-meta">
        {n === 1 ? 'This card is' : `${n} of these cards are`} filed elsewhere already, and you own no spare
        copy. A card can only be in one place at a time — did {n === 1 ? 'it' : 'they'} move into {targetName}?
      </p>

      <ul className="filing-clash-list">
        {clashes.map((clash, i) => (
          <li key={`${clash.copy.oracleId}-${clash.copy.scryfallId ?? ''}-${i}`} className="filing-clash">
            <span className="filing-clash-card">
              {clash.copy.quantity > 1 && <span className="qty-pill">{clash.copy.quantity}×</span>}
              <span className="deck-name">{clash.copy.label ?? 'Card'}</span>
              {clash.copy.sub && <span className="search-meta">{clash.copy.sub}</span>}
            </span>
            <span className="filing-clash-where">
              {clash.elsewhere.map((place) => (
                <span key={place.containerId} className="place-pill place-pill-static">
                  <Icon name={CONTAINER_META[place.kind].icon} size={13} />
                  <span className="place-pill-name">{place.name}</span>
                  {place.quantity > 1 && <span className="place-pill-qty">×{place.quantity}</span>}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>

      <label className="agree-row">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>Always do this, don’t ask again</span>
      </label>
      <p className="fine-print">You can change this later under Settings → Filing.</p>

      <div className="sheet-actions sheet-actions-stack">
        <button className="primary" onClick={() => choose('move')}>
          Yes, move {n === 1 ? 'it' : 'them'} to this {meta.noun}
        </button>
        <button onClick={() => choose('copy')}>
          No, file here too and leave the other{n === 1 ? '' : 's'}
        </button>
        {children}
      </div>
    </>
  );
}
