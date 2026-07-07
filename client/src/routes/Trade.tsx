import { Page, EmptyState } from './Page.js';

export function Trade() {
  return (
    <Page title="Trade" subtitle="Trade in person: share a code, build offers, confirm after inspecting.">
      <div className="trade-actions">
        <button disabled>Start a trade</button>
        <button disabled>Join with a code</button>
      </div>
      <EmptyState phase="Phase 4">
        Live trade sessions connect two devices via a 6-character code. Your partner shows as “Other User”.
      </EmptyState>
    </Page>
  );
}
