import { useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { ProfileAvatar } from '@mtg/shared';
import { getPrinting } from '../db/queries.js';

// Circular profile picture cropped from a card's art. The stored avatar is a
// recipe ({scryfallId, x, y, zoom}), so rendering resolves the printing from
// the viewer's own card DB and positions the art inside a round mask — no
// pixels ever travel through the server.

/**
 * Scryfall serves every printing's cropped artwork at the same CDN path as the
 * full card image, just under /art_crop/ instead of /normal/ — derive it
 * rather than shipping another URL through the card DB.
 */
export function artCropUrl(imageNormal: string | null | undefined): string | null {
  if (!imageNormal) return null;
  return imageNormal.includes('/normal/') ? imageNormal.replace('/normal/', '/art_crop/') : null;
}

/**
 * Where the art image sits inside a circle of `size` px: the circle shows a
 * square window of min(natW, natH)/zoom source pixels centered on (x, y).
 */
export function cropLayout(
  natW: number,
  natH: number,
  crop: Pick<ProfileAvatar, 'x' | 'y' | 'zoom'>,
  size: number,
): { width: number; height: number; left: number; top: number } {
  const scale = (size * crop.zoom) / Math.min(natW, natH);
  return {
    width: natW * scale,
    height: natH * scale,
    left: size / 2 - crop.x * natW * scale,
    top: size / 2 - crop.y * natH * scale,
  };
}

/** Clamp a crop center so the visible circle never leaves the art. */
export function clampCropCenter(
  natW: number,
  natH: number,
  zoom: number,
  x: number,
  y: number,
): { x: number; y: number } {
  const short = Math.min(natW, natH);
  const hx = Math.min(0.5, short / (2 * zoom * natW));
  const hy = Math.min(0.5, short / (2 * zoom * natH));
  return {
    x: Math.min(1 - hx, Math.max(hx, x)),
    y: Math.min(1 - hy, Math.max(hy, y)),
  };
}

/** The positioned art inside a round mask; parent supplies the sized circle. */
export function CroppedArt({
  src,
  crop,
  size,
  onError,
}: {
  src: string;
  crop: Pick<ProfileAvatar, 'x' | 'y' | 'zoom'>;
  size: number;
  onError?: () => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const style: CSSProperties = dims
    ? { position: 'absolute', maxWidth: 'none', ...cropLayout(dims.w, dims.h, crop, size) }
    : { visibility: 'hidden' };
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      style={style}
      onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      onError={onError}
    />
  );
}

/** Deterministic hue per username, so fallback initials get stable colors. */
function usernameHue(username: string): number {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Avatar({
  avatar,
  username,
  size = 40,
}: {
  avatar?: ProfileAvatar | null;
  username: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const printing = useLiveQuery(
    () => (avatar ? getPrinting(avatar.scryfallId) : Promise.resolve(undefined)),
    [avatar?.scryfallId],
  );
  const src = artCropUrl(printing?.imageNormal);

  // Fallback (no avatar set, printing missing locally, image failed): initial
  // on a per-user color, so the community list still reads at a glance.
  if (!avatar || !src || failed) {
    return (
      <span
        className="avatar avatar-fallback"
        style={{ width: size, height: size, fontSize: size * 0.45, background: `hsl(${usernameHue(username)} 45% 42%)` }}
        aria-hidden
      >
        {username.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden>
      <CroppedArt src={src} crop={avatar} size={size} onError={() => setFailed(true)} />
    </span>
  );
}
