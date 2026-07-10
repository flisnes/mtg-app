import { Link } from 'react-router-dom';
import { Page } from './Page.js';
import { CollectionListView } from '../components/CollectionListView.js';
import { useOpenSearch } from '../components/GlobalSearch.js';

export function Collection() {
  const openSearch = useOpenSearch();
  return (
    <Page title="Collection" subtitle="Everything you own — filter, edit, import, and export.">
      <div className="list-toolbar">
        <button className="chip" onClick={openSearch}>
          ＋ Add cards
        </button>
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
