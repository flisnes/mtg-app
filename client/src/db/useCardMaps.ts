import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { getOracleCardsByIds, getPrintingsByIds } from './queries.js';

/**
 * Display data for a set of trade-style lines (which carry only ids): the
 * printings (images, prices) and oracle cards they reference, as live maps.
 */
export function useCardMaps(lines: Array<{ scryfallId: string; oracleId: string }>): {
  printMap: Map<string, Priced<Printing>> | undefined;
  oracleMap: Map<string, Priced<OracleCard>> | undefined;
} {
  const printMap = useLiveQuery(
    () => getPrintingsByIds(lines.map((l) => l.scryfallId)),
    [lines.map((l) => l.scryfallId).join(',')],
  );
  const oracleMap = useLiveQuery(
    () => getOracleCardsByIds(lines.map((l) => l.oracleId)),
    [lines.map((l) => l.oracleId).join(',')],
  );
  return { printMap, oracleMap };
}
