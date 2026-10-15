// Renders a Magic set's symbol from the bundled Keyrune icon font (see
// src/vendor/keyrune). Keyrune keys glyphs by lowercase set code, which matches
// Scryfall's `set` field; unknown/too-new codes fall back to a generic glyph
// (the `.ss::before` rule). The font loads with `font-display: block`: under
// `swap` the private-use codepoint drew as a hollow box until the woff2 arrived,
// which is what the first visit to Spoilers showed. Rendered in the current text color — no rarity
// coloring. Decorative by default (the set name is shown as adjacent text);
// pass `label` when the symbol stands alone and needs to be announced.

export function SetSymbol({
  set,
  label,
  title,
  className,
}: {
  /** Scryfall set code, e.g. "sth". */
  set: string;
  /** Accessible name; when omitted the symbol is aria-hidden (decorative). */
  label?: string;
  /** Native tooltip on hover. */
  title?: string;
  className?: string;
}) {
  const cls = `ss ss-${set.toLowerCase()}${className ? ` ${className}` : ''}`;
  return label ? (
    <i className={cls} role="img" aria-label={label} title={title ?? label} />
  ) : (
    <i className={cls} aria-hidden title={title} />
  );
}
