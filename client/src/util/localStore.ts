import { useSyncExternalStore } from 'react';

// Device-shaped, synchronous state: view toggles, sort orders, recent searches,
// the scanner's locks. localStorage can be missing, full or blocked (private
// mode, quota, a sandboxed iframe), and none of that is worth a crash, so every
// read falls back and every write is best-effort.

/** The raw stored string, or null when there is none or storage is unavailable. */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Store a string; null removes the key. Quota or blocked storage is ignored. */
export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* quota exceeded or storage unavailable: the in-memory state still serves this visit */
  }
}

/** Parsed JSON, or undefined when missing or unparseable. Validate the shape yourself. */
export function readJson(key: string): unknown {
  const raw = readLocal(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeLocal(key, JSON.stringify(value));
}

/**
 * One localStorage key shared by every mounted reader: a write from one
 * component (the search overlay, say) updates the list underneath it too,
 * instead of leaving it on the old value until it remounts. Usable outside
 * React through get/set.
 */
interface SharedStore<T> {
  get: () => T;
  set: (v: T) => void;
  /** The current value, re-rendering on every set. */
  use: () => [T, (v: T) => void];
}

const stores = new Map<string, SharedStore<unknown>>();

/**
 * The shared store for `key`. One per key for the life of the page: a second
 * call returns the first store, so its `parse` and `serialize` win. `parse`
 * gets null when nothing is stored and must turn anything it doesn't
 * recognise into the default.
 */
export function sharedLocalStorage<T>(
  key: string,
  parse: (stored: string | null) => T,
  serialize: (v: T) => string,
): SharedStore<T> {
  const existing = stores.get(key);
  if (existing) return existing as SharedStore<T>;
  let loaded = false;
  let current: T;
  const listeners = new Set<() => void>();
  const get = (): T => {
    if (!loaded) {
      try {
        current = parse(readLocal(key));
      } catch {
        current = parse(null);
      }
      loaded = true;
    }
    return current;
  };
  const set = (v: T) => {
    current = v;
    loaded = true;
    writeLocal(key, serialize(v));
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  const store: SharedStore<T> = {
    get,
    set,
    use: () => [useSyncExternalStore(subscribe, get), set],
  };
  stores.set(key, store as SharedStore<unknown>);
  return store;
}

/** A shared localStorage value as React state. See sharedLocalStorage. */
export function useSharedLocalStorage<T>(
  key: string,
  parse: (stored: string | null) => T,
  serialize: (v: T) => string,
): [T, (v: T) => void] {
  return sharedLocalStorage(key, parse, serialize).use();
}
