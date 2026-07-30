import { useSyncExternalStore } from 'react';
import { getPrefs, subscribePrefs, type Prefs } from './prefs.js';

// The React view of the preference store. Kept apart from prefs.ts so web
// workers can import the store without pulling React into their bundle.

/** Reactive preferences. Re-renders on any setPrefs, and when rates arrive. */
export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs);
}
