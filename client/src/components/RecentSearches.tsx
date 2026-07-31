import { useEffect, useState } from 'react';
import { Icon } from './icons.js';

// Recent card searches, offered the moment the search bar is focused.
//
// Deck building is a loop: search, look at the deck, search again. The overlay
// drops the query when it closes (deliberately — reopening it on another page
// shouldn't resurrect the old one), and a hand-typed
// `t:goblin o:"draw a card" cmc<=3` died with it. So we stash the query on the
// way out and hand it back one tap later.
//
// Device-shaped and synchronous, so localStorage rather than the synced
// `settings` table — same pattern as useViewMode (components/CardViews.tsx).

const KEY = 'searchHistory';
/** Every stored query is shown, so this is also the length of the list. */
const MAX = 10;
/** A single character is a slip of the finger, not a search worth keeping. */
const MIN_LENGTH = 2;

let cache: string[] | null = null;
const listeners = new Set<(h: string[]) => void>();

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      return parsed.filter((q): q is string => typeof q === 'string' && !!q.trim()).slice(0, MAX);
    }
  } catch {
    /* unparseable or unavailable storage — an empty history is fine */
  }
  return [];
}

function history(): string[] {
  return (cache ??= read());
}

function write(next: string[]): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota/private mode — the in-memory list still serves this session */
  }
  for (const l of listeners) l(next);
}

/**
 * Remember a query the user actually used. Call this when a search *ends* — the
 * overlay closes, Enter is pressed, navigation drops it — never per keystroke,
 * or the list fills up with every prefix of the word "lightning".
 */
export function recordSearch(query: string): void {
  const q = query.trim();
  if (q.length < MIN_LENGTH) return;
  const rest = history().filter((h) => h.toLowerCase() !== q.toLowerCase());
  // A query that extends the previous one is the same search, refined: coming
  // back to "t:goblin" and adding "cmc<=3" should leave one entry, not two.
  const refines = rest[0] && q.toLowerCase().startsWith(rest[0].toLowerCase());
  write([q, ...rest.slice(refines ? 1 : 0)].slice(0, MAX));
}

export function forgetSearch(query: string): void {
  write(history().filter((h) => h !== query));
}

export function clearSearchHistory(): void {
  write([]);
}

/** Shared across mounted instances, so recording updates a visible panel. */
function useHistory(): string[] {
  const [list, setList] = useState<string[]>(history);
  useEffect(() => {
    listeners.add(setList);
    setList(history()); // catch a record between first render and subscribe
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/** The recent-search list. Renders nothing until there's something to offer. */
export function RecentSearches({ onPick }: { onPick: (query: string) => void }) {
  const list = useHistory();
  if (!list.length) return null;
  return (
    <section className="recent-searches">
      <div className="recent-searches-head">
        <h3>Recent searches</h3>
        <button className="chip" onClick={clearSearchHistory}>
          Clear
        </button>
      </div>
      <ul className="recent-search-list">
        {list.map((q) => (
          <li key={q}>
            <button className="recent-search" onClick={() => onPick(q)} title={`Search ${q} again`}>
              <Icon name="history" size={14} />
              <span className="recent-search-q">{q}</span>
            </button>
            <button
              className="recent-search-forget"
              onClick={() => forgetSearch(q)}
              aria-label={`Forget ${q}`}
              title="Forget this search"
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
