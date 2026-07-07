import { Link } from 'react-router-dom';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';

export function Collection() {
  return (
    <Page title="Collection" subtitle="Everything you own — filter, edit, import, and export.">
      <div className="list-toolbar">
        <Link className="chip" to="/">
          ＋ Add cards
        </Link>
        <Link className="chip" to="/import">
          ⬆ Import
        </Link>
        <Link className="chip" to="/export">
          ⬇ Export
        </Link>
      </div>
      <CollectionListView />
    </Page>
  );
}
