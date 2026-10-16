import { useEffect, useMemo, useState } from 'react';
import { mentionsOtag, otagCompletions } from '../cardDb/oracleTags.js';
import { SET_TAIL, setCompletions } from '../cardDb/setIndex.js';
import { useSetIndex } from '../cardDb/useSetIndex.js';
import { useOracleTags } from '../cardDb/useOracleTags.js';
import {
  SearchHistoryDropdown,
  SearchSuggestDropdown,
  recordSearch,
  useSearchHistory,
  type SuggestItem,
} from '../components/RecentSearches.js';
import { useShortcuts } from '../components/useShortcuts.js';
import { useDismiss } from '../components/useDismiss.js';
import { Icon, type IconName } from '../components/icons.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { NotificationBell } from '../components/NotificationBell.js';
import { useAccount } from '../account/useAccount.js';
import { useSearchCtx } from './searchContext.js';
import { SearchOverlay } from './SearchOverlay.js';

/**
 * Ctrl+K (Cmd+K) puts the cursor in the search box from anywhere in the app.
 * Its own component so the binding sits inside the provider without giving the
 * header a hook that re-registers on every keystroke you type into it.
 */
function SearchHotkey({ onOpen }: { onOpen: () => void }) {
  useShortcuts({ 'mod+k': onOpen }, { whileOverlay: true });
  // '/' is a plain character, so unlike Ctrl+K it stays out of the way of
  // anything already on top and of anywhere you might be typing one.
  useShortcuts({ '/': onOpen });
  return null;
}

/** The header search bar + results overlay. Render once, inside the provider. */
export function GlobalSearchBar() {
  const { open, setOpen, inputRef, query, setQuery, openWith, reset } = useSearchCtx();
  const { enabled: accountsEnabled, session } = useAccount();

  // Escape and the back button dismiss the overlay through the shared stack, so
  // a sheet opened from a search result closes before the search itself does.
  useDismiss(open ? reset : null);

  // Past searches hang under the bar the way a browser's address bar does:
  // open while the input has focus, narrowed by what's typed, walked with the
  // arrow keys. `active` is -1 until an arrow key moves it, so Enter keeps
  // meaning "commit what I typed" for anyone who never touches the list.
  const [histOpen, setHistOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // Mid-`otag:` or mid-`set:` the vocabulary displaces the history: four
  // thousand tag slugs and nine hundred set codes are undiscoverable otherwise,
  // and old searches are no help in choosing one.
  // Both load only once such a term is being typed: the set list costs a read
  // of every card and printing, which a launch should not pay up front.
  const tagsVersion = useOracleTags(mentionsOtag(query));
  const setsVersion = useSetIndex(SET_TAIL.test(query));
  const otag = useMemo(() => otagCompletions(query), [query, tagsVersion]);
  const sets = useMemo(() => setCompletions(query), [query, setsVersion]);
  const history = useSearchHistory(query);
  const suggest: { head: string; items: SuggestItem[]; label: string; icon: IconName } | null = otag?.slugs.length
    ? { head: otag.head, items: otag.slugs.map((value) => ({ value })), label: 'Oracle tags', icon: 'tags' }
    : sets?.sets.length
      ? {
          head: sets.head,
          items: sets.sets.map((s) => ({ value: s.code, hint: s.name })),
          label: 'Sets',
          icon: 'sealed',
        }
      : null;
  const matches = suggest ? suggest.items.map((i) => i.value) : history;
  const showHistory = histOpen && matches.length > 0;
  useEffect(() => setActive(-1), [query]);

  // Picking only fills the query: results update live, and the search is
  // recorded (and so moves to the top) when it ends, like any other. A tag or
  // set code completes the term in place and leaves a trailing space, so the
  // next term can be typed straight on; a history entry replaces the whole query.
  function pickHistory(value: string) {
    setQuery(suggest ? `${suggest.head}${value} ` : value);
    setHistOpen(false);
  }

  return (
    <>
      <header className="app-header">
        <SearchHotkey onOpen={() => openWith({ focus: 'select' })} />
        <div className="search-bar-wrap">
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            placeholder='Search cards… (bolt, t:goblin, o:"draw a card")'
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHistOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              setHistOpen(true);
            }}
            onBlur={() => setHistOpen(false)}
            // Results update live; Enter just dismisses the (mobile) keyboard
            // so it stops covering them. The overlay stays open. It does count as
            // committing the query though, so the recent list gets it now rather
            // than only if the search is closed cleanly. With a suggestion
            // highlighted, Enter takes that instead and the keyboard stays up.
            onKeyDown={(e) => {
              if (showHistory && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setActive((i) => Math.max(-1, Math.min(matches.length - 1, i + step)));
                return;
              }
              if (e.key !== 'Enter') return;
              if (showHistory && active >= 0) {
                e.preventDefault();
                pickHistory(matches[active]!);
                return;
              }
              recordSearch(query);
              setHistOpen(false);
              e.currentTarget.blur();
            }}
            enterKeyHint="search"
            aria-label="Search cards"
          />
          {showHistory && suggest && (
            <SearchSuggestDropdown
              list={suggest.items}
              active={active}
              onPick={pickHistory}
              onHover={setActive}
              label={suggest.label}
              icon={suggest.icon}
            />
          )}
        </div>
        {open ? (
          <button className="header-close" onClick={reset} aria-label="Close search" title="Close search">
            <Icon name="close" size={18} />
          </button>
        ) : (
          // The bell also carries local filing conflicts, so it isn't gated on
          // accounts being switched on at all: it hides itself when there's
          // genuinely nothing to report.
          <>
            <NotificationBell signedIn={accountsEnabled && !!session} />
            {accountsEnabled && <AccountMenu />}
          </>
        )}
      </header>
      {/* Recent searches sit in the overlay under the scope chips, not hanging
          off the bar: hanging there they covered the chips. Completions stay a
          dropdown, since they finish the term being typed. With the input
          blurred and nothing typed, the same list fills the empty overlay. */}
      {open && (
        <SearchOverlay
          history={
            showHistory && !suggest ? (
              <SearchHistoryDropdown list={matches} active={active} onPick={pickHistory} onHover={setActive} />
            ) : null
          }
          recent={
            !query.trim() && history.length > 0 ? (
              <div className="search-recent">
                <h3 className="search-recent-head">Recent searches</h3>
                <SearchHistoryDropdown list={history} active={-1} onPick={pickHistory} onHover={() => {}} />
              </div>
            ) : null
          }
        />
      )}
    </>
  );
}
