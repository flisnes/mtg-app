import { Suspense, lazy } from 'react';
import type { ScanTarget } from './ScanSheet.js';

// The scanner (camera plumbing, OCR, matcher, its whole import graph) is the
// heaviest sheet in the app, and it only ever mounts when someone taps Scan.
// Lazy keeps it out of the chunk every phone downloads; the type-only import
// above is erased at build time. Call sites import ScanSheet from here.
const Sheet = lazy(() => import('./ScanSheet.js').then((m) => ({ default: m.ScanSheet })));

export function ScanSheet(props: { target?: ScanTarget; onClose: () => void }) {
  // fallback null: the camera itself takes longer to warm up than the chunk
  // takes to arrive, so a spinner here would just flicker.
  return (
    <Suspense fallback={null}>
      <Sheet {...props} />
    </Suspense>
  );
}
