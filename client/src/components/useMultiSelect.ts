import { useCallback, useState } from 'react';
import { useShortcuts } from './useShortcuts.js';
import { useKeySet } from './useKeySet.js';

/**
 * Local UI state for multi-selecting cards in a list (the collection lists,
 * a container's boards, search results). Selection is keyed by CardItem.key
 * (an entry or slot id, a stack key) and is never persisted: leaving the view
 * drops it. Pair with <SelectionBar> and the selection props on <CardItems>.
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
  toggleAll: (keys: readonly string[]) => void;
  /** Every one of `keys` is selected (false for an empty list). */
  allSelected: (keys: readonly string[]) => boolean;
}

export function useMultiSelect(): MultiSelect {
  const [active, setActive] = useState(false);
  const keys = useKeySet();
  const { reset } = keys;

  const enter = useCallback(() => setActive(true), []);

  const exit = useCallback(() => {
    setActive(false);
    reset();
  }, [reset]);

  // Escape backs out of select mode, same as the ✕ on the bulk bar. Mapped to
  // null when it's off so the key falls through to whatever else wants it —
  // the card cursor clears itself on Escape, and it should only get the key
  // once there's no selection left to cancel.
  useShortcuts({ Escape: active ? exit : null });

  return {
    active,
    selected: keys.set,
    count: keys.set.size,
    toggle: keys.toggle,
    enter,
    exit,
    toggleAll: keys.toggleAll,
    allSelected: keys.all,
  };
}
