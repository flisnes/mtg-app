import { Page, EmptyState } from './Page.js';

export function Decks() {
  return (
    <Page title="Decks" subtitle="Brew decks; owned cards get a green check.">
      <EmptyState phase="Phase 3">
        No decks yet. You’ll be able to build decks and get prompted to wishlist the cards you’re missing.
      </EmptyState>
    </Page>
  );
}
