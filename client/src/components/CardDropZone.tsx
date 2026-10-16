import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dragCarriesCards, readDrop } from '../scan/dropRead.js';
import type { DropBatch } from './DropSheet.js';
import type { ScanTarget } from '../scan/session.js';
import { Icon } from './icons.js';
import { useToast } from './Toast.js';

// Drag a card image onto a page to add it there (desktop). Mount one per page
// with that page's destination; the whole window is the drop target while the
// page is showing. The identifying (matcher, OCR) and the review sheet load
// only once something is dropped.

const DropSheet = lazy(() => import('./DropSheet.js').then((m) => ({ default: m.DropSheet })));

function destination(target: ScanTarget): string {
  switch (target.kind) {
    case 'collection':
      return 'your collection';
    case 'tradelist':
      return 'your tradelist';
    case 'wishlist':
      return 'your wishlist';
    case 'deck':
      return target.deckName ?? 'this deck';
    case 'trade':
      return target.label ?? 'the offer';
  }
}

/** `target` null switches the zone off (another full-screen flow owns the page). */
export function CardDropZone({ target }: { target: ScanTarget | null }) {
  const [over, setOver] = useState(false);
  const [batch, setBatch] = useState<DropBatch | null>(null);
  const toast = useToast();
  const depth = useRef(0);
  // A drag that started inside the app (a card tile's own image) is not a drop
  // of a new card: it would add whatever you happened to pick up.
  const internal = useRef(false);
  const seq = useRef(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!target) return;
    const onStart = () => {
      internal.current = true;
    };
    const onEnd = () => {
      internal.current = false;
    };
    const wanted = (e: DragEvent) => !internal.current && dragCarriesCards(e.dataTransfer);
    const onEnter = (e: DragEvent) => {
      if (!wanted(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (!wanted(e)) return;
      // Without this the browser opens the image in the tab instead.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    // No types check on the way out: an enter that counted must always be
    // matched, or the overlay sticks.
    const onLeave = () => {
      if (internal.current || depth.current === 0) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (internal.current || !e.dataTransfer) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const items = readDrop(e.dataTransfer);
      if (!items.length) {
        toast('No card image in that drop');
        return;
      }
      setBatch({ seq: ++seq.current, items });
    };
    window.addEventListener('dragstart', onStart);
    window.addEventListener('dragend', onEnd);
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragstart', onStart);
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      depth.current = 0;
      setOver(false);
    };
  }, [!!target]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;
  return (
    <>
      {over &&
        createPortal(
          <div className="drop-overlay" aria-hidden="true">
            <div className="drop-overlay-box">
              <Icon name="import" size={36} />
              <span>Drop card images to add them to {destination(target)}</span>
            </div>
          </div>,
          document.body,
        )}
      {batch && (
        <Suspense fallback={null}>
          <DropSheet target={target} batch={batch} onClose={() => setBatch(null)} />
        </Suspense>
      )}
    </>
  );
}
