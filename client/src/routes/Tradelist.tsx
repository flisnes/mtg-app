import { useState } from 'react';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { HeaderValue, headerValue, useCollectionValue } from '../components/ValueSummary.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheetLazy.js';
import { CardDropZone } from '../components/CardDropZone.js';
import { clearTradelist } from '../db/dataAccess.js';
import { useToast } from '../components/Toast.js';
import { useUndoShortcut } from '../history/useUndoShortcut.js';
import { useConfirm } from '../components/ConfirmSheet.js';
import { buildTradelistCsv, downloadText } from '../import/export.js';
import { ImportPanel } from '../import/ImportPanel.js';
import { describeFiling, useIntakeReview } from '../import/intake/useIntakeReview.js';
import type { ResolvedLine } from '../import/types.js';
import { plural } from '../util/format.js';

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
      {importing && <TradelistImport onDone={() => setImporting(false)} />}
      <CollectionListView onlyTrade />
      {scanning && <ScanSheet target={{ kind: 'tradelist' }} onClose={() => setScanning(false)} />}
      <CardDropZone target={scanning ? null : { kind: 'tradelist' }} />
      {confirmSheet}
    </Page>
  );
}

function TradelistImport({ onDone }: { onDone: () => void }) {
  // The same three choices the tradelist *scan* offers, then where the new
  // copies live: one questionnaire, before anything is written.
  const { open: review, sheet: intakeSheet } = useIntakeReview();
  const toast = useToast();

  async function confirmImport(lines: ResolvedLine[]) {
    const res = await review({ flow: 'tradelist', lines, source: 'import', label: 'Tradelist import', incomingLabel: 'Import' });
    if (!res) return;
    if (res.added === 0 && res.flagged === 0) {
      toast('Nothing imported: every card was skipped');
      onDone();
      return;
    }
    const forTrade = res.added + res.flagged;
    toast(`Added ${forTrade} ${plural(forTrade, 'card')} to the tradelist${describeFiling(res)}`);
    onDone();
  }

  // Importing to the tradelist means "offer these for trade", so every copy is
  // marked for trade (tradelistMode 'all'), whatever the file's own counts say.
  return (
    <>
      <ImportPanel
        intro="Paste a list or upload a file. Every card is added to your collection and marked for trade."
        tradelistMode="all"
        onConfirm={confirmImport}
        confirmLabel={(n) => `Add ${n} to tradelist`}
      />
      {intakeSheet}
    </>
  );
}
