import { Page, EmptyState } from './Page.js';

export function Collection() {
  return (
    <Page title="Collection" subtitle="Everything you own — filter, edit, import, and export.">
      <EmptyState phase="Phase 2">
        Your collection is empty. You’ll be able to add cards from search or import a Moxfield / Archidekt / plain-text
        list.
      </EmptyState>
    </Page>
  );
}
