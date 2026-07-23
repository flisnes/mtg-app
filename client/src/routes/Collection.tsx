import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { AddSealedProductSheet } from '../components/AddSealedProductSheet.js';
import { HeaderValue, headerValue, useCollectionValue } from '../components/ValueSummary.js';

export function Collection() {
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  const [addingSealed, setAddingSealed] = useState(false);
  const value = useCollectionValue();
  return (
    <Page
      title="Collection"
      subtitle="Everything you own, search above to add cards."
      aside={<HeaderValue value={headerValue(value)} />}
      menu={
        <OptionsMenu
          label="Collection options"
          actions={[
            { label: 'Scan cards', icon: 'camera', onClick: () => setScanning(true) },
            { label: 'Add sealed product', icon: 'sealed', onClick: () => setAddingSealed(true) },
            { label: 'Import', icon: 'import', onClick: () => navigate('/import') },
            { label: 'Export', icon: 'export', onClick: () => navigate('/export') },
          ]}
        />
      }
    >
      <CollectionListView />
      {scanning && <ScanSheet target={{ kind: 'collection' }} onClose={() => setScanning(false)} />}
      {addingSealed && <AddSealedProductSheet onClose={() => setAddingSealed(false)} />}
    </Page>
  );
}
