import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';

export function Tradelist() {
  return (
    <Page title="Tradelist" subtitle="Copies you’ve marked for trade (these also live in your collection).">
      <CollectionListView onlyTrade />
    </Page>
  );
}
