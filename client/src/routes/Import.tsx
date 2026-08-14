import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OracleCard } from '@mtg/shared';
import { Page } from './Page.js';
import { useToast } from '../components/Toast.js';
import { useFileThese } from '../deck/useFileThese.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import { ImportConflicts } from '../import/ImportConflicts.js';
import { ImportDefaultsRow, IMPORT_DEFAULTS } from '../import/ImportExtras.js';
import { commitResolvedLines, filingCopiesFor } from '../import/commit.js';
import { useReplaceFlow } from '../import/useReplaceFlow.js';
import { findImportConflicts, type ConflictChoice, type ImportConflict } from '../import/conflicts.js';
import type { ImportDefaults, ResolvedLine, TradelistMode, UnmatchedLine } from '../import/types.js';

export function Import() {
  const [text, setText] = useState('');
  const [tradelistMode, setTradelistMode] = useState<TradelistMode>('none');
  // What lines that don't say for themselves are taken to be — the scanner's
  // pile pins, for a pasted list.
  const [defaults, setDefaults] = useState<ImportDefaults>(IMPORT_DEFAULTS);
  const { status, analyze, reset } = useImportAnalysis();
  // Set when review found cards already in the collection: the conflict-
  // resolution step replaces the review until resolved or backed out of.
  const [conflictStep, setConflictStep] = useState<{ lines: ResolvedLine[]; conflicts: ImportConflict[] } | null>(null);
  const { resolveReplacements, sheet: replaceSheet } = useReplaceFlow();
  const { offer: offerFiling, sheet: fileTheseSheet } = useFileThese();
  const toast = useToast();
  const navigate = useNavigate();

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    analyze(content, { tradelistMode, defaults });
  }

  async function confirmImport(lines: ResolvedLine[]) {
    const conflicts = await findImportConflicts(lines);
    if (conflicts.length > 0) {
      setConflictStep({ lines, conflicts });
      return;
    }
    await commit(lines, new Map(), []);
  }

  async function commit(lines: ResolvedLine[], choices: Map<string, ConflictChoice>, conflicts: ImportConflict[]) {
    // "Update" swaps one owned copy for the incoming printing and asks which
    // one when you own several — the same surgical swap the scanner does,
    // rather than deleting every copy of the card you own.
    const outcome = await resolveReplacements(conflicts, choices);
    if (!outcome) return; // backed out of a pick — nothing written

    const res = await commitResolvedLines(lines, choices, outcome, { source: 'import' });
    const skipped = lines.length - res.written.length;
    if (res.written.length === 0) {
      toast('Nothing imported: every card was skipped');
      navigate('/collection');
      return;
    }
    toast(`Imported ${res.added} cards (${res.entries} entries${skipped > 0 ? `, ${skipped} skipped` : ''})`);
    await offerFiling(
      filingCopiesFor(res.written),
      res.written.reduce((n, l) => n + l.quantity, 0),
    );
    navigate('/collection');
  }

  const makeResolved = (u: UnmatchedLine, card: OracleCard, scryfallId: string): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: tradelistMode === 'all' ? u.quantity : 0,
    condition: defaults.condition,
    finish: u.finish ?? defaults.finish,
    lang: defaults.lang,
  });

  return (
    <Page title="Import" subtitle="Paste a list or upload a CSV, Moxfield, Archidekt, or plain text.">
      {status.kind === 'idle' || status.kind === 'error' ? (
        <>
          {status.kind === 'error' && <p className="gate-error">Error: {status.message}</p>}
          <textarea
            className="search-input"
            style={{ minHeight: 160, fontFamily: 'ui-monospace, monospace' }}
            placeholder={'4 Lightning Bolt\n1 Sol Ring (C21) 263\n…or paste a Moxfield/Archidekt CSV'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label className="chip" style={{ alignSelf: 'flex-start' }}>
            Tradelist:{' '}
            <select value={tradelistMode} onChange={(e) => setTradelistMode(e.target.value as TradelistMode)}>
              <option value="none">don’t mark anything for trade</option>
              <option value="file">use tradelist counts from the file</option>
              <option value="all">mark all imported cards for trade</option>
            </select>
          </label>
          <ImportDefaultsRow value={defaults} onChange={setDefaults} />
          <div className="list-toolbar">
            <button className="primary" onClick={() => analyze(text, { tradelistMode, defaults })} disabled={!text.trim()}>
              Analyze
            </button>
            <input type="file" accept=".csv,.txt,text/*" onChange={onFile} />
          </div>
        </>
      ) : status.kind === 'working' ? (
        <>
          <p className="gate-msg">{status.label}</p>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${Math.round(status.fraction * 100)}%` }} />
          </div>
        </>
      ) : conflictStep ? (
        <ImportConflicts
          conflicts={conflictStep.conflicts}
          otherCount={
            conflictStep.lines.length - conflictStep.conflicts.reduce((s, c) => s + c.incoming.length, 0)
          }
          onConfirm={(choices) => commit(conflictStep.lines, choices, conflictStep.conflicts)}
          onBack={() => setConflictStep(null)}
        />
      ) : (
        <ImportReview
          result={status.result}
          makeResolved={makeResolved}
          onConfirm={confirmImport}
          onCancel={reset}
          extraSummary={(lines) => {
            const forTrade = lines.reduce((s, l) => s + l.quantityForTrade, 0);
            return (
              <>
                <dt>For trade</dt>
                <dd>{forTrade === 0 ? 'nothing' : `${forTrade} cards`}</dd>
              </>
            );
          }}
        />
      )}
      {replaceSheet}
      {fileTheseSheet}
    </Page>
  );
}
