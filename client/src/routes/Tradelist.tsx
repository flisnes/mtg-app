import { useState } from 'react';
import type { OracleCard } from '@mtg/shared';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { HeaderValue, headerValue, useCollectionValue } from '../components/ValueSummary.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { applyImport, clearTradelist } from '../db/dataAccess.js';
import { useToast } from '../components/Toast.js';
import { buildTradelistCsv, downloadText } from '../import/export.js';
import { useImportAnalysis } from '../import/useImportAnalysis.js';
import { ImportReview } from '../import/ImportReview.js';
import { ImportConflicts } from '../import/ImportConflicts.js';
import { findImportConflicts, type ConflictChoice, type ImportConflict } from '../import/conflicts.js';
import type { ResolvedLine, UnmatchedLine } from '../import/types.js';

export function Tradelist() {
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const value = useCollectionValue(true);

  async function onClearAll() {
    if (!window.confirm('Take every card off the tradelist? Your collection is not affected.')) return;
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
      subtitle="Copies you’ve marked for trade (these also live in your collection)."
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
    </Page>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const { status, analyze, reset } = useImportAnalysis();
  // Set when review found cards already in the collection: the conflict-
  // resolution step replaces the review until resolved or backed out of.
  const [conflictStep, setConflictStep] = useState<{ lines: ResolvedLine[]; conflicts: ImportConflict[] } | null>(null);
  const toast = useToast();

  // Importing to the tradelist means "offer these for trade", so every copy is
  // marked for trade (tradelistMode 'all'), whatever the file's own counts say.
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setText(content);
    analyze(content, { tradelistMode: 'all' });
  }

  const makeResolved = (u: UnmatchedLine, card: OracleCard): ResolvedLine => ({
    oracleId: card.oracleId,
    scryfallId: card.defaultScryfallId,
    name: card.name,
    quantity: u.quantity,
    quantityForTrade: u.quantity,
    condition: 'NM',
    finish: u.finish ?? 'nonfoil',
    lang: 'en',
  });

  async function confirmImport(lines: ResolvedLine[]) {
    const conflicts = await findImportConflicts(lines);
    if (conflicts.length > 0) {
      setConflictStep({ lines, conflicts });
      return;
    }
    await commit(lines, new Map());
  }

  async function commit(lines: ResolvedLine[], choices: Map<string, ConflictChoice>) {
    const kept = lines.filter((l) => choices.get(l.oracleId) !== 'skip');
    const replaceOracleIds = [...choices].filter(([, c]) => c === 'replace').map(([id]) => id);
    if (kept.length === 0) {
      toast('Nothing imported: every card was skipped');
      onDone();
      return;
    }
    await applyImport(kept, { source: 'import', label: 'Tradelist import', replaceOracleIds });
    const forTrade = kept.reduce((s, l) => s + l.quantityForTrade, 0);
    toast(`Added ${forTrade} card${forTrade === 1 ? '' : 's'} to the tradelist`);
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
    return (
      <div className="about-section">
        <ImportConflicts
          conflicts={conflictStep.conflicts}
          otherCount={
            conflictStep.lines.length - conflictStep.conflicts.reduce((s, c) => s + c.incoming.length, 0)
          }
          onConfirm={(choices) => commit(conflictStep.lines, choices)}
          onBack={() => setConflictStep(null)}
        />
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
      <div className="list-toolbar">
        <button className="primary" onClick={() => analyze(text, { tradelistMode: 'all' })} disabled={!text.trim()}>
          Analyze
        </button>
        <input type="file" accept=".csv,.txt,text/*" onChange={onFile} />
      </div>
    </div>
  );
}
