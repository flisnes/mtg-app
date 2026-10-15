import { getSetIndex, type SetInfo } from './search.js';

// Completions for a half-typed `set:` term, the same idea as the `otag:` ones
// in oracleTags.ts. Nobody remembers that Jurassic World Collection is `rex` or
// that Innistrad Remastered is `inr`, and nothing else in the app would ever
// tell them — so the dropdown offers the code with the set's full name beside it.
//
// The vocabulary comes free: search.ts already reads every printing to build its
// index, and the printings table is the only place a set's name lives.

let index: SetInfo[] | null = null;
let inFlight: Promise<void> | null = null;

/** Bumps on every load and every invalidation; useSetIndex re-renders on it. */
let generation = 0;
const listeners = new Set<() => void>();

function bump(): void {
  generation++;
  for (const l of listeners) l();
}

export function setIndexGeneration(): number {
  return generation;
}

export function subscribeSetIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Load the set list so `setCompletions` can answer synchronously. A no-op once loaded. */
export function loadSetIndex(): Promise<void> {
  if (index) return Promise.resolve();
  if (!inFlight) {
    const started = generation;
    inFlight = getSetIndex()
      .then((sets) => {
        // Dropped mid-load by a card-data import: this list is already stale,
        // and the bump below sends the hooks back for the new one.
        if (generation !== started) return;
        index = sets;
        bump();
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Forget the set list after a card-DB re-import, so a new set shows up without
 * a reload. Lazy: the next `set:` typed (or the next search) rebuilds it.
 */
export function invalidateSetIndex(): void {
  index = null;
  bump();
}

/** The `set:` fragment being typed at the end of the query, if there is one. */
export const SET_TAIL = /(?:^|[\s(])-?(?:set|s|e|edition)[:=]([a-z0-9]*)$/i;

/** How many sets the dropdown offers. Newest first, so the top of the list is the useful end. */
const MAX_COMPLETIONS = 40;

export interface SetCompletions {
  /** Query text up to and including `set:` — prepend to a code to complete it. */
  head: string;
  sets: SetInfo[];
}

/**
 * Sets worth offering for a half-typed `set:` term. The code you typed wins,
 * then sets whose name starts with it (typing "bloom" should find `blb`), then
 * anything that merely contains it.
 *
 * What breaks the tie depends on whether anything is typed yet. With a fragment,
 * the biggest set wins: "dominar" should offer Dominaria and Dominaria United
 * before their token sheets, art series and promo strays, and card count is what
 * tells a real release from its satellites. With nothing typed the list is a
 * "what's out?" browse, so the newest sets come first instead.
 *
 * A code typed in full is dropped, the way the tag completions drop an exact
 * slug — the dropdown's job is done, and it should get out of the results' way.
 */
export function setCompletions(query: string): SetCompletions | null {
  if (!index) return null;
  const m = SET_TAIL.exec(query);
  if (!m) return null;
  const partial = m[1]!.toLowerCase();
  const head = query.slice(0, query.length - partial.length);

  const scored: Array<{ set: SetInfo; rank: number }> = [];
  for (const set of index) {
    if (set.code === partial) continue;
    if (!partial) {
      scored.push({ set, rank: 0 });
      continue;
    }
    const name = set.name.toLowerCase();
    if (set.code.startsWith(partial)) scored.push({ set, rank: 0 });
    else if (name.startsWith(partial) || name.includes(` ${partial}`)) scored.push({ set, rank: 1 });
    else if (name.includes(partial)) scored.push({ set, rank: 2 });
    else if (set.code.includes(partial)) scored.push({ set, rank: 3 });
  }
  const newest = (a: SetInfo, b: SetInfo) => (a.releasedAt === b.releasedAt ? 0 : a.releasedAt > b.releasedAt ? -1 : 1);
  const biggest = (a: SetInfo, b: SetInfo) => b.count - a.count;
  const tie = partial ? biggest : newest;
  scored.sort((a, b) => a.rank - b.rank || tie(a.set, b.set) || (a.set.code < b.set.code ? -1 : 1));
  return { head, sets: scored.slice(0, MAX_COMPLETIONS).map((s) => s.set) };
}
