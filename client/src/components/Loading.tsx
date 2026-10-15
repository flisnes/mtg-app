/** The "Loading…" line a list or panel shows before its data arrives. `fine` for the smaller print inside a section. */
export function Loading({ fine }: { fine?: boolean }) {
  return <p className={fine ? 'fine-print' : 'search-meta'}>Loading…</p>;
}
