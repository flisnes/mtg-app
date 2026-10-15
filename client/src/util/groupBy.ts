// Tiny collection helpers that kept getting written inline.

/** Rows bucketed by `key`, in first-seen order. */
export function groupBy<T, K>(rows: Iterable<T>, key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** Total `quantity` across rows. */
export function sumQty(rows: readonly { quantity: number }[]): number {
  let n = 0;
  for (const r of rows) n += r.quantity;
  return n;
}
