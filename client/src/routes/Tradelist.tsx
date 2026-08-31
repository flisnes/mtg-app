import { useState } from 'react';
import type { OracleCard } from '@mtg/shared';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { HeaderValue, headerValue, useCollectionValue } from '../components/ValueSummary.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { clearTradelist } from '../db/dataAccess.js';
import { useToast } from '../components/Toast.js';
import { useUndoShortcut } from '../history/useUndoShortcut.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { useFileThese } from '../deck/useFileThese.js';
import { buildTradelistCsv, downloadText } from '../import/export.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import { ImportConflicts } from '../import/ImportConflicts.js';
import { ImportDefaultsRow, IMPORT_DEFAULTS } from '../import/ImportExtras.js';
import { commitResolvedLines, filingCopiesFor } from '../import/commit.js';
import { useReplaceFlow } from '../import/useReplaceFlow.js';
import { findImportConflicts, type ConflictChoice, type ImportConflict } from '../import/conflicts.js';
import type { ImportDefaults, ResolvedLine, UnmatchedLine } from '../import/types.js';

export function Tradelist() {
  const toast = useToast();
  // Marking for trade writes collection rows, so it undoes on that stack.
  useUndoShortcut({ kind: 'collection' });
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const value = useCollectionValue(true);
  const { confirm, sheet: confirmSheet } = useConfirm();

  async function onClearAll() {
    const ok = await confirm({
      title: 'Empty the tradelist?',
      body: 'Every card comes off the tradelist. Your collection itself is not affected.',
      confirmLabel: 'Take them all off',
      danger: true,
    });
    if (!ok) return;
    const changed = await clearTradelist();
    toast(changed === 0 ? 'Tradelist was already empty' : `Removed ${changed} entries from the tradelist`);
  }

  async function exportTradelist() {
    const rows = await buildTradelistCsv();
    // Header only means nothing is marked for trade.
    if (rows.trim().split('\n').length <= 1) {
      toast('Your tradelist is empty');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`mtg-tradelist-${stamp}.csv`, rows);
    toast('Exported tradelist');
  }

  return (
    <Page
      title="Tradelist"
      aside={<HeaderValue value={headerValue(value)} />}
      menu={
        <OptionsMenu
          label="Tradelist options"
          actions={[
            { label: 'Scan cards', icon: 'camera', onClick: () => setScanning(true) },
            { label: 'Import', icon: 'import', onClick: () => setImporting((v) => !v) },
            { label: 'Export', icon: 'export', onClick: exportTradelist },
            { label: 'Remove all from tradelist', icon: 'trash', danger: true, onClick: onClearAll },
          ]}
        />
      }
    >
      {importing && <ImportPanel onDone={() => setImporting(false)} />}
      <CollectionListView onlyTrade />
      {scanning && <ScanSheet target={{ kind: 'tradelist' }} onClose={() => setScanning(false)} />}
      {confirmSheet}
    </Page>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [defaults, setDefaults] = useState<ImportDefaults>(IMPORT_DEFAULTS);
  const { status, analyze, reset } = useImportAnalysis();
  // Set when review found cards already in the collection: the conflict-
  // resolution step replaces the review until resolved or backed out of.
  const [conflictStep, setConflictStep] = useState<{ lines: ResolvedLine[]; conflicts: ImportConflict[] } | null>(null);
  const { resolveReplacements, sheet: replaceSheet } = useReplaceFlow();
  const { offer: offerFiling, sheet: fileTheseSheet } = useFileThese();
  const toast = useToast();

  // Importing to the tradelist means "offer these for trade", so every copy is
  // marked for trade (tradelistMode 'all'), whatever the file's own counts say.
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    analyze(content, { tradelistMode: 'all', defaults });
  }

  const makeResolved = (u: UnmatchedLine, card: OracleCard, scryfallId: string): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: u.quantity,
    condition: defaults.condition,
    finish: u.finish ?? defaults.finish,
    lang: defaults.lang,
  });

  async function confirmImport(lines: ResolvedLine[]) {
    const conflicts = await findImportConflicts(lines);
    if (conflicts.length > 0) {
      setConflictStep({ lines, conflicts });
      return;
    }
    await commit(lines, new Map(), []);
  }

  async function commit(lines: ResolvedLine[], choices: Map<string, ConflictChoice>, conflicts: ImportConflict[]) {
    const outcome = await resolveReplacements(conflicts, choices);
    if (!outcome) return;
    const res = await commitResolvedLines(lines, choices, outcome, { source: 'import', label: 'Tradelist import' });
    if (res.written.length === 0 && res.flagged === 0) {
      toast('Nothing imported: every card was skipped');
      onDone();
      return;
    }
    const forTrade = res.written.reduce((s, l) => s + l.quantityForTrade, 0) + res.flagged;
    toast(`Added ${forTrade} card${forTrade === 1 ? '' : 's'} to the tradelist`);
    await offerFiling(
      filingCopiesFor(res.written),
      res.written.reduce((n, l) => n + l.quantity, 0),
    );
    onDone();
  }

  if (status.kind === 'working') {
    return (
      <div className="about-section">
        <p className="gate-msg">{status.label}</p>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${Math.round(status.fraction * 100)}%` }} />
        </div>
      </div>
    );
  }

  if (conflictStep) {
    const nConflicts = conflictStep.conflicts.length;
    const otherCount = conflictStep.lines.length - conflictStep.conflicts.reduce((s, c) => s + c.incoming.length, 0);
    return (
      <div className="about-section">
        {/* The same three choices the tradelist *scan* offers. Importing a list
            of cards you already own should be able to say "these are the ones
            on my shelf" rather than only "add another copy" or "delete mine". */}
        <ImportConflicts
          conflicts={conflictStep.conflicts}
          otherCount={otherCount}
          options={[
            { value: 'trade', label: 'Trade' },
            { value: 'add', label: 'Add' },
            { value: 'skip', label: 'Skip' },
          ]}
          defaultChoice="trade"
          intro={
            <>
              {nConflicts} card{nConflicts === 1 ? '' : 's'} in this list {nConflicts === 1 ? 'is' : 'are'} already in
              your collection. Per card: <strong>Trade</strong> marks the copies you already own for trade (adds
              nothing), <strong>Add</strong> adds new copies and marks them, <strong>Skip</strong> leaves it off your
              tradelist.
              {otherCount > 0 && (
                <>
                  {' '}
                  The other {otherCount} card{otherCount === 1 ? '' : 's'} you don&rsquo;t own yet{' '}
                  {otherCount === 1 ? 'is' : 'are'} added to your collection and marked for trade.
                </>
              )}
            </>
          }
          confirmLabel={(n) => (n === 0 ? 'Nothing to add' : `Add ${n} card${n === 1 ? '' : 's'} to the tradelist`)}
          onConfirm={(choices) => commit(conflictStep.lines, choices, conflictStep.conflicts)}
          onBack={() => setConflictStep(null)}
        />
        {replaceSheet}
        {fileTheseSheet}
      </div>
    );
  }

  if (status.kind === 'review') {
    return (
      <div className="about-section">
        <ImportReview
          result={status.result}
          makeResolved={makeResolved}
          onConfirm={confirmImport}
          onCancel={reset}
          confirmLabel={(n) => `Add ${n} to tradelist`}
        />
        {replaceSheet}
        {fileTheseSheet}
      </div>
    );
  }

  return (
    <div className="about-section">
      {status.kind === 'error' && <p className="gate-error">Error: {status.message}</p>}
      <p className="fine-print">
        Paste a list or upload a file. Every card is added to your collection and marked for trade.
      </p>
      <textarea
        className="search-input"
        style={{ minHeight: 140, fontFamily: 'ui-monospace, monospace' }}
        placeholder={'4 Lightning Bolt\n1 Sol Ring (C21) 263\n…or paste a Moxfield/Archidekt list'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <ImportDefaultsRow value={defaults} onChange={setDefaults} />
      <div className="list-toolbar">
        <button className="primary" onClick={() => analyze(text, { tradelistMode: 'all', defaults })} disabled={!text.trim()}>
          Analyze
        </button>
        <input type="file" accept=".csv,.txt,text/*" onChange={onFile} />
      </div>
    </div>
  );
}
