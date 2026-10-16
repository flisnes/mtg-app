import { useState } from 'react';
import type { OracleCard, Printing } from '@mtg/shared';
import { Icon } from '../icons.js';
import { Sheet } from '../Sheet.js';

/**
 * The card's art beside the sheet's info column, with the flip button for a
 * double-faced card and the tap-to-enlarge zoom.
 *
 * Two bits of state belong to one printing only: which face is up (another
 * edition may not be double-faced at all) and whether its image failed to load.
 * Both remember *which* printing or image they're about and read as off for any
 * other, so switching editions resets them without an effect, and without
 * remounting the <img> (which would blank the frame between editions).
 */
export function CardArt({
  oracleCard,
  facePrinting,
  scryfallId,
  editionResolved,
  foil,
  zoomed,
  onZoom,
  onUnzoom,
}: {
  oracleCard: OracleCard;
  /** The printing whose art shows (for "any printing", the preferred one). */
  facePrinting: Printing | undefined;
  /** The edition picked; the flip resets when it changes. */
  scryfallId: string;
  /** The edition is known: until then the frame holds its space, empty. */
  editionResolved: boolean;
  foil: boolean;
  zoomed: boolean;
  onZoom: () => void;
  onUnzoom: () => void;
}) {
  const cardImage =
    facePrinting?.imageNormal ?? oracleCard.imageNormal ?? facePrinting?.imageSmall ?? oracleCard.imageSmall ?? null;
  // Back face for double-faced cards (transform / modal DFC / …); absent for single-faced ones.
  const cardBackImage =
    facePrinting?.imageBackNormal ??
    oracleCard.imageBackNormal ??
    facePrinting?.imageBackSmall ??
    oracleCard.imageBackSmall ??
    null;
  const [flippedFor, setFlippedFor] = useState<string | null>(null);
  const flipped = flippedFor === scryfallId;
  const flip = () => setFlippedFor((f) => (f === scryfallId ? null : scryfallId));
  const shownImage = flipped && cardBackImage ? cardBackImage : cardImage;
  // The first paint of the art waits for the browser to actually decode it —
  // the foil sheen has nothing to shimmer over until then. A latch, not a
  // per-image flag: once the sheet has shown a card, switching editions swaps
  // the art in place instead of blanking the frame.
  const [artShown, setArtShown] = useState(false);
  // The right printing's image didn't load: fall back to the card's default art
  // rather than an empty frame (a wrong edition beats no card at all).
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const artFailed = !!shownImage && failedSrc === shownImage;
  const fallbackImage = oracleCard.imageNormal ?? oracleCard.imageSmall ?? null;
  const artSrc = (artFailed && fallbackImage) || shownImage || cardImage;

  if (!cardImage && editionResolved) return <div className="sheet-card sheet-card-ph">{oracleCard.name}</div>;
  return (
    // The wrap holds the card's space from the first frame; what goes in it
    // waits until we know the edition and the image has decoded.
    <div className="sheet-card-wrap">
      {editionResolved && artSrc && (
        <button
          type="button"
          className="sheet-card-zoom"
          onClick={() => artShown && onZoom()}
          aria-label={`Enlarge ${oracleCard.name}`}
          title="Enlarge"
        >
          <img
            className={artShown ? 'sheet-card' : 'sheet-card sheet-card-loading'}
            src={artSrc}
            alt={oracleCard.name}
            onLoad={() => setArtShown(true)}
            onError={() => {
              if (!artFailed && fallbackImage && fallbackImage !== artSrc) setFailedSrc(shownImage);
              else setArtShown(true);
            }}
          />
        </button>
      )}
      {artShown && foil && <span className="foil-sheen" aria-hidden />}
      {artShown && cardBackImage && (
        <button type="button" className="sheet-flip" onClick={flip} aria-label="Flip card" title="Flip card">
          <Icon name="flip" size={16} />
        </button>
      )}
      {zoomed && cardImage && (
        <CardZoom
          image={shownImage ?? cardImage}
          backImage={cardBackImage}
          onFlip={flip}
          alt={oracleCard.name}
          foil={foil}
          onClose={onUnzoom}
        />
      )}
    </div>
  );
}

/**
 * The card, alone, as big as the screen allows — for when the oracle text on
 * the sheet's thumbnail is too small to actually read. Tap anywhere (or
 * Escape / back) to dismiss; the flip button stays, and shares the sheet's flip
 * state so the face you were looking at is the face you get.
 */
function CardZoom({
  image,
  backImage,
  onFlip,
  alt,
  foil,
  onClose,
}: {
  image: string;
  backImage: string | null;
  onFlip: () => void;
  alt: string;
  foil: boolean;
  onClose: () => void;
}) {
  // Through Sheet like every other overlay, so the tap that opened it can't
  // also close it (the tap guard) and Escape/back peel it off first.
  return (
    <Sheet onClose={onClose} label={alt} className="card-zoom" backdropClassName="card-zoom-backdrop">
      {/* Tap anywhere to dismiss, the card included. */}
      <div className="card-zoom-tap" onClick={onClose}>
        <div className="card-zoom-frame">
          <img className="card-zoom-img" src={image} alt={alt} />
          {foil && <span className="foil-sheen" aria-hidden />}
          {backImage && (
            <button
              type="button"
              className="sheet-flip card-zoom-flip"
              onClick={(e) => {
                e.stopPropagation();
                onFlip();
              }}
              aria-label="Flip card"
              title="Flip card"
            >
              <Icon name="flip" size={18} />
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
