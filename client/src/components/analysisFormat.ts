// The two number formats every analysis panel speaks in, so "72%" and "3.4"
// read the same from the overview down to the toast.

/** A probability as a whole percent: 0.724 → "72%". */
export const pct = (p: number) => `${Math.round(p * 100)}%`;

/** A count or average to one decimal: 3.44 → "3.4". */
export const one = (n: number) => n.toFixed(1);
