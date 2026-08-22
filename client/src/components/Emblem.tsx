import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerEmblem, ContainerKind, ProfileAvatar } from '@mtg/shared';
import { getPrinting } from '../db/queries.js';
import { CONTAINER_META } from '../deck/containers.js';
import { CroppedArt, artCropUrl } from './Avatar.js';
import { EMBLEM_MANA_PIPS, EMBLEM_SYMBOL_LABELS } from './emblemSymbols.js';
import { Icon } from './icons.js';
import { SetSymbol } from './SetSymbol.js';

// What a deck, binder or box wears in the list: a crop of a card's art, a
// symbol from the Mana font, or a set symbol from Keyrune. Same trick as the
// profile picture — the row stores a recipe, and whichever device is looking
// resolves the printing out of its own card DB. No emblem (or one this build
// can't resolve) falls back to the container's kind icon, so a row always has
// something in front of its name.

/** A symbol the current build doesn't offer renders nothing; don't try. */
function knownSymbol(sym: string): boolean {
  return EMBLEM_SYMBOL_LABELS.has(sym);
}

function KindIcon({ kind }: { kind: ContainerKind }) {
  return <Icon name={CONTAINER_META[kind].icon} />;
}

function EmblemArt({ art, kind, size }: { art: ProfileAvatar; kind: ContainerKind; size: number }) {
  const [failed, setFailed] = useState(false);
  const printing = useLiveQuery(() => getPrinting(art.scryfallId), [art.scryfallId]);
  const src = artCropUrl(printing?.imageNormal);
  // Missing locally (a printing the card DB dropped, or a sync that arrived
  // before the card DB did) or a dead image: wear the kind icon instead.
  if (!src || failed) return <KindIcon kind={kind} />;
  return (
    <span className="emblem emblem-art" style={{ width: size, height: size }}>
      <CroppedArt src={src} crop={art} size={size} onError={() => setFailed(true)} />
    </span>
  );
}

/**
 * The emblem, sized to a square box. Decorative: the container's name is always
 * right next to it, so nothing here is announced.
 */
export function Emblem({
  emblem,
  kind,
  size = 24,
}: {
  emblem?: ContainerEmblem;
  kind: ContainerKind;
  size?: number;
}) {
  if (emblem?.type === 'art') return <EmblemArt art={emblem.art} kind={kind} size={size} />;

  if (emblem?.type === 'symbol' && knownSymbol(emblem.symbol)) {
    // Mana wants the font's coloured pip; everything else is a glyph in the
    // current text colour. The pip is 1.3em wide, so it gets the smaller font
    // size to end up the same box as a plain glyph.
    const pip = EMBLEM_MANA_PIPS.has(emblem.symbol);
    return (
      <span className="emblem" style={{ width: size, height: size, fontSize: pip ? size * 0.72 : size * 0.95 }}>
        <i className={pip ? `ms ms-${emblem.symbol} ms-cost` : `ms ms-${emblem.symbol}`} aria-hidden />
      </span>
    );
  }

  if (emblem?.type === 'set') {
    return (
      <span className="emblem" style={{ width: size, height: size, fontSize: size * 0.95 }}>
        <SetSymbol set={emblem.set} />
      </span>
    );
  }

  return <KindIcon kind={kind} />;
}
