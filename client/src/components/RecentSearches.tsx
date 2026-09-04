import { useEffect, useMemo, useRef, useState } from 'react';
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
/**
 * The list is deep rather than a top-ten: the dropdown filters it against what
 * you're typing, so a query from three weeks ago is still one substring away.
 */
const MAX = 500;
/** How many matches the dropdown renders. It's a suggestion list, not an archive. */
const SHOWN = 100;
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

/**
 * Past queries worth offering for what's typed so far. Empty input offers the
 * most recent; anything else narrows by substring, since "goblin" should find
 * `t:goblin cmc<=3` as readily as it finds itself. What you've already typed is
 * dropped — suggesting it back is a wasted row.
 */
export function useSearchHistory(query: string): string[] {
  const list = useHistory();
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, SHOWN);
    return list.filter((h) => h.toLowerCase().includes(q) && h.toLowerCase() !== q).slice(0, SHOWN);
  }, [list, query]);
}

/**
 * The history panel that hangs off the search bar. Translucent on purpose: the
 * collection stays visible underneath, so this reads as a passing suggestion
 * rather than a page that replaced your cards.
 *
 * `active` is the arrow-key highlight (-1 = none, the typed text stands). The
 * mousedown guard is what keeps the input focused through a click, so keyboard
 * and mouse can be mixed without the panel closing under the cursor.
 */
export function SearchHistoryDropdown({
  list,
  active,
  onPick,
  onHover,
}: {
  list: string[];
  active: number;
  onPick: (query: string) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="search-history" onMouseDown={(e) => e.preventDefault()}>
      <ul className="search-history-list" ref={listRef} role="listbox" aria-label="Recent searches">
        {list.map((q, i) => (
          <li key={q} className={i === active ? 'is-active' : undefined}>
            <button
              className="search-history-item"
              role="option"
              aria-selected={i === active}
              onClick={() => onPick(q)}
              onMouseEnter={() => onHover(i)}
              title={`Search ${q} again`}
            >
              <Icon name="history" size={14} />
              <span className="search-history-q">{q}</span>
            </button>
            <button
              className="search-history-forget"
              onClick={() => forgetSearch(q)}
              aria-label={`Forget ${q}`}
              title="Forget this search"
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="search-history-foot">
        <button onClick={clearSearchHistory}>Clear history</button>
      </div>
    </div>
  );
}

/**
 * The same panel, for completions rather than history: no per-row forget and no
 * clear-all, because nothing here is the user's to delete. Used while an
 * `otag:` term is being typed, where the vocabulary is far more useful than
 * what you searched for last week.
 */
export function SearchSuggestDropdown({
  list,
  active,
  onPick,
  onHover,
  label,
}: {
  list: string[];
  active: number;
  onPick: (value: string) => void;
  onHover: (index: number) => void;
  label: string;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="search-history" onMouseDown={(e) => e.preventDefault()}>
      <ul className="search-history-list" ref={listRef} role="listbox" aria-label={label}>
        {list.map((value, i) => (
          <li key={value} className={i === active ? 'is-active' : undefined}>
            <button
              className="search-history-item"
              role="option"
              aria-selected={i === active}
              onClick={() => onPick(value)}
              onMouseEnter={() => onHover(i)}
              title={value}
            >
              <Icon name="tags" size={14} />
              <span className="search-history-q">{value}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
