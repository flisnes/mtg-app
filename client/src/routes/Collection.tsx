import { useNavigate } from 'react-router-dom';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { OptionsMenu } from '../components/OptionsMenu.js';

export function Collection() {
  const navigate = useNavigate();
  return (
    <Page
      title="Collection"
      subtitle="Everything you own, search above to add cards."
      menu={
        <OptionsMenu
          label="Collection options"
          actions={[
            { label: 'Import', icon: '⬆', onClick: () => navigate('/import') },
            { label: 'Export', icon: '⬇', onClick: () => navigate('/export') },
          ]}
        />
      }
    >
      <CollectionListView />
    </Page>
  );
}
