import { useEffect, useRef, useState } from 'react';
import { filterScanIndex, parseHashBlob, type ScanIndex } from '../../scan/blob.js';
import { getScanExcludedIds } from '../../scan/exclusions.js';
import { checkScanDataUpdate, downloadScanData, getUsableScanData, type ScanDataManifest } from '../../scan/store.js';
import { getPrefs } from '../../prefs.js';

export type ScanStage =
  | { kind: 'setup'; message: string; download?: ScanDataManifest }
  | { kind: 'downloading'; progress: string }
  | { kind: 'scanning' };

/** Parse the blob and drop printings the camera must never suggest. */
const buildIndex = async (blob: ArrayBuffer): Promise<ScanIndex> => filterScanIndex(parseHashBlob(blob), await getScanExcludedIds());

/**
 * Scan data must be installed before the camera is useful. Hands the index to
 * `onReady` once it is, which returns false when it couldn't start a camera
 * (the stage then stays where it was).
 */
export function useScanData(onReady: (index: ScanIndex) => boolean) {
  const [stage, setStage] = useState<ScanStage>({ kind: 'setup', message: 'Checking scan data…' });
  // A newer card-art index is published and the user hasn't said whether we may
  // fetch it. Scanning carries on meanwhile with the copy already installed.
  const [refreshOffer, setRefreshOffer] = useState<ScanDataManifest | null>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  // The sheet may close while a download or index build is in flight; nothing
  // may build a camera after that (it would acquire the stream and leak it).
  const closedRef = useRef(false);

  const start = (index: ScanIndex) => {
    if (closedRef.current) return;
    if (readyRef.current(index)) setStage({ kind: 'scanning' });
  };

  useEffect(() => {
    let cancelled = false;
    // StrictMode runs this effect twice (mount → cleanup → mount) on the same
    // instance, and the cleanup latches closedRef — without clearing it the
    // second pass would refuse to build a camera and dev never scans anything.
    closedRef.current = false;
    void (async () => {
      const installed = await getUsableScanData();
      if (cancelled) return;
      if (installed) {
        const index = await buildIndex(installed.blob);
        if (cancelled) return;
        start(index);
        // Scan immediately on the installed index, but check the beacon in the
        // background: the scanjob keeps publishing newer versions, and without
        // this a device runs on its first download forever. The fresh blob is
        // installed for the next scan session (no disruptive mid-scan swap) —
        // and only with the user's say-so, since it's a few MB.
        const policy = getPrefs().scanDataPolicy;
        if (policy === 'never') return;
        void checkScanDataUpdate()
          .then((u) => {
            if (cancelled || u.kind !== 'update') return;
            if (policy === 'always') return void downloadScanData(u.manifest);
            setRefreshOffer(u.manifest);
          })
          .catch(() => {});
        return;
      }
      const update = await checkScanDataUpdate();
      if (cancelled) return;
      if (update.kind === 'update') {
        setStage({ kind: 'setup', message: 'Scanning needs a one-time download of the card-art index.', download: update.manifest });
      } else {
        setStage({ kind: 'setup', message: 'Card scanning is not available right now (no scan data on the server).' });
      }
    })();
    return () => {
      cancelled = true;
      closedRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async (manifest: ScanDataManifest) => {
    setStage({ kind: 'downloading', progress: `Downloading ${(manifest.bytes / 1e6).toFixed(1)} MB…` });
    try {
      const row = await downloadScanData(manifest);
      start(await buildIndex(row.blob));
    } catch (e) {
      setStage({ kind: 'setup', message: `Download failed: ${(e as Error).message}` });
    }
  };

  return { stage, refreshOffer, dismissOffer: () => setRefreshOffer(null), download };
}
