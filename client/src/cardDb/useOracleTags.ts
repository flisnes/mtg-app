import { useEffect, useSyncExternalStore } from 'react';
import { loadOracleTags, oracleTagsGeneration, subscribeOracleTags } from './oracleTags.js';

// The owned-list filters (collection, wishlist, a viewed profile's lists) parse
// their query synchronously inside a useMemo, so unlike the full-DB search they
// can't await the tag vocabulary. This loads it and returns a counter that ticks
// whenever it lands or is dropped, for those memos to depend on — otherwise the
// first `otag:` typed on a list would resolve to nothing and stay that way
// until some other dependency happened to change.
//
// The counter lives in oracleTags.ts, not here: a card-data update drops the
// vocabulary, and a flag kept in this module used to say "loaded" through that,
// so `otag:` on a list went dead until the next launch.
//
// `enabled` keeps the fetch off screens that only might need it: the search bar
// and the list filters pass "does the query mention otag:".

export function useOracleTags(enabled = true): number {
  const generation = useSyncExternalStore(subscribeOracleTags, oracleTagsGeneration);
  useEffect(() => {
    if (enabled) void loadOracleTags();
  }, [enabled, generation]);
  return generation;
}
