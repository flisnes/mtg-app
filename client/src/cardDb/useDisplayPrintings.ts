import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { useOwnershipIndex } from '../db/useOwnership.js';
import { usePrefs } from '../usePrefs.js';
import {
  NO_DISPLAY_PRINTINGS,
  needsPrintingLookup,
  resolveDisplayPrintings,
} from './preferredPrinting.js';

// The React view of the printing preference (see preferredPrinting.ts for the
// rules). Separate module so the import worker can use the resolver without
// dragging React into its bundle.

/**
 * The printing each of these cards should display as, keyed by oracleId. Cards
 * absent from the map keep the card DB's own representative printing. Returns
 * the shared empty map — and queries nothing — on the default preference.
 */
export function useDisplayPrintings(
  cards: Pick<OracleCard, 'oracleId'>[] | undefined,
): Map<string, Priced<Printing>> {
  const prefs = usePrefs();
  const ownership = useOwnershipIndex();
  const active = needsPrintingLookup(prefs.printing, prefs.preferOwnedPrinting);
  const key = active ? (cards?.map((c) => c.oracleId).join(',') ?? '') : '';
  // The ownership index gets a new identity on every collection edit, so it only
  // belongs in the dependencies when the preference actually consults it.
  const ownershipDep = prefs.preferOwnedPrinting ? ownership : undefined;
  return (
    useLiveQuery(
      async () => {
        if (!active || !cards?.length) return NO_DISPLAY_PRINTINGS;
        return resolveDisplayPrintings(
          cards.map((c) => c.oracleId),
          { owned: ownershipDep },
        );
      },
      [key, active, prefs.printing, prefs.preferOwnedPrinting, prefs.baseCurrency, ownershipDep],
      NO_DISPLAY_PRINTINGS,
    ) ?? NO_DISPLAY_PRINTINGS
  );
}
