import { useEffect, useState } from 'react';
import { CONDITIONS, type CollectionEntry, type Priced, type Printing } from '@mtg/shared';
import { getPrintingsForOracle } from './queries.js';

/**
 * Every printing of one oracle card, newest first. `loaded` turns true once the
 * read settles, failed or not: the card sheet holds its art until then, and an
 * empty frame forever is worse than the oracle's default image.
 */
export function usePrintingsForOracle(
  oracleId: string | undefined,
  /** Already read by the caller (a sheet stacked on one for the same card): skip the read. */
  preloaded?: Priced<Printing>[],
): {
  printings: Priced<Printing>[];
  loaded: boolean;
} {
  const [printings, setPrintings] = useState<Priced<Printing>[]>(preloaded ?? []);
  const [loaded, setLoaded] = useState(!!preloaded);
  useEffect(() => {
    if (!oracleId || preloaded) return;
    let live = true;
    void getPrintingsForOracle(oracleId)
      .then((ps) => {
        if (live) setPrintings(ps);
      })
      .finally(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleId]);
  return { printings, loaded };
}

/**
 * Owned copies in the order you'd reach for them: `fit` first when given (higher
 * is better), then newest edition by `printings` order, then best condition.
 */
export function sortOwnedCopies(
  copies: readonly CollectionEntry[],
  printings: readonly Printing[],
  fit?: (e: CollectionEntry) => number,
): CollectionEntry[] {
  const order = new Map(printings.map((p, n) => [p.scryfallId, n]));
  const rank = (e: CollectionEntry) => order.get(e.scryfallId) ?? printings.length;
  return [...copies].sort(
    (a, b) =>
      (fit ? fit(b) - fit(a) : 0) ||
      rank(a) - rank(b) ||
      CONDITIONS.indexOf(a.condition) - CONDITIONS.indexOf(b.condition),
  );
}
