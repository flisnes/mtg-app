import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Condition, Finish, Printing } from '@mtg/shared';
import { db } from '../db/schema.js';
import type { ConflictChoice, ImportConflict } from './conflicts.js';

// Step between a review and the actual commit: every card that's already in the
// collection (any printing) is listed with what's owned vs what's incoming, and
// the user picks a per-card choice — or one for all at once. Non-conflicting
// lines always go through. The choices, default, intro copy, and confirm label
// are configurable so the same screen serves collection import (skip/add/
// replace) and the tradelist scan (trade/add/skip).

const CHOICES: { value: ConflictChoice; label: string }[] = [
  { value: 'skip', label: 'Skip' },
  { value: 'add', label: 'Add' },
  { value: 'replace', label: 'Replace' },
];

export function ImportConflicts({
  conflicts,
  otherCount,
  onConfirm,
  onBack,
  options = CHOICES,
  defaultChoice = 'add',
  intro,
  confirmLabel,
}: {
  conflicts: ImportConflict[];
  /** Lines with no conflict — they go through regardless. */
  otherCount: number;
  onConfirm: (choices: Map<string, ConflictChoice>) => void | Promise<void>;
  onBack: () => void;
  /** Choice buttons offered per card (and as "… all" presets). */
  options?: { value: ConflictChoice; label: string }[];
  /** Which choice each card starts on. */
  defaultChoice?: ConflictChoice;
  /** Explanatory paragraph; falls back to the import wording. */
  intro?: ReactNode;
  /** Confirm-button text for the count of affected cards. */
  confirmLabel?: (count: number) => string;
}) {
  const [choices, setChoices] = useState<Map<string, ConflictChoice>>(
    () => new Map(conflicts.map((c) => [c.oracleId, defaultChoice])),
  );
  const [busy, setBusy] = useState(false);

  // Set/collector info for every printing involved, for compact line labels.
  const [printings, setPrintings] = useState<Map<string, Printing>>(new Map());
  useEffect(() => {
    const ids = [
      ...new Set(conflicts.flatMap((c) => [...c.existing.map((e) => e.scryfallId), ...c.incoming.map((l) => l.scryfallId)])),
    ];
    db.printings.bulkGet(ids).then((rows) => {
      setPrintings(new Map(rows.filter((p): p is Printing => !!p).map((p) => [p.scryfallId, p])));
    });
  }, [conflicts]);

  const setAll = (choice: ConflictChoice) =>
    setChoices(new Map(conflicts.map((c) => [c.oracleId, choice])));
  const setOne = (oracleId: string, choice: ConflictChoice) =>
    setChoices((m) => new Map(m).set(oracleId, choice));

  const describe = (l: { quantity: number; condition: Condition; finish: Finish; lang: string; scryfallId: string }) => {
    const p = printings.get(l.scryfallId);
    const set = p ? ` (${p.set.toUpperCase()} #${p.collectorNumber})` : '';
    const finish = l.finish === 'nonfoil' ? '' : ` ${l.finish}`;
    const lang = l.lang && l.lang !== 'en' ? ` ${l.lang}` : '';
    return `${l.quantity}× ${l.condition}${finish}${lang}${set}`;
  };

  const importCount = useMemo(
    () => otherCount + conflicts.reduce((s, c) => s + (choices.get(c.oracleId) === 'skip' ? 0 : c.incoming.length), 0),
    [conflicts, otherCount, choices],
  );

  const defaultIntro = (
    <>
      {conflicts.length} card{conflicts.length === 1 ? '' : 's'} in this import {conflicts.length === 1 ? 'is' : 'are'}{' '}
      already in your collection (any printing counts). Per card: <strong>Skip</strong> leaves your collection as is,{' '}
      <strong>Add</strong> adds the import on top, <strong>Replace</strong> swaps what you own for the import&rsquo;s copies.
      {otherCount > 0 && <> The other {otherCount} line{otherCount === 1 ? '' : 's'} import{otherCount === 1 ? 's' : ''} either way.</>}
    </>
  );

  return (
    <>
      <div className="about-section">
        <h2>Already in your collection</h2>
        <p className="fine-print">{intro ?? defaultIntro}</p>
        <div className="chips" role="group" aria-label="Resolve all cards">
          {options.map((o) => (
            <button key={o.value} className="chip" onClick={() => setAll(o.value)}>
              {o.label} all
            </button>
          ))}
        </div>
      </div>

      <ul className="result-list">
        {conflicts.map((c) => {
          const choice = choices.get(c.oracleId) ?? defaultChoice;
          return (
            <li key={c.oracleId} className="result-row" style={{ flexDirection: 'column', alignItems: 'stretch', padding: '0.6rem', gap: '0.4rem' }}>
              <div className="result-main">
                <div className="result-name">{c.name}</div>
                <div className="result-sub" style={{ whiteSpace: 'normal' }}>
                  You have: {c.existing.map(describe).join(', ')}
                </div>
                <div className="result-sub" style={{ whiteSpace: 'normal' }}>
                  Import: {c.incoming.map(describe).join(', ')}
                </div>
              </div>
              <div className="chips" role="group" aria-label={`Resolve ${c.name}`}>
                {options.map((o) => (
                  <button
                    key={o.value}
                    className="chip"
                    aria-pressed={choice === o.value}
                    onClick={() => setOne(c.oracleId, o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="sheet-actions">
        <button onClick={onBack} disabled={busy}>Back</button>
        <button
          className="primary"
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm(choices);
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
        >
          {busy
            ? confirmLabel
              ? 'Working…'
              : 'Importing…'
            : confirmLabel
              ? confirmLabel(importCount)
              : importCount === 0
                ? 'Skip everything'
                : `Import ${importCount} entries`}
        </button>
      </div>
    </>
  );
}
