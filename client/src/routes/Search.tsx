import { Page, EmptyState } from './Page.js';

export function Search() {
  return (
    <Page title="Search" subtitle="Find cards to add to your collection, wishlist, or tradelist.">
      <input className="search-input" type="search" placeholder="Search cards…" disabled aria-label="Search cards" />
      <EmptyState phase="Phase 1">
        The card database isn’t loaded yet. Search over ~30k cards with images and prices lands next.
      </EmptyState>
    </Page>
  );
}
