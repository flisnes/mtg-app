import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { getOracleCardsByIds, getPrintingsByIds } from './queries.js';

/**
 * Display data for a set of trade-style lines (which carry only ids): the
 * printings (images, prices) and oracle cards they reference, as live maps.
 *
 * `epoch` re-runs both queries when bumped. Prices are served from an in-memory
 * shard cache, so a price import that lands while these maps are mounted isn't
 * guaranteed to reach the live query on its own — callers that trigger one
 * (the trade board) bump the epoch instead of hoping.
 */
export function useCardMaps(
  lines: Array<{ scryfallId: string; oracleId: string }>,
  epoch = 0,
): {
  printMap: Map<string, Priced<Printing>> | undefined;
  oracleMap: Map<string, Priced<OracleCard>> | undefined;
} {
  const printMap = useLiveQuery(
    () => getPrintingsByIds(lines.map((l) => l.scryfallId)),
    [lines.map((l) => l.scryfallId).join(','), epoch],
  );
  const oracleMap = useLiveQuery(
    () => getOracleCardsByIds(lines.map((l) => l.oracleId)),
    [lines.map((l) => l.oracleId).join(','), epoch],
  );
  return { printMap, oracleMap };
}
