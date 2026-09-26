import { useEffect, useState } from 'react';
import { loadDefaults, PREWRITTEN_ONLY, type ShippedDefaults } from '@mtg/sim';

/** The shipped defaults, PREWRITTEN_ONLY until the review file lands. */
export function useDefaults(): ShippedDefaults {
  const [defaults, setDefaults] = useState<ShippedDefaults>(PREWRITTEN_ONLY);
  useEffect(() => {
    let live = true;
    void loadDefaults().then((d) => live && setDefaults(d));
    return () => {
      live = false;
    };
  }, []);
  return defaults;
}
