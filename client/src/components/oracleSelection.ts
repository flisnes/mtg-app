// Highlight a phrase in a card's rules text and search the database for it.
//
// There is no web API for the obvious version of this: you cannot add an item to
// iOS's selection callout or Android's floating action bar (those come from
// installed native apps), and you cannot outrank them either — the OS shows its
// menu the moment a selection exists, and `contextmenu` never fires for the
// mobile selection gesture. So we coexist with it: the native menu floats above
// the selection, and our chip sits in the flow right below the rules text, where
// nothing can cover it (not the callout, not Chrome's "tap to see search
// results" bar at the bottom of the viewport).
//
// Two roads not taken. (B) A bubble absolutely positioned at the selection's
// own rect looks slicker but spends its life dodging a native overlay whose
// size and side are unknowable from script. (C) `user-select: none` plus our
// own tap-to-extend word selection would make ours the *only* menu and could
// offer per-keyword targets, at the cost of native copy and a lot more code.
// If this chip proves popular, C is the upgrade.

/**
 * Map a DOM selection back to a `[start, end)` slice of the *raw* oracle text.
 *
 * `SymbolText` stamps `data-oracle-off` on each run of plain text; mana pips in
 * between are empty elements with no text of their own. Taking the endpoints
 * from the text runs and slicing the original string is what puts "{T}" back
 * into a selection that spans it — the browser's own `toString()` cannot.
 * Symbols at the very edge of a selection are left out, which is right: the
 * user dragged from a word.
 */
function rawRange(container: Element, range: Range): [number, number] | null {
  let start = Infinity;
  let end = -Infinity;
  for (const el of container.querySelectorAll<HTMLElement>('[data-oracle-off]')) {
    // Skip runs that lie wholly outside the selection. comparePoint is the only
    // reliable test here: a range that ends at a run's leading edge still
    // "intersects" it, and its endContainer is the parent <p>, not this run.
    try {
      if (range.comparePoint(el, 0) === 1) continue; // run starts after the selection ends
      if (range.comparePoint(el, el.childNodes.length) === -1) continue; // run ends before it starts
    } catch {
      continue; // detached node mid-update
    }
    const off = Number(el.dataset.oracleOff);
    const text = el.firstChild;
    if (!Number.isFinite(off) || !text) continue;
    // Partly-selected runs are clamped; fully-selected ones count whole.
    const from = range.startContainer === text ? range.startOffset : 0;
    const to = range.endContainer === text ? range.endOffset : (text.textContent?.length ?? 0);
    if (to <= from) continue;
    start = Math.min(start, off + from);
    end = Math.max(end, off + to);
  }
  return end > start ? [start, end] : null;
}

export interface OracleSelection {
  /** The selected phrase, for the chip's label. */
  text: string;
  /** The search query it becomes, e.g. `o:"whenever ~ enters"`. */
  query: string;
}

/** Selections this short are stray taps, not phrases worth searching. */
const MIN_CHARS = 3;

/**
 * Swap the card's own name for `~` in a phrase, longest face first so a DFC's
 * "Ajani, Strength of the Pride" isn't half-eaten by an "Ajani" back face.
 *
 * A plain substring swap, no regex: rules text spells the name exactly as
 * printed. The index stores both forms (normOracle and normOracleTilde in
 * querySyntax.ts), so either would still find this card; `~` is what makes the
 * search find *other* cards with the same ability, which is the point of
 * highlighting it.
 */
function tildeName(phrase: string, cardName: string): string {
  const faces = cardName
    .split(' // ')
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let out = phrase;
  for (const face of faces) out = out.split(face).join('~');
  return out;
}

/**
 * Read the current selection as an oracle-text search, or null when there isn't
 * one inside a rules-text block.
 */
export function oracleSelectionQuery(oracleText: string, cardName: string): OracleSelection | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const from = range.startContainer;
  const el = (from.nodeType === Node.ELEMENT_NODE ? from : from.parentNode) as Element | null;
  const container = el?.closest?.('[data-oracle-root]');
  if (!container) return null;

  const span = rawRange(container, range);
  if (!span) return null;
  const raw = oracleText.slice(span[0], span[1]);

  // Two characters can't survive inside one quoted term, so the phrase is cut
  // at each of them and the pieces are ANDed (whitespace means AND):
  //   \n  the index keeps the ability break, so a phrase spanning one would
  //       never match as a single term, and an <input> eats the newline anyway.
  //   "   a quoted term ends at the first quote, and rules text is full of them
  //       ("Artifacts you control have "{2}, Sacrifice this artifact: ..."").
  // Every piece is still a literal substring of the stored text, which is what
  // keeps the match honest.
  const parts = raw
    .split(/["\n]/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= MIN_CHARS);
  if (!parts.length) return null;

  return {
    // The label reads back what was highlighted, quotes and all; only the query
    // gets chopped up and tilde'd.
    text: raw.replace(/\s+/g, ' ').trim(),
    // Highlighting "Whenever Grizzly Bears attacks" searches for
    // o:"whenever ~ attacks", so every card with that trigger comes back, not
    // just this one.
    query: parts.map((part) => `o:"${tildeName(part, cardName)}"`).join(' '),
  };
}
