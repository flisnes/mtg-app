import { Page, EmptyState } from './Page.js';

export function History() {
  return (
    <Page title="Trade history" subtitle="Completed trades, stored only on this device.">
      <EmptyState phase="Phase 4">No trades yet.</EmptyState>
    </Page>
  );
}
