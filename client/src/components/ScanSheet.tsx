import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DeckBoard, DeckFormat, Finish, OracleCard, Printing, Priced } from '@mtg/shared';
import { addDeckCard, addToCollection } from '../db/dataAccess.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { parseHashBlob, type ScanIndex } from '../scan/blob.js';
import { CameraScan, type LiveScanState } from '../scan/camera.js';
import type { ScanPipelineResult } from '../scan/pipeline.js';
import { resolveWithOcr } from '../scan/ocr.js';
import { checkScanDataUpdate, downloadScanData, getInstalledScanData, type ScanDataManifest } from '../scan/store.js';
import { useToast } from './Toast.js';

// Camera scanning flow (handover §S5). A live camera locks onto a card (S3
// consensus), OCR pins down edition + language (S4), one tap commits it — then
// the camera resumes for the next card (binder-entry speed is the goal).
//
// The same sheet feeds four destinations (a `ScanTarget`): the collection, the
// tradelist, a deck, or a live trade offer. Everything up to the commit is
// identical; only the final write differs, so it dispatches in `add()` through
// the normal data-access paths (or a callback for the in-memory trade offer).

/** A locked-in scan, ready to be written wherever the target sends it. */
export interface ScannedCard {
  oracleId: string;
  scryfallId: string;
  name: string;
  /** From the foil toggle (irrelevant to deck slots, which store no finish). */
  finish: Finish;
  /** From OCR, defaulting to English. */
  lang: string;
}

/** Where a scan is committed (mirrors CardSheet's context-sensitive AddTarget). */
export type ScanTarget =
  | { kind: 'collection' }
  | { kind: 'tradelist' }
  | { kind: 'deck'; deckId: string; deckName?: string; format?: DeckFormat }
  | { kind: 'trade'; onAdd: (card: ScannedCard) => void };

interface Candidate {
  scryfallId: string;
  distance: number;
  printing?: Priced<Printing>;
  oracle?: Priced<OracleCard>;
}

type OcrState = 'pending' | 'confirmed' | 'weak' | 'none' | 'unavailable';

type Stage =
  | { kind: 'setup'; message: string; download?: ScanDataManifest }
  | { kind: 'downloading'; progress: string }
  | { kind: 'scanning' }
  | { kind: 'confirm'; candidates: Candidate[]; selected: string; ocr: OcrState; lang: string };

/** Whether the card's finish matters for this target (deck slots ignore it). */
function finishMatters(target: ScanTarget): boolean {
  return target.kind !== 'deck';
}

const BOARD_LABELS: Record<DeckBoard, string> = {
  main: 'mainboard',
  side: 'sideboard',
  commander: 'command zone',
};

/** Which boards a deck scan can target (commander only for commander decks). */
function deckBoards(format?: DeckFormat): DeckBoard[] {
  return format === 'commander' ? ['main', 'side', 'commander'] : ['main', 'side'];
}

function targetLabel(target: ScanTarget): string {
  switch (target.kind) {
    case 'collection':
      return 'Collection';
    case 'tradelist':
      return 'Tradelist';
    case 'deck':
      return target.deckName ?? 'Deck';
    case 'trade':
      return 'Trade offer';
  }
}

function addLabel(target: ScanTarget, board: DeckBoard): string {
  switch (target.kind) {
    case 'collection':
      return 'Add to collection';
    case 'tradelist':
      return 'Add to tradelist';
    case 'deck':
      return `Add to ${BOARD_LABELS[board]}`;
    case 'trade':
      return 'Add to trade';
  }
}

export function ScanSheet({ target = { kind: 'collection' }, onClose }: { target?: ScanTarget; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'setup', message: 'Checking scan data…' });
  const [live, setLive] = useState<LiveScanState | null>(null);
  const [added, setAdded] = useState(0);
  const [foil, setFoil] = useState(false);
  const [board, setBoard] = useState<DeckBoard>('main');
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraScan | null>(null);
  const indexRef = useRef<ScanIndex | null>(null);
  const toast = useToast();

  const startScanning = (index: ScanIndex) => {
    indexRef.current = index;
    setStage({ kind: 'scanning' });
    const cam = new CameraScan(videoRef.current!, index, (s) => {
      setLive(s);
      if (s.status === 'locked') void onLocked(s.result);
    });
    cameraRef.current = cam;
    void cam.start();
  };

  // Scan data must be installed before the camera is useful.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const installed = await getInstalledScanData();
      if (cancelled) return;
      if (installed) {
        startScanning(parseHashBlob(installed.blob));
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
      cameraRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async (manifest: ScanDataManifest) => {
    setStage({ kind: 'downloading', progress: `Downloading ${(manifest.bytes / 1e6).toFixed(1)} MB…` });
    try {
      const row = await downloadScanData(manifest);
      startScanning(parseHashBlob(row.blob));
    } catch (e) {
      setStage({ kind: 'setup', message: `Download failed: ${(e as Error).message}` });
    }
  };

  const onLocked = async (result: ScanPipelineResult) => {
    // Join candidates with the card DB; collapse per-face duplicates.
    const ids = [...new Set(result.match.candidates.map((c) => c.scryfallId))];
    const printings = await getPrintingsByIds(ids);
    const oracles = await getOracleCardsByIds([...printings.values()].map((p) => p.oracleId));
    const candidates: Candidate[] = ids.map((id) => {
      const printing = printings.get(id);
      const best = result.match.candidates.find((c) => c.scryfallId === id)!;
      return { scryfallId: id, distance: best.distance, printing, oracle: printing && oracles.get(printing.oracleId) };
    });

    setStage({ kind: 'confirm', candidates, selected: ids[0]!, ocr: 'pending', lang: 'en' });

    // S4: OCR the info strip to pin down printing + language.
    try {
      const resolution = await resolveWithOcr(
        result,
        candidates
          .filter((c) => c.printing)
          .map((c) => ({ scryfallId: c.scryfallId, set: c.printing!.set, collectorNumber: c.printing!.collectorNumber })),
      );
      setStage((s) => {
        if (s.kind !== 'confirm') return s;
        const hit = resolution.confirmed ?? resolution.weak;
        return {
          ...s,
          ocr: resolution.confirmed ? 'confirmed' : resolution.weak ? 'weak' : 'none',
          selected: hit?.scryfallId ?? s.selected,
          lang: resolution.parsed?.lang ?? s.lang,
        };
      });
    } catch {
      setStage((s) => (s.kind === 'confirm' ? { ...s, ocr: 'unavailable' } : s));
    }
  };

  const resume = () => {
    setStage({ kind: 'scanning' });
    cameraRef.current?.resume();
  };

  const add = async (c: Candidate, lang: string) => {
    if (!c.printing) return;
    const scanned: ScannedCard = {
      oracleId: c.printing.oracleId,
      scryfallId: c.scryfallId,
      name: c.oracle?.name ?? 'card',
      finish: foil ? 'foil' : 'nonfoil',
      lang,
    };
    switch (target.kind) {
      case 'collection':
        await addToCollection({ ...scanned, condition: 'NM', quantity: 1 });
        break;
      case 'tradelist':
        // Same collection entry, but at least one copy starts marked for trade.
        await addToCollection({ ...scanned, condition: 'NM', quantity: 1, quantityForTrade: 1 });
        break;
      case 'deck':
        // Deck slots key on oracle + board; keep the scanned printing as the
        // slot's preferred edition (like a hand-picked printing).
        await addDeckCard({ deckId: target.deckId, oracleId: scanned.oracleId, scryfallId: scanned.scryfallId, board, quantity: 1 });
        break;
      case 'trade':
        target.onAdd(scanned);
        break;
    }
    setAdded((n) => n + 1);
    toast(`Added ${scanned.name}`);
    resume();
  };

  const close = () => {
    cameraRef.current?.stop();
    onClose();
  };

  return createPortal(
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet scan-sheet" role="dialog" aria-label="Scan cards" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>Scan cards</h2>
          <span className="scan-target">→ {targetLabel(target)}</span>
          {added > 0 && <span className="scan-added">+{added} added</span>}
          <button className="scan-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        <video ref={videoRef} className="scan-sheet-video" playsInline autoPlay muted hidden={stage.kind === 'setup' || stage.kind === 'downloading'} />

        {stage.kind === 'setup' && (
          <>
            <p>{stage.message}</p>
            {stage.download && (
              <button className="primary" onClick={() => void download(stage.download!)}>
                Download scan data (~{(stage.download.bytes / 1e6).toFixed(0)} MB)
              </button>
            )}
          </>
        )}
        {stage.kind === 'downloading' && <p>{stage.progress}</p>}

        {stage.kind === 'scanning' && (
          <p className="scan-status">
            {live?.status === 'starting' && 'Starting camera…'}
            {live?.status === 'error' && `Camera failed: ${live.message}`}
            {live?.status === 'scanning' && (live.cardSeen ? 'Hold steady…' : 'Point the camera at a card')}
            {live?.status === 'locked' && 'Card found'}
          </p>
        )}

        {stage.kind === 'confirm' && (
          <ConfirmPanel
            stage={stage}
            target={target}
            foil={foil}
            setFoil={setFoil}
            board={board}
            setBoard={setBoard}
            onSelect={(id) => setStage((s) => (s.kind === 'confirm' ? { ...s, selected: id } : s))}
            onAdd={(c) => void add(c, stage.lang)}
            onSkip={resume}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function ConfirmPanel({
  stage,
  target,
  foil,
  setFoil,
  board,
  setBoard,
  onSelect,
  onAdd,
  onSkip,
}: {
  stage: Extract<Stage, { kind: 'confirm' }>;
  target: ScanTarget;
  foil: boolean;
  setFoil: (v: boolean) => void;
  board: DeckBoard;
  setBoard: (b: DeckBoard) => void;
  onSelect: (id: string) => void;
  onAdd: (c: Candidate) => void;
  onSkip: () => void;
}) {
  const selected = stage.candidates.find((c) => c.scryfallId === stage.selected) ?? stage.candidates[0];
  if (!selected) {
    return (
      <>
        <p>No match found — try again with better light.</p>
        <div className="scan-confirm-actions">
          <button onClick={onSkip}>Keep scanning</button>
        </div>
      </>
    );
  }

  const ocrLabel: Record<OcrState, string> = {
    pending: 'checking edition…',
    confirmed: 'edition confirmed',
    weak: 'set matches',
    none: 'edition unverified — check below',
    unavailable: 'edition check unavailable',
  };

  return (
    <>
      <div className="scan-confirm">
        {selected.printing?.imageNormal && <img className="scan-confirm-img" src={selected.printing.imageNormal} alt="" />}
        <div className="scan-confirm-text">
          <strong>{selected.oracle?.name ?? 'Unknown card'}</strong>
          {selected.printing && (
            <span className="scan-printing">
              {selected.printing.setName} ({selected.printing.set.toUpperCase()}) #{selected.printing.collectorNumber} ·{' '}
              {stage.lang}
            </span>
          )}
          <span className="scan-hint">{ocrLabel[stage.ocr]}</span>
          {finishMatters(target) && (
            <label className="scan-foil">
              <input type="checkbox" checked={foil} onChange={(e) => setFoil(e.target.checked)} /> Foil
            </label>
          )}
        </div>
      </div>

      {target.kind === 'deck' && (
        <div className="seg-row scan-board" role="radiogroup" aria-label="Add to board">
          {deckBoards(target.format).map((b) => (
            <button
              key={b}
              role="radio"
              aria-checked={board === b}
              className={board === b ? 'seg seg-active' : 'seg'}
              onClick={() => setBoard(b)}
            >
              {b === 'main' ? 'Main' : b === 'side' ? 'Side' : 'Commander'}
            </button>
          ))}
        </div>
      )}

      {stage.candidates.length > 1 && (
        <div className="scan-alternatives">
          {stage.candidates.map((c) => (
            <label key={c.scryfallId} className="scan-alternative">
              <input
                type="radio"
                name="scan-candidate"
                checked={c.scryfallId === stage.selected}
                onChange={() => onSelect(c.scryfallId)}
              />
              <span>
                {c.oracle?.name ?? c.scryfallId}
                {c.printing && ` — ${c.printing.set.toUpperCase()} #${c.printing.collectorNumber}`}
                <span className="scan-distance"> d{c.distance}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="scan-confirm-actions">
        <button className="primary" disabled={!selected.printing} onClick={() => onAdd(selected)}>
          {addLabel(target, board)}
        </button>
        <button onClick={onSkip}>Skip</button>
      </div>
    </>
  );
}
