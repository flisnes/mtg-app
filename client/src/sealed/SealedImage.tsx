import { useEffect, useState } from 'react';
import { Icon } from '../components/icons.js';

// A sealed product's box shot. The CDN answers 403 (not 404) for a product it
// has no photo of, and plenty of products carry no TCGplayer id at all, so a
// missing image is the normal case rather than an error: fall back to the box
// glyph and say nothing about it.

export function SealedImage({
  url,
  alt,
  className,
}: {
  url: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  // A new product in the same mounted slot must clear the previous failure,
  // otherwise picking a second product after a missing image shows the glyph
  // for one that does have a photo.
  useEffect(() => setFailed(false), [url]);

  const cls = className ? `sealed-shot ${className}` : 'sealed-shot';
  if (!url || failed) {
    return (
      <div className={`${cls} sealed-shot-empty`} role="img" aria-label={alt}>
        <Icon name="sealed" size={28} />
      </div>
    );
  }
  return <img className={cls} src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
