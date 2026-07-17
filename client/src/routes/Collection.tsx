import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';

export function Collection() {
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  return (
    <Page
      title="Collection"
      subtitle="Everything you own, search above to add cards."
      menu={
        <OptionsMenu
          label="Collection options"
          actions={[
            { label: 'Scan cards', icon: '📷', onClick: () => setScanning(true) },
            { label: 'Import', icon: '⬆', onClick: () => navigate('/import') },
            { label: 'Export', icon: '⬇', onClick: () => navigate('/export') },
          ]}
        />
      }
    >
      <CollectionListView />
      {scanning && <ScanSheet onClose={() => setScanning(false)} />}
    </Page>
  );
}
