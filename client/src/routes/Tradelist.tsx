import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { clearTradelist } from '../db/dataAccess.js';
import { useToast } from '../components/Toast.js';

export function Tradelist() {
  const toast = useToast();

  async function onClearAll() {
    if (!window.confirm('Take every card off the tradelist? Your collection is not affected.')) return;
    const changed = await clearTradelist();
    toast(changed === 0 ? 'Tradelist was already empty' : `Removed ${changed} entries from the tradelist`);
  }

  return (
    <Page title="Tradelist" subtitle="Copies you’ve marked for trade (these also live in your collection).">
      <CollectionListView onlyTrade />
      <button onClick={onClearAll} style={{ alignSelf: 'flex-start' }}>
        Remove all from tradelist
      </button>
    </Page>
  );
}
