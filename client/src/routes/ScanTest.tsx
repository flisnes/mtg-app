import { useEffect, useRef, useState } from 'react';
import type { Priced, Printing, OracleCard } from '@mtg/shared';
import { Page } from './Page.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { SCAN_DATA_BASE } from '../scan/config.js';
import { parseHashBlob, type ScanIndex } from '../scan/blob.js';
import { formatHash64, type DHash } from '../scan/hash.js';
import type { MatchResult, ScanCandidate } from '../scan/match.js';
import { orientQuadPortrait, type Quad } from '../scan/geometry.js';
import { runScanPipeline, type ScanPipelineResult } from '../scan/pipeline.js';
import { CameraScan, type LiveScanState } from '../scan/camera.js';
import { resolveWithOcr, type OcrResolution } from '../scan/ocr.js';
import {
  checkScanDataUpdate,
  downloadScanData,
  getInstalledScanData,
  installScanBlob,
  type ScanDataRow,
} from '../scan/store.js';

// Dev test harness for the scanning pipeline (handover §S2) — the regression
// suite for the whole feature. Not linked from the nav; open #/scan-test.
// Upload a card photo → quad detection (tap 4 corners to override) → warp →
// art crop → dHash → Hamming search → candidates joined against the card DB.

const PHOTO_MAX_DIM = 1600; // cap uploaded photos (12MP ImageData is ~48 MB)
const DETECT_WIDTH = 480;

interface RunResult {
  quad: Quad | null; // null = detection failed, full frame used
  manual: boolean;
  source: 'photo' | 'camera';
  variant: number; // winning size variant (inner-frame growth / sleeve shrink)
  flipped: boolean; // best match came from the 180°-rotated warp
  hash: DHash;
  match: MatchResult;
  timings: { detect: number; match: number };
}

interface JoinedCandidate {
  cand: ScanCandidate;
  printing?: Priced<Printing>;
  oracle?: Priced<OracleCard>;
}

export function ScanTest() {
  const [installed, setInstalled] = useState<ScanDataRow | null>(null);
  const [index, setIndex] = useState<ScanIndex | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [joined, setJoined] = useState<JoinedCandidate[]>([]);
  const [ocr, setOcr] = useState<OcrResolution | string | null>(null);
  const [corners, setCorners] = useState<{ x: number; y: number }[]>([]);

  const photoRef = useRef<HTMLCanvasElement>(null); // full-res working image
  const previewRef = useRef<HTMLCanvasElement>(null); // photo + quad overlay
  const warpedRef = useRef<HTMLCanvasElement>(null);
  const artRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraScan | null>(null);
  const [live, setLive] = useState<LiveScanState | null>(null);

  useEffect(() => {
    void getInstalledScanData().then((row) => {
      if (!row) return;
      setInstalled(row);
      setIndex(parseHashBlob(row.blob));
    });
    return () => cameraRef.current?.stop();
  }, []);

  const setData = (row: ScanDataRow) => {
    setInstalled(row);
    setIndex(parseHashBlob(row.blob));
  };

  const checkServer = async () => {
    setBusy(true);
    setStatus('Checking scan-data beacon…');
    try {
      const update = await checkScanDataUpdate();
      if (update.kind === 'none') {
        setStatus(installed ? 'Scan data is up to date.' : 'No update available (endpoint unreachable or nothing installed).');
      } else {
        setStatus(`Downloading v${update.manifest.version} (${(update.manifest.bytes / 1e6).toFixed(1)} MB)…`);
        setData(await downloadScanData(update.manifest));
        setStatus(`Installed scan data v${update.manifest.version}.`);
      }
    } catch (e) {
      setStatus(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const loadBlobFile = async (file: File) => {
    setBusy(true);
    try {
      setData(await installScanBlob(await file.arrayBuffer(), 0));
      setStatus(`Loaded ${file.name} from file (installed as v0).`);
    } catch (e) {
      setStatus(`Blob rejected: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Draw the working photo + quad overlay + any manual corners. */
  const drawPreview = (quad: Quad | null, manualPts: { x: number; y: number }[]) => {
    const photo = photoRef.current!;
    const preview = previewRef.current!;
    preview.width = photo.width;
    preview.height = photo.height;
    const ctx = preview.getContext('2d')!;
    ctx.drawImage(photo, 0, 0);
    if (quad) {
      ctx.strokeStyle = '#4ade80';
      ctx.lineWidth = Math.max(2, photo.width / 300);
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      for (let i = 1; i <= 4; i++) ctx.lineTo(quad[i % 4]!.x, quad[i % 4]!.y);
      ctx.stroke();
    }
    ctx.fillStyle = '#f87171';
    for (const p of manualPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(4, photo.width / 150), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /** Paint stages + result state + e2e hook for a pipeline outcome (photo or camera). */
  const showOutcome = (out: ScanPipelineResult, manual: boolean, source: 'photo' | 'camera') => {
    const paint = (canvas: HTMLCanvasElement, data: ImageData) => {
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d')!.putImageData(data, 0, 0);
    };
    paint(warpedRef.current!, out.warped);
    paint(artRef.current!, out.art);
    paint(stripRef.current!, out.infoStrip);

    const run: RunResult = {
      quad: out.quad,
      manual,
      source,
      variant: out.variant,
      flipped: out.flipped,
      hash: out.hash,
      match: out.match,
      timings: out.timings,
    };
    setResult(run);
    setCorners([]);
    setOcr(null);

    // Join candidates against the local card DB.
    void (async () => {
      const printings = await getPrintingsByIds(run.match.candidates.map((c) => c.scryfallId));
      const oracles = await getOracleCardsByIds([...printings.values()].map((p) => p.oracleId));
      const joinedList = run.match.candidates.map((cand) => {
        const printing = printings.get(cand.scryfallId);
        return { cand, printing, oracle: printing && oracles.get(printing.oracleId) };
      });
      setJoined(joinedList);

      // S4: OCR the info strip to pin down printing + language.
      if (run.match.candidates.length) {
        setOcr('reading info strip…');
        try {
          const resolution = await resolveWithOcr(
            out,
            joinedList
              .filter((j) => j.printing)
              .map((j) => ({
                scryfallId: j.cand.scryfallId,
                set: j.printing!.set,
                collectorNumber: j.printing!.collectorNumber,
              })),
          );
          setOcr(resolution);
          (window as unknown as Record<string, unknown>).__scanOcrResult = resolution;
        } catch (e) {
          setOcr(`OCR unavailable: ${(e as Error).message}`);
        }
      }
      // e2e hook: machine-readable outcome for the automated harness test.
      (window as unknown as Record<string, unknown>).__scanTestResult = {
        verdict: run.match.verdict,
        source,
        flipped: run.flipped,
        variant: run.variant,
        detected: !!run.quad,
        hash: { h: formatHash64(run.hash.h), v: formatHash64(run.hash.v) },
        candidates: run.match.candidates.map((c) => ({
          scryfallId: c.scryfallId,
          faceIndex: c.faceIndex,
          distance: c.distance,
        })),
        timings: run.timings,
      };
    })();
  };

  /** Run the shared scan pipeline on the uploaded photo. */
  const runPipeline = (manualQuad: Quad | null) => {
    if (!index) {
      setStatus('Load scan data first.');
      return;
    }
    const photo = photoRef.current!;
    const ctx = photo.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, photo.width, photo.height);

    const scale = DETECT_WIDTH / img.width;
    const small = document.createElement('canvas');
    small.width = DETECT_WIDTH;
    small.height = Math.round(img.height * scale);
    const sctx = small.getContext('2d', { willReadFrequently: true })!;
    sctx.drawImage(photo, 0, 0, small.width, small.height);
    const detect = sctx.getImageData(0, 0, small.width, small.height);

    const out = runScanPipeline({ full: img, detect, manualQuad }, index);
    drawPreview(out.quad, []);
    showOutcome(out, !!manualQuad, 'photo');
    setStatus(
      out.quad
        ? `Card ${manualQuad ? '(manual corners)' : 'detected'}: ${out.match.verdict}.`
        : `No card quad found; matched against the full frame (${out.match.verdict}). Tap 4 corners (TL→TR→BR→BL) to fix.`,
    );
  };

  const loadPhoto = async (file: File) => {
    setBusy(true);
    setStatus('Processing photo…');
    setResult(null);
    setJoined([]);
    setCorners([]);
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(bmp.width, bmp.height));
      const photo = photoRef.current!;
      photo.width = Math.round(bmp.width * scale);
      photo.height = Math.round(bmp.height * scale);
      photo.getContext('2d', { willReadFrequently: true })!.drawImage(bmp, 0, 0, photo.width, photo.height);
      bmp.close();
      runPipeline(null);
    } catch (e) {
      setStatus(`Photo failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const startCamera = () => {
    if (!index) {
      setStatus('Load scan data first.');
      return;
    }
    const cam = new CameraScan(videoRef.current!, index, (s) => {
      setLive(s);
      if (s.status === 'locked') {
        showOutcome(s.result, false, 'camera');
        setStatus(`Camera locked: ${s.result.match.verdict}.`);
      }
    });
    cameraRef.current = cam;
    void cam.start();
  };

  const stopCamera = () => {
    cameraRef.current?.stop();
    cameraRef.current = null;
    setLive(null);
  };

  /** Manual corner picking on the preview (TL → TR → BR → BL). */
  const onPreviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const preview = previewRef.current!;
    if (!preview.width) return;
    const rect = preview.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * preview.width;
    const y = ((e.clientY - rect.top) / rect.height) * preview.height;
    const pts = [...corners, { x, y }];
    if (pts.length < 4) {
      setCorners(pts);
      drawPreview(result?.quad ?? null, pts);
      setStatus(`Corner ${pts.length}/4 set. Tap ${['TL', 'TR', 'BR', 'BL'][pts.length]} next.`);
    } else {
      runPipeline(orientQuadPortrait(pts as unknown as Quad));
    }
  };

  const ms = (n: number) => `${n.toFixed(0)} ms`;

  return (
    <Page title="Scan test" subtitle="Dev harness: upload a card photo, match it against the art-hash blob">
      <section className="scan-section">
        <h2>Scan data</h2>
        {installed ? (
          <p>
            Installed: v{installed.version} · {installed.count.toLocaleString()} hashes (algo {installed.algo}) ·{' '}
            {(installed.blob.byteLength / 1e6).toFixed(1)} MB
          </p>
        ) : (
          <p>No scan data installed yet.</p>
        )}
        <div className="scan-actions">
          {SCAN_DATA_BASE && (
            <button onClick={() => void checkServer()} disabled={busy}>
              Check server
            </button>
          )}
          <label className="scan-file-btn">
            Load cardhashes.bin…
            <input
              type="file"
              accept=".bin"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ''; // allow re-selecting the same file
                if (f) void loadBlobFile(f);
              }}
            />
          </label>
        </div>
      </section>

      <section className="scan-section">
        <h2>Test photo</h2>
        <label className="scan-file-btn">
          Upload card photo…
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={!index}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ''; // allow re-selecting the same file
              if (f) void loadPhoto(f);
            }}
          />
        </label>
        {!index && <p className="scan-hint">Load scan data first.</p>}
        {status && <p className="scan-status">{status}</p>}
      </section>

      <section className="scan-section">
        <h2>Live camera</h2>
        <div className="scan-actions">
          {!live ? (
            <button onClick={startCamera} disabled={!index}>
              Start camera
            </button>
          ) : (
            <>
              {live.status === 'locked' && (
                <button onClick={() => cameraRef.current?.resume()}>Resume scanning</button>
              )}
              <button onClick={stopCamera}>Stop camera</button>
            </>
          )}
        </div>
        <video ref={videoRef} className="scan-video" playsInline autoPlay muted hidden={!live} />
        {live?.status === 'starting' && <p className="scan-status">Starting camera…</p>}
        {live?.status === 'error' && <p className="scan-status">Camera failed: {live.message}</p>}
        {live?.status === 'scanning' && (
          <p className="scan-status">
            {live.cardSeen ? `Card in view, best distance ${live.lastDistance ?? '–'}` : 'Looking for a card…'}
            {` · ${live.frameMs.toFixed(0)} ms/frame`}
          </p>
        )}
      </section>

      <canvas ref={photoRef} hidden />
      <div className="scan-canvases">
        <div>
          <canvas ref={previewRef} className="scan-preview" onClick={onPreviewClick} />
          {result && <p className="scan-hint">Tap 4 corners (TL→TR→BR→BL) to override the quad.</p>}
        </div>
        <div className="scan-stages">
          <canvas ref={warpedRef} className="scan-warped" />
          <canvas ref={artRef} className="scan-art" />
          <canvas ref={stripRef} className="scan-strip" />
        </div>
      </div>

      {result && (
        <section className="scan-section">
          <h2>Result: {result.match.verdict}</h2>
          <p className="scan-meta">
            hash H {formatHash64(result.hash.h)} · V {formatHash64(result.hash.v)}
            {result.flipped && ' · matched upside-down'}
            {result.variant !== 0 && ` · quad ${result.variant > 0 ? 'grown' : 'shrunk'} ${Math.abs(result.variant * 100).toFixed(1)}%`}
            {' · '}
            detect {ms(result.timings.detect)} · match {ms(result.timings.match)}
          </p>
          {result.match.candidates.length === 0 && <p>No candidates under the distance cutoff.</p>}
          {ocr && (
            <p className="scan-meta">
              {typeof ocr === 'string' ? (
                `OCR: ${ocr}`
              ) : (
                <>
                  OCR ({ocr.attempts} attempt{ocr.attempts === 1 ? '' : 's'}):{' '}
                  {ocr.parsed
                    ? `#${ocr.parsed.collectorNumber ?? '?'} · ${ocr.parsed.setCode?.toUpperCase() ?? '?'} · ${ocr.parsed.lang ?? '?'}`
                    : 'nothing readable'}
                  {ocr.confirmed
                    ? ' → printing CONFIRMED'
                    : ocr.weak
                      ? ' → set agrees (weak)'
                      : ' → no candidate agreement'}
                </>
              )}
            </p>
          )}
          <ol className="scan-candidates">
            {joined.map(({ cand, printing, oracle }) => (
              <li key={`${cand.scryfallId}:${cand.faceIndex}`}>
                {printing?.imageSmall && <img src={printing.imageSmall} alt="" loading="lazy" />}
                <div>
                  <strong>{oracle?.name ?? cand.scryfallId}</strong>
                  {printing && (
                    <span className="scan-printing">
                      {printing.setName} ({printing.set.toUpperCase()}) #{printing.collectorNumber} · {printing.lang}
                      {cand.faceIndex > 0 && ` · face ${cand.faceIndex}`}
                    </span>
                  )}
                  <span className="scan-distance">distance {cand.distance}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </Page>
  );
}
