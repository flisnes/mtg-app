// Device preferences: how money is displayed, which printing represents a card,
// and how freely the app may spend the user's data plan.
//
// These live in localStorage rather than the synced `settings` table for two
// reasons. They're device-shaped ("this phone is on mobile data", "this browser
// shows NOK"), so syncing them between devices would be wrong. And the money
// formatters (components/CardSorting.tsx, util/format.ts) are pure synchronous
// functions called from render — they can't await IndexedDB. Same pattern as
// useViewMode (components/CardViews.tsx) and the cardSort:* keys.
//
// Deliberately free of React imports: web workers pull this in (via
// cardDb/preferredPrinting.ts) and shouldn't drag React into their bundle. The
// `usePrefs` hook lives in usePrefs.ts.

/** The currency Scryfall prices are read in, and the fallback when conversion is unavailable. */
export type BaseCurrency = 'EUR' | 'USD';

/** Which printing stands in for a card in search results and quick-adds. */
export type PrintingPref = 'latest' | 'latestNonPromo' | 'first' | 'cheapest';

/** What to do when a data feed has an update waiting. */
export type UpdatePolicy = 'ask' | 'always' | 'never';

/**
 * What to do when you file a card that's already filed somewhere else. A card can
 * only be in one place, so 'move' is the physically honest answer — but brewing
 * two decks around the same Sol Ring is a real thing to want, hence 'copy'.
 */
export type FilingPolicy = 'ask' | 'move' | 'copy';

export interface Prefs {
  /** An ECB currency code (see price/rates.ts CURRENCIES). Equal to base = no conversion. */
  displayCurrency: string;
  baseCurrency: BaseCurrency;
  printing: PrintingPref;
  /** Layered on top of `printing`: show the printing you own, whatever the rule says. */
  preferOwnedPrinting: boolean;
  pricesPolicy: UpdatePolicy;
  /** Also governs the sealed-product catalog refresh. */
  cardDbPolicy: UpdatePolicy;
  scanDataPolicy: UpdatePolicy;
  /** Filing a copy that's already filed elsewhere: ask, move it, or file both. */
  filingPolicy: FilingPolicy;
}

// 'ask' across the board: a fresh install downloads nothing the user didn't
// agree to. The update banner's "don't ask again" moves a feed off 'ask'.
const DEFAULTS: Prefs = {
  displayCurrency: 'EUR',
  baseCurrency: 'EUR',
  printing: 'latest',
  preferOwnedPrinting: false,
  pricesPolicy: 'ask',
  cardDbPolicy: 'ask',
  scanDataPolicy: 'ask',
  filingPolicy: 'ask',
};

const STORAGE_KEY = 'prefs';

let cache: Prefs | null = null;
const listeners = new Set<() => void>();

function read(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* unparseable or unavailable storage — defaults are fine */
  }
  return DEFAULTS;
}

/** Current preferences. Synchronous and cached, so formatters can call it per row. */
export function getPrefs(): Prefs {
  return (cache ??= read());
}

export function setPrefs(patch: Partial<Prefs>): void {
  cache = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* quota/private mode — the in-memory value still applies for this session */
  }
  for (const l of listeners) l();
}

/** Subscribe to preference changes; returns an unsubscribe function. */
export function subscribePrefs(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Notify subscribers without changing anything — for state the formatters read
 * but that doesn't live here, notably a freshly downloaded exchange rate.
 */
export function notifyPrefsChanged(): void {
  for (const l of listeners) l();
}
