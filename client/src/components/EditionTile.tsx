import type { ReactNode } from 'react';
import type { Printing } from '@mtg/shared';
import { SetSymbol } from './SetSymbol.js';

/**
 * One tile of an `.edition-grid`: the printing's art with its badges over it,
 * a set/number caption and a line of small print. The edition picker and the
 * copy picker both use it; they differ only in the badges and what follows.
 */
export function EditionTile({
  printing,
  selected,
  disabled,
  full,
  sheen,
  year,
  badges,
  sub,
  title,
  onClick,
  children,
}: {
  /** undefined when the copy's printing isn't in the card DB. */
  printing: Printing | undefined;
  selected?: boolean;
  disabled?: boolean;
  /** Greys the tile: nothing more of it fits. */
  full?: boolean;
  /** Foil sheen over the art. */
  sheen?: boolean;
  /** Release year after the number. */
  year?: boolean;
  /** Over the art, top corners. */
  badges?: ReactNode;
  sub: ReactNode;
  title?: string;
  onClick: () => void;
  /** After the small print (the copy picker's "where is it" pills). */
  children?: ReactNode;
}) {
  const img = printing?.imageSmall ?? printing?.imageNormal;
  const classes = ['edition-tile'];
  if (selected) classes.push('edition-tile-selected');
  if (full) classes.push('edition-tile-full');
  return (
    <button className={classes.join(' ')} disabled={disabled} title={title} onClick={onClick}>
      <span className="edition-tile-art">
        {img ? (
          <img src={img} alt={printing?.setName ?? ''} loading="lazy" />
        ) : (
          <span className="edition-tile-ph">{printing?.setName ?? 'Unknown set'}</span>
        )}
        {sheen && img && <span className="foil-sheen" aria-hidden />}
        {badges}
      </span>
      <span className="edition-tile-caption">
        {printing ? (
          <>
            <SetSymbol set={printing.set} title={printing.setName} /> {printing.set.toUpperCase()} #
            {printing.collectorNumber}
            {year && ` · ${printing.releasedAt.slice(0, 4)}`}
          </>
        ) : (
          'Unknown edition'
        )}
      </span>
      <span className="edition-tile-sub">{sub}</span>
      {children}
    </button>
  );
}
