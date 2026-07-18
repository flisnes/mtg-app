import { useCallback, useState } from 'react';

/**
 * Local UI state for multi-selecting cards in a list (Collection, Tradelist,
 * Wishlist). Selection is keyed by CardItem.key (= the entry id) and is never
 * persisted — leaving the view drops it. Pair with <BulkActionBar> and the
 * selection props on <CardItems>.
 */
export interface MultiSelect {
  /** Selection mode is on (Select tapped, not yet cancelled). */
  active: boolean;
  selected: Set<string>;
  count: number;
  /** Toggle one key; a no-op unless active. */
  toggle: (key: string) => void;
  /** Turn selection mode on (empty selection). */
  enter: () => void;
  /** Turn it off and clear the selection. */
  exit: () => void;
  /** Select all of `keys` if not all are already selected, else clear. */
  toggleAll: (keys: string[]) => void;
}

export function useMultiSelect(): MultiSelect {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const enter = useCallback(() => setActive(true), []);

  const exit = useCallback(() => {
    setActive(false);
    setSelected(new Set());
  }, []);

  const toggleAll = useCallback((keys: string[]) => {
    setSelected((prev) => (keys.every((k) => prev.has(k)) ? new Set() : new Set(keys)));
  }, []);

  return { active, selected, count: selected.size, toggle, enter, exit, toggleAll };
}
