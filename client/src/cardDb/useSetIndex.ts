import { useEffect, useSyncExternalStore } from 'react';
import { loadSetIndex, setIndexGeneration, subscribeSetIndex } from './setIndex.js';

// Same shape as useOracleTags: `setCompletions` answers synchronously inside a
// useMemo, so something has to load the vocabulary and tick a counter when it
// lands — otherwise the first `set:` typed in a session would offer nothing and
// keep offering nothing until some other dependency happened to change.
//
// The set list falls out of the search index, which reads every card and
// printing, so the search bar only asks once a `set:` term is being typed.

export function useSetIndex(enabled = true): number {
  const generation = useSyncExternalStore(subscribeSetIndex, setIndexGeneration);
  useEffect(() => {
    if (enabled) void loadSetIndex();
  }, [enabled, generation]);
  return generation;
}
