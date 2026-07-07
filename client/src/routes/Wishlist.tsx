import { Page, EmptyState } from './Page.js';

export function Wishlist() {
  return (
    <Page title="Wishlist" subtitle="Cards you’re after — surfaced to trade partners during a session.">
      <EmptyState phase="Phase 2">Nothing on your wishlist yet.</EmptyState>
    </Page>
  );
}
