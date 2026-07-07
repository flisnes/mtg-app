import { Page, EmptyState } from './Page.js';

export function Tradelist() {
  return (
    <Page title="Tradelist" subtitle="Copies you’ve marked for trade (these also live in your collection).">
      <EmptyState phase="Phase 2">
        Nothing marked for trade. Set a “for trade” quantity on any collection entry to list it here.
      </EmptyState>
    </Page>
  );
}
