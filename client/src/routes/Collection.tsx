import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { OptionsMenu } from '../components/OptionsMenu.js';
import { ScanSheet } from '../components/ScanSheet.js';
import { AddSealedProductSheet } from '../components/AddSealedProductSheet.js';
import { HeaderValue, headerValue, useCollectionValue, useSealedValue } from '../components/ValueSummary.js';
import { CollectionValueChartSheet } from '../components/CollectionValueChart.js';

export function Collection() {
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  const [addingSealed, setAddingSealed] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const value = useCollectionValue();
  const sealed = useSealedValue();
  // Unopened boxes count toward what the collection is worth. Their prices are
  // USD-quoted (TCGplayer), so they ride in the usd bucket and convert to the
  // display currency exactly like a card Scryfall only prices in dollars.
  const withSealed =
    value && sealed && sealed.usd > 0 ? { eur: value.eur, usd: value.usd + sealed.usd } : value;
  return (
    <Page
      title="Collection"
      subtitle="Everything you own. Search above to filter it."
      aside={
        <HeaderValue
          value={headerValue(withSealed)}
          note={sealed && sealed.boxes > 0 ? `incl. ${sealed.boxes} sealed` : undefined}
          onClick={() => setChartOpen(true)}
          title="Open the collection value chart"
        />
      }
      menu={
        <OptionsMenu
          label="Collection options"
          actions={[
            { label: 'Scan cards', icon: 'camera', onClick: () => setScanning(true) },
            { label: 'Add sealed product', icon: 'sealed', onClick: () => setAddingSealed(true) },
            { label: 'Sealed products', icon: 'sealed', onClick: () => navigate('/sealed') },
            { label: 'Import', icon: 'import', onClick: () => navigate('/import') },
            { label: 'Export', icon: 'export', onClick: () => navigate('/export') },
          ]}
        />
      }
    >
      <CollectionListView />
      {scanning && <ScanSheet target={{ kind: 'collection' }} onClose={() => setScanning(false)} />}
      {addingSealed && <AddSealedProductSheet onClose={() => setAddingSealed(false)} />}
      {chartOpen && <CollectionValueChartSheet onClose={() => setChartOpen(false)} />}
    </Page>
  );
}
