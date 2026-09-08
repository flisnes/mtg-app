import { useEffect, useState } from 'react';
import { loadSetIndex } from './setIndex.js';

// Same shape as useOracleTags: `setCompletions` answers synchronously inside a
// useMemo, so something has to load the vocabulary and tick a counter when it
// lands — otherwise the first `set:` typed in a session would offer nothing and
// keep offering nothing until some other dependency happened to change.
//
// The set list falls out of the search index, so this is free once any search
// has run; on a cold start it pays for that one index build.

let ready = false;
const listeners = new Set<(n: number) => void>();

export function useSetIndex(): number {
  const [version, setVersion] = useState(ready ? 1 : 0);
  useEffect(() => {
    if (ready) return;
    listeners.add(setVersion);
    void loadSetIndex().then(() => {
      ready = true;
      for (const l of listeners) l(1);
    });
    return () => {
      listeners.delete(setVersion);
    };
  }, []);
  return version;
}
