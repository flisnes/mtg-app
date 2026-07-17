import { useState } from 'react';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { clearTradelist } from '../db/dataAccess.js';
import { useToast } from '../components/Toast.js';

export function Tradelist() {
  const toast = useToast();
  const [scanning, setScanning] = useState(false);

  async function onClearAll() {
    if (!window.confirm('Take every card off the tradelist? Your collection is not affected.')) return;
    const changed = await clearTradelist();
    toast(changed === 0 ? 'Tradelist was already empty' : `Removed ${changed} entries from the tradelist`);
  }

  return (
    <Page
      title="Tradelist"
      subtitle="Copies you’ve marked for trade (these also live in your collection)."
      menu={
        <OptionsMenu
          label="Tradelist options"
          actions={[
            { label: 'Scan cards', icon: '📷', onClick: () => setScanning(true) },
            { label: 'Remove all from tradelist', icon: '✕', danger: true, onClick: onClearAll },
          ]}
        />
      }
    >
      <CollectionListView onlyTrade />
      {scanning && <ScanSheet target={{ kind: 'tradelist' }} onClose={() => setScanning(false)} />}
    </Page>
  );
}
