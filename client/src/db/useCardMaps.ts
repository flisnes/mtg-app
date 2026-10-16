import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { getOracleCardsByIds, getPrintingsByIds } from './queries.js';

/** Card-DB records for a set of id-only lines. Either map is undefined while it loads. */
export interface CardMaps {
  printMap: Map<string, Priced<Printing>> | undefined;
  oracleMap: Map<string, Priced<OracleCard>> | undefined;
}

/**
 * Display data for a set of trade-style lines (which carry only ids): the
 * printings (images, prices) and oracle cards they reference, as live maps.
 * A line with no scryfallId (an "any printing" wish, an event without one)
 * contributes only its oracle card.
 *
 * `epoch` re-runs both queries when bumped. Prices are served from an in-memory
 * shard cache, so a price import that lands while these maps are mounted isn't
 * guaranteed to reach the live query on its own — callers that trigger one
 * (the trade board) bump the epoch instead of hoping.
 */
export function useCardMaps(
  lines: ReadonlyArray<{ scryfallId?: string | null; oracleId: string }>,
  epoch = 0,
): CardMaps {
  const scryfallIds = lines.map((l) => l.scryfallId).filter((id): id is string => !!id);
  const oracleIds = lines.map((l) => l.oracleId);
  const printMap = useLiveQuery(() => getPrintingsByIds(scryfallIds), [scryfallIds.join(','), epoch]);
  const oracleMap = useLiveQuery(() => getOracleCardsByIds(oracleIds), [oracleIds.join(','), epoch]);
  // Stable between loads, so callers can memo on the pair.
  return useMemo(() => ({ printMap, oracleMap }), [printMap, oracleMap]);
}
