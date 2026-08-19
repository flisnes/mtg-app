import { useEffect, useState } from 'react';
import { Icon } from './icons.js';
import { oracleSelectionQuery, type OracleSelection } from './oracleSelection.js';

/**
 * Watch for a phrase highlighted inside a rules-text block. Returns the search
 * that phrase would run, or null while nothing useful is selected.
 */
export function useOracleSelection(oracleText: string | null | undefined): OracleSelection | null {
  const [sel, setSel] = useState<OracleSelection | null>(null);
  useEffect(() => {
    if (!oracleText) {
      setSel(null);
      return;
    }
    let clearing: number | undefined;
    const read = () => {
      const next = oracleSelectionQuery(oracleText);
      if (next) {
        window.clearTimeout(clearing);
        clearing = undefined;
        // Same phrase, same object: selectionchange fires on every drag pixel.
        setSel((prev) => (prev?.query === next.query ? prev : next));
        return;
      }
      // Don't drop the chip the instant the selection goes: tapping it collapses
      // the selection first, and an unmounted button never gets its click.
      if (clearing === undefined) {
        clearing = window.setTimeout(() => {
          clearing = undefined;
          setSel(null);
        }, 400);
      }
    };
    document.addEventListener('selectionchange', read);
    return () => {
      document.removeEventListener('selectionchange', read);
      window.clearTimeout(clearing);
    };
  }, [oracleText]);
  return sel;
}

/** Keep the label to one line's worth of phrase. */
function short(text: string): string {
  return text.length > 44 ? `${text.slice(0, 43).trimEnd()}…` : text;
}

/**
 * The offer that follows a highlight: search the whole database for cards whose
 * rules text contains it. In the flow below the text, not floating over it —
 * see oracleSelection.ts for why.
 */
export function OracleSearchChip({
  selection,
  onSearch,
}: {
  selection: OracleSelection;
  onSearch: (query: string) => void;
}) {
  return (
    <button
      type="button"
      className="oracle-search-chip"
      // On desktop, mousedown outside a selection is what collapses it; keep the
      // highlight visible while the click that uses it goes through.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSearch(selection.query)}
    >
      <Icon name="search" size={14} />
      <span>Search rules text for “{short(selection.text)}”</span>
    </button>
  );
}
