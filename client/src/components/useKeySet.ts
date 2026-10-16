import { useCallback, useState } from 'react';

/**
 * A set of ticked keys: the state behind every checklist of cards (the bulk
 * selection, "add the missing cards to your wishlist", "add these to your
 * collection too"). Never persisted.
 */
export interface KeySet {
  set: Set<string>;
  has: (key: string) => boolean;
  /** Tick or untick one key. */
  toggle: (key: string) => void;
  /** Tick all of `keys` unless they all already are, then clear. */
  toggleAll: (keys: readonly string[]) => void;
  /** Every one of `keys` is ticked (false for an empty list). */
  all: (keys: readonly string[]) => boolean;
  /** Replace the whole set, empty by default. */
  reset: (keys?: Iterable<string>) => void;
}

export function useKeySet(initial?: Iterable<string>): KeySet {
  const [set, setSet] = useState<Set<string>>(() => new Set(initial));

  const toggle = useCallback((key: string) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback((keys: readonly string[]) => {
    setSet((prev) => (keys.every((k) => prev.has(k)) ? new Set() : new Set(keys)));
  }, []);

  const reset = useCallback((keys?: Iterable<string>) => setSet(new Set(keys)), []);

  const has = useCallback((key: string) => set.has(key), [set]);
  const all = useCallback((keys: readonly string[]) => keys.length > 0 && keys.every((k) => set.has(k)), [set]);

  return { set, has, toggle, toggleAll, all, reset };
}
