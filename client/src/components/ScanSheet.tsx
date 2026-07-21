import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Condition, DeckBoard, DeckFormat, Finish, OracleCard, Printing, Priced } from '@mtg/shared';
import { addDeckCardsBulk, addToWishlistBulk, applyImport, markOwnedForTrade } from '../db/dataAccess.js';
import { getOracleCard, getOracleCardsByIds, getPrinting, getPrintingsByIds } from '../db/queries.js';
import { ImportConflicts } from '../import/ImportConflicts.js';
import { findImportConflicts, type ConflictChoice, type ImportConflict } from '../import/conflicts.js';
import type { ResolvedLine } from '../import/types.js';
import { CardSheet, type SessionCardValues } from './CardSheet.js';
import { filterScanIndex, parseHashBlob, type ScanIndex } from '../scan/blob.js';
import { getScanExcludedIds } from '../scan/exclusions.js';
import { CameraScan, type LiveScanState } from '../scan/camera.js';
import type { ScanPipelineResult } from '../scan/pipeline.js';
import { resolveWithOcr } from '../scan/ocr.js';
import { checkScanDataUpdate, downloadScanData, getInstalledScanData, type ScanDataManifest } from '../scan/store.js';
import { Icon } from './icons.js';
import { useToast } from './Toast.js';

// Camera scanning flow (handover §S5), built for one-handed binder entry: the
// camera fills the top of the screen and never pauses; each lock (S3 consensus
// + S4 OCR) fills a horizontal candidate tray along the bottom. Tapping a
// candidate's top half adds +1 to a session list, the bottom half takes one
// back — no scrolling, no per-card confirm step. A list button reviews and
// edits the session; completing it writes everything to the target at once.
//
// The same screen feeds several destinations (a `ScanTarget`): the collection,
// the tradelist, the wishlist, a deck, or a live trade offer. Everything up to
// the commit is identical; only the final write differs, so `complete()`
// dispatches through the normal data-access paths (or a callback for the
// in-memory trade offer).

/** A locked-in scan, ready to be written wherever the target sends it. */
export interface ScannedCard {
  oracleId: string;
  scryfallId: string;
  name: string;
  /** From the foil toggle (irrelevant to deck slots, which store no finish). */
  finish: Finish;
  /** From OCR, defaulting to English. */
  lang: string;
  quantity: number;
}

/** Where a scan is committed (mirrors CardSheet's context-sensitive AddTarget). */
export type ScanTarget =
  | { kind: 'collection' }
  | { kind: 'tradelist' }
  | { kind: 'wishlist' }
  | { kind: 'deck'; deckId: string; deckName?: string; format?: DeckFormat }
  | { kind: 'trade'; label?: string; onAdd: (card: ScannedCard) => void };

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
  | { kind: 'scanning' };

/** The current lock's candidates, shown in the bottom tray until the next lock. */
interface Tray {
  /** Top candidate of the lock that produced this tray — dedups re-locks of the same card. */
  topId: string;
  candidates: Candidate[];
  ocr: OcrState;
  /** The candidate OCR confirmed (or weakly matched), if any. */
  ocrHit: string | null;
  lang: string;
}

/** One line of the scan session — what "complete" will write. */
interface SessionEntry {
  scryfallId: string;
  oracleId: string;
  name: string;
  set: string;
  collectorNumber: string;
  image?: string;
  finish: Finish;
  lang: string;
  /** 'NM' until edited in the session list's card sheet. */
  condition: Condition;
  board: DeckBoard;
  qty: number;
}

/** +1/−1 tap feedback on a tray tile; seq remounts the animation per tap. */
interface TapFx {
  id: string;
  delta: 1 | -1;
  seq: number;
}

const entryKey = (e: Pick<SessionEntry, 'scryfallId' | 'finish' | 'condition' | 'board'>) =>
  `${e.scryfallId}|${e.finish}|${e.condition}|${e.board}`;

/** Collapse duplicate (printing, finish, condition, board) lines after a row edit. */
function mergeSession(entries: SessionEntry[]): SessionEntry[] {
  const map = new Map<string, SessionEntry>();
  for (const e of entries) {
    const prev = map.get(entryKey(e));
    if (prev) prev.qty += e.qty;
    else map.set(entryKey(e), { ...e });
  }
  return [...map.values()];
}

/** Whether the card's finish matters for this target (deck slots and wishlist ignore it). */
function finishMatters(target: ScanTarget): boolean {
  return target.kind !== 'deck' && target.kind !== 'wishlist';
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
    case 'wishlist':
      return 'Wishlist';
    case 'deck':
      return target.deckName ?? 'Deck';
    case 'trade':
      return target.label ?? 'Trade offer';
  }
}

export function ScanSheet({ target = { kind: 'collection' }, onClose }: { target?: ScanTarget; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ kind: 'setup', message: 'Checking scan data…' });
  const [live, setLive] = useState<LiveScanState | null>(null);
  const [tray, setTray] = useState<Tray | null>(null);
  const [session, setSession] = useState<SessionEntry[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [fx, setFx] = useState<TapFx | null>(null);
  const [foil, setFoil] = useState(false);
  const [board, setBoard] = useState<DeckBoard>('main');
  // True while the session is being written — guards against the double-tap
  // that used to commit the whole scan twice (adding two copies of everything).
  const [committing, setCommitting] = useState(false);
  // Set when a collection/tradelist commit finds cards already owned: the
  // skip/add/replace resolution screen (reused from import) shows until resolved.
  const [conflictStep, setConflictStep] = useState<{ lines: ResolvedLine[]; conflicts: ImportConflict[] } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraScan | null>(null);
  const closedRef = useRef(false);
  const trayRef = useRef<Tray | null>(null);
  const fxSeq = useRef(0);
  const toast = useToast();

  const total = session.reduce((n, e) => n + e.qty, 0);

  const updateTray = (t: Tray | null) => {
    trayRef.current = t;
    setTray(t);
  };

  /** Parse the blob and drop printings the camera must never suggest. */
  const buildIndex = async (blob: ArrayBuffer): Promise<ScanIndex> => filterScanIndex(parseHashBlob(blob), await getScanExcludedIds());

  const startScanning = (index: ScanIndex) => {
    // The sheet may have closed while a download/index-build was in flight; don't
    // build a camera on a torn-down video element (it would acquire and leak it).
    if (closedRef.current || !videoRef.current) return;
    setStage({ kind: 'scanning' });
    const cam = new CameraScan(videoRef.current, index, (s) => {
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
        const index = await buildIndex(installed.blob);
        if (cancelled) return;
        startScanning(index);
        // Scan immediately on the installed index, but check the beacon in the
        // background: the scanjob keeps publishing newer versions, and without
        // this a device runs on its first download forever. The fresh blob is
        // installed for the next scan session (no disruptive mid-scan swap).
        void checkScanDataUpdate()
          .then((u) => (u.kind === 'update' ? downloadScanData(u.manifest) : undefined))
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
      cameraRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async (manifest: ScanDataManifest) => {
    setStage({ kind: 'downloading', progress: `Downloading ${(manifest.bytes / 1e6).toFixed(1)} MB…` });
    try {
      const row = await downloadScanData(manifest);
      startScanning(await buildIndex(row.blob));
    } catch (e) {
      setStage({ kind: 'setup', message: `Download failed: ${(e as Error).message}` });
    }
  };

  const onLocked = async (result: ScanPipelineResult) => {
    // The camera never stops between cards, so it keeps re-locking whatever is
    // in frame — only a *different* top candidate replaces the tray (and
    // re-runs the DB join + OCR).
    const topId = result.match.candidates[0]?.scryfallId;
    if (!topId || topId === trayRef.current?.topId) {
      cameraRef.current?.resume();
      return;
    }

    // Join candidates with the card DB; collapse per-face duplicates.
    const ids = [...new Set(result.match.candidates.map((c) => c.scryfallId))];
    const printings = await getPrintingsByIds(ids);
    const oracles = await getOracleCardsByIds([...printings.values()].map((p) => p.oracleId));
    const candidates: Candidate[] = ids.map((id) => {
      const printing = printings.get(id);
      const best = result.match.candidates.find((c) => c.scryfallId === id)!;
      return { scryfallId: id, distance: best.distance, printing, oracle: printing && oracles.get(printing.oracleId) };
    });

    updateTray({ topId, candidates, ocr: 'pending', ocrHit: null, lang: 'en' });
    cameraRef.current?.resume();

    // S4: OCR the info strip to pin down printing + language. By the time it
    // resolves the user may already be on the next card — only touch the tray
    // if it still shows this lock.
    try {
      const resolution = await resolveWithOcr(
        result,
        candidates
          .filter((c) => c.printing)
          .map((c) => ({ scryfallId: c.scryfallId, set: c.printing!.set, collectorNumber: c.printing!.collectorNumber })),
      );
      const current = trayRef.current;
      if (current?.topId !== topId) return;
      const hit = resolution.confirmed ?? resolution.weak;
      // Bring the confirmed edition to the front of the tray.
      let ordered = current.candidates;
      const idx = hit ? ordered.findIndex((c) => c.scryfallId === hit.scryfallId) : -1;
      if (idx > 0) ordered = [ordered[idx]!, ...ordered.filter((_, j) => j !== idx)];
      updateTray({
        ...current,
        candidates: ordered,
        ocr: resolution.confirmed ? 'confirmed' : resolution.weak ? 'weak' : 'none',
        ocrHit: hit?.scryfallId ?? null,
        lang: resolution.parsed?.lang ?? current.lang,
      });
    } catch {
      const current = trayRef.current;
      if (current?.topId === topId) updateTray({ ...current, ocr: 'unavailable' });
    }
  };

  /** +1/−1 from a tray tile, into the session list. */
  const bump = (c: Candidate, delta: 1 | -1, lang: string) => {
    if (!c.printing) return;
    const finish: Finish = finishMatters(target) && foil ? 'foil' : 'nonfoil';
    const b: DeckBoard = target.kind === 'deck' ? board : 'main';
    // Fresh scans are always NM; conditions are set afterwards in the list.
    const key = entryKey({ scryfallId: c.scryfallId, finish, condition: 'NM', board: b });
    let i = session.findIndex((e) => entryKey(e) === key);
    if (delta > 0) {
      if (i >= 0) {
        setSession(session.map((e, j) => (j === i ? { ...e, qty: e.qty + 1 } : e)));
      } else {
        setSession([
          ...session,
          {
            scryfallId: c.scryfallId,
            oracleId: c.printing.oracleId,
            name: c.oracle?.name ?? 'Unknown card',
            set: c.printing.set,
            collectorNumber: c.printing.collectorNumber,
            image: c.printing.imageNormal ?? undefined,
            finish,
            lang,
            condition: 'NM',
            board: b,
            qty: 1,
          },
        ]);
      }
    } else {
      // Fall back to any entry of this printing (e.g. the foil toggle moved since the +1).
      if (i < 0) {
        for (let j = session.length - 1; j >= 0; j--) {
          if (session[j]!.scryfallId === c.scryfallId) {
            i = j;
            break;
          }
        }
      }
      if (i < 0) return; // nothing to take back — no feedback either
      const e = session[i]!;
      setSession(e.qty <= 1 ? session.filter((_, j) => j !== i) : session.map((x, j) => (j === i ? { ...x, qty: x.qty - 1 } : x)));
    }
    setFx({ id: c.scryfallId, delta, seq: ++fxSeq.current });
  };

  const openList = () => {
    cameraRef.current?.pause();
    setListOpen(true);
  };

  const closeList = () => {
    setListOpen(false);
    cameraRef.current?.resume();
  };

  /** The session as import lines (collection/tradelist go through applyImport). */
  const sessionLines = (): ResolvedLine[] =>
    session.map((e) => ({
      oracleId: e.oracleId,
      scryfallId: e.scryfallId,
      name: e.name,
      quantity: e.qty,
      // Marked for trade only when the destination is the tradelist.
      quantityForTrade: target.kind === 'tradelist' ? e.qty : 0,
      condition: e.condition,
      finish: e.finish,
      lang: e.lang,
    }));

  const finishScan = () => {
    cameraRef.current?.stop();
    onClose();
  };

  /**
   * Commit the collection/tradelist lines, honoring the conflict screen's
   * per-card choices. 'trade' (tradelist only) flags copies already owned for
   * trade without adding any; everything else goes through the batched import
   * path (one history entry). 'skip' drops the line entirely.
   */
  const commitLines = async (lines: ResolvedLine[], choices: Map<string, ConflictChoice>) => {
    const tradeReqs = lines.filter((l) => choices.get(l.oracleId) === 'trade');
    const importLines = lines.filter((l) => {
      const c = choices.get(l.oracleId);
      return c !== 'skip' && c !== 'trade';
    });
    const replaceOracleIds = [...choices].filter(([, c]) => c === 'replace').map(([id]) => id);

    const flagged = tradeReqs.length
      ? await markOwnedForTrade(
          tradeReqs.map((l) => ({ oracleId: l.oracleId, scryfallId: l.scryfallId, condition: l.condition, finish: l.finish, lang: l.lang, quantity: l.quantity })),
          { source: 'scan' },
        )
      : 0;
    const added = importLines.length ? (await applyImport(importLines, { source: 'scan', replaceOracleIds })).cards : 0;

    const n = added + flagged;
    toast(n === 0 ? 'Nothing added: every card was skipped' : `Added ${n} card${n === 1 ? '' : 's'} to ${targetLabel(target)}`);
    finishScan();
  };

  /** Write the whole session to the target and leave the scanner. */
  const complete = async () => {
    if (committing || session.length === 0) return;
    setCommitting(true);
    try {
      // Collection & tradelist route through the import pipeline: the batch scan
      // becomes one history entry, and any card already owned surfaces the
      // skip/add/replace screen instead of silently stacking extra copies.
      if (target.kind === 'collection' || target.kind === 'tradelist') {
        const lines = sessionLines();
        const conflicts = await findImportConflicts(lines);
        if (conflicts.length > 0) {
          setConflictStep({ lines, conflicts });
          return;
        }
        await commitLines(lines, new Map());
        return;
      }
      switch (target.kind) {
        case 'wishlist':
          // A scanned card is a specific printing, so the wish is for that edition.
          await addToWishlistBulk(
            session.map((e) => ({ oracleId: e.oracleId, scryfallId: e.scryfallId, quantity: e.qty })),
            { source: 'scan' },
          );
          break;
        case 'deck':
          // Deck slots key on oracle + board; keep the scanned printing as the
          // slot's preferred edition (like a hand-picked printing).
          await addDeckCardsBulk(
            target.deckId,
            session.map((e) => ({ oracleId: e.oracleId, scryfallId: e.scryfallId, board: e.board, quantity: e.qty })),
            { source: 'scan' },
          );
          break;
        case 'trade':
          for (const e of session) {
            target.onAdd({ oracleId: e.oracleId, scryfallId: e.scryfallId, name: e.name, finish: e.finish, lang: e.lang, quantity: e.qty });
          }
          break;
      }
      toast(`Added ${total} card${total === 1 ? '' : 's'} to ${targetLabel(target)}`);
      finishScan();
    } finally {
      setCommitting(false);
    }
  };

  const close = () => {
    if (total > 0 && !window.confirm(`Discard ${total} scanned card${total === 1 ? '' : 's'}?`)) return;
    cameraRef.current?.stop();
    onClose();
  };

  /** Session copies of a printing across finishes/boards — the tile's badge. */
  const countOf = (scryfallId: string) => session.reduce((n, e) => (e.scryfallId === scryfallId ? n + e.qty : n), 0);

  return createPortal(
    <div className="scan-screen" role="dialog" aria-label="Scan cards">
      <div className="scan-camera">
        <video ref={videoRef} className="scan-camera-video" playsInline autoPlay muted />

        <div className="scan-cam-top">
          <button className="scan-cam-btn" onClick={close} aria-label="Close scanner">
            <Icon name="close" />
          </button>
          <span className="scan-cam-target">→ {targetLabel(target)}</span>
        </div>

        <div className="scan-cam-side">
          <button className="scan-cam-btn" onClick={openList} aria-label={`Review ${total} scanned cards`}>
            <Icon name="list" />
            {total > 0 && <span className="scan-cam-badge">{total}</span>}
          </button>
          {finishMatters(target) && (
            <button
              className={foil ? 'scan-cam-chip scan-cam-chip-on' : 'scan-cam-chip'}
              onClick={() => setFoil(!foil)}
              aria-pressed={foil}
            >
              Foil
            </button>
          )}
        </div>

        {target.kind === 'deck' && stage.kind === 'scanning' && (
          <div className="seg-row scan-cam-board" role="radiogroup" aria-label="Add to board">
            {deckBoards(target.format).map((b) => (
              <button key={b} role="radio" aria-checked={board === b} className={board === b ? 'seg seg-active' : 'seg'} onClick={() => setBoard(b)}>
                {b === 'main' ? 'Main' : b === 'side' ? 'Side' : 'Commander'}
              </button>
            ))}
          </div>
        )}

        {stage.kind === 'scanning' && live && (
          <p className="scan-cam-status">
            {live.status === 'starting' && 'Starting camera…'}
            {live.status === 'error' && `Camera failed: ${live.message}`}
            {live.status === 'scanning' && (live.cardSeen ? 'Hold steady…' : 'Point the camera at a card')}
            {live.status === 'locked' && 'Card found'}
          </p>
        )}

        {(stage.kind === 'setup' || stage.kind === 'downloading') && (
          <div className="scan-cam-panel">
            <p>{stage.kind === 'setup' ? stage.message : stage.progress}</p>
            {stage.kind === 'setup' && stage.download && (
              <button className="primary" onClick={() => void download(stage.download!)}>
                Download scan data (~{(stage.download.bytes / 1e6).toFixed(0)} MB)
              </button>
            )}
          </div>
        )}
      </div>

      <div className="scan-tray">
        {tray ? (
          tray.candidates.map((c) => (
            <TrayTile
              key={c.scryfallId}
              candidate={c}
              count={countOf(c.scryfallId)}
              confirmed={tray.ocrHit === c.scryfallId && (tray.ocr === 'confirmed' || tray.ocr === 'weak')}
              fx={fx?.id === c.scryfallId ? fx : null}
              onBump={(delta) => bump(c, delta, tray.lang)}
            />
          ))
        ) : (
          <p className="scan-tray-hint">Matches land here. Tap the top of a card for +1, the bottom for −1.</p>
        )}
      </div>

      {listOpen && (
        <SessionSheet
          entries={session}
          target={target}
          total={total}
          busy={committing}
          onChange={setSession}
          onComplete={() => void complete()}
          onClose={closeList}
        />
      )}

      {conflictStep &&
        (() => {
          const nConflicts = conflictStep.conflicts.length;
          const otherCount = conflictStep.lines.length - conflictStep.conflicts.reduce((s, c) => s + c.incoming.length, 0);
          const toTradelist = target.kind === 'tradelist';
          return (
            <div className="sheet-backdrop" onClick={() => setConflictStep(null)}>
              <div className="sheet" role="dialog" aria-label="Resolve duplicates" onClick={(e) => e.stopPropagation()}>
                <ImportConflicts
                  conflicts={conflictStep.conflicts}
                  otherCount={otherCount}
                  options={
                    toTradelist
                      ? [
                          { value: 'trade', label: 'Trade' },
                          { value: 'add', label: 'Add' },
                          { value: 'skip', label: 'Skip' },
                        ]
                      : undefined
                  }
                  defaultChoice={toTradelist ? 'trade' : undefined}
                  intro={
                    toTradelist ? (
                      <>
                        {nConflicts} scanned card{nConflicts === 1 ? '' : 's'} {nConflicts === 1 ? 'is' : 'are'} already in your
                        collection. Per card: <strong>Trade</strong> marks the copies you already own for trade (adds nothing),{' '}
                        <strong>Add</strong> adds new copies and marks them, <strong>Skip</strong> leaves it off your tradelist.
                        {otherCount > 0 && (
                          <>
                            {' '}
                            The other {otherCount} card{otherCount === 1 ? '' : 's'} you don&rsquo;t own yet {otherCount === 1 ? 'is' : 'are'}{' '}
                            added to your collection and marked for trade.
                          </>
                        )}
                      </>
                    ) : undefined
                  }
                  confirmLabel={(n) => (n === 0 ? 'Nothing to add' : `Add ${n} card${n === 1 ? '' : 's'} to ${targetLabel(target)}`)}
                  onConfirm={(choices) => commitLines(conflictStep.lines, choices)}
                  onBack={() => setConflictStep(null)}
                />
              </div>
            </div>
          );
        })()}
    </div>,
    document.body,
  );
}

function TrayTile({
  candidate: c,
  count,
  confirmed,
  fx,
  onBump,
}: {
  candidate: Candidate;
  count: number;
  confirmed: boolean;
  fx: TapFx | null;
  onBump: (delta: 1 | -1) => void;
}) {
  const name = c.oracle?.name ?? 'Unknown card';
  return (
    <div className="scan-tile">
      <div className="scan-tile-card">
        {c.printing?.imageNormal ? <img src={c.printing.imageNormal} alt={name} /> : <div className="scan-tile-ph">{name}</div>}
        <button className="scan-tile-half scan-tile-add" onClick={() => onBump(1)} aria-label={`Add ${name}`}>
          <Icon name="plus" size={16} />
        </button>
        <button className="scan-tile-half scan-tile-sub" onClick={() => onBump(-1)} aria-label={`Remove ${name}`}>
          <Icon name="minus" size={16} />
        </button>
        {count > 0 && <span className="scan-tile-count">{count}</span>}
        {confirmed && (
          <span className="scan-tile-ocr" title="Edition confirmed">
            <Icon name="check" size={12} />
          </span>
        )}
        {fx && (
          <span key={fx.seq} className="scan-fx" aria-hidden>
            {fx.delta > 0 ? '+1' : '−1'}
          </span>
        )}
      </div>
      <span className="scan-tile-caption">{c.printing ? `${c.printing.set.toUpperCase()} #${c.printing.collectorNumber}` : '—'}</span>
    </div>
  );
}

function SessionSheet({
  entries,
  target,
  total,
  busy,
  onChange,
  onComplete,
  onClose,
}: {
  entries: SessionEntry[];
  target: ScanTarget;
  total: number;
  busy: boolean;
  onChange: (next: SessionEntry[]) => void;
  onComplete: () => void;
  onClose: () => void;
}) {
  // Row tap opens the card sheet on that line for full editing (edition,
  // condition, finish, language, quantity); Apply rewrites the line in place.
  const [editing, setEditing] = useState<{ index: number; oracle: Priced<OracleCard> } | null>(null);
  const trackCondition = target.kind === 'collection' || target.kind === 'tradelist';

  const adjust = (i: number, delta: number) => {
    const e = entries[i]!;
    onChange(e.qty + delta <= 0 ? entries.filter((_, j) => j !== i) : entries.map((x, j) => (j === i ? { ...x, qty: x.qty + delta } : x)));
  };

  const cycleBoard = (i: number) => {
    if (target.kind !== 'deck') return;
    const boards = deckBoards(target.format);
    onChange(
      mergeSession(
        entries.map((e, j) => (j === i ? { ...e, board: boards[(boards.indexOf(e.board) + 1) % boards.length]! } : e)),
      ),
    );
  };

  const openEntry = async (i: number) => {
    const oracle = await getOracleCard(entries[i]!.oracleId);
    if (oracle) setEditing({ index: i, oracle });
  };

  /** Card-sheet Apply/Remove for one line (quantity 0 removes it). */
  const applyEdit = async (i: number, v: SessionCardValues) => {
    if (v.quantity <= 0) {
      onChange(entries.filter((_, j) => j !== i));
      return;
    }
    const e = entries[i]!;
    let next: SessionEntry = {
      ...e,
      qty: v.quantity,
      lang: v.lang ?? e.lang,
      finish: v.finish ?? e.finish,
      condition: v.condition ?? e.condition,
    };
    if (v.scryfallId !== e.scryfallId) {
      const p = await getPrinting(v.scryfallId);
      if (p) next = { ...next, scryfallId: p.scryfallId, set: p.set, collectorNumber: p.collectorNumber, image: p.imageNormal ?? undefined };
    }
    onChange(mergeSession(entries.map((x, j) => (j === i ? next : x))));
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet scan-list-sheet" role="dialog" aria-label="Scanned cards" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>Scanned cards</h2>
          <span className="scan-target">→ {targetLabel(target)}</span>
          <button className="scan-close" onClick={onClose} aria-label="Close list">
            <Icon name="close" size={18} />
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="scan-list-empty">Nothing scanned yet. Tap the top half of a match to add it.</p>
        ) : (
          <ul className="scan-list">
            {entries.map((e, i) => (
              <li key={entryKey(e)} className="scan-list-row">
                <button className="scan-list-main" onClick={() => void openEntry(i)} aria-label={`Edit ${e.name}`}>
                  {e.image ? <img className="scan-list-thumb" src={e.image} alt="" /> : <span className="scan-list-thumb" />}
                  <span className="scan-list-info">
                    <strong>{e.name}</strong>
                    <span className="scan-printing">
                      {e.set.toUpperCase()} #{e.collectorNumber} · {e.lang}
                      {finishMatters(target) && e.finish === 'foil' ? ' · Foil' : ''}
                      {trackCondition && e.condition !== 'NM' ? ` · ${e.condition}` : ''}
                    </span>
                  </span>
                </button>
                {target.kind === 'deck' && (
                  <button className="scan-chip" onClick={() => cycleBoard(i)}>
                    {BOARD_LABELS[e.board]}
                  </button>
                )}
                <div className="scan-list-qty">
                  <button onClick={() => adjust(i, -1)} aria-label={`One less ${e.name}`}>
                    <Icon name="minus" size={16} />
                  </button>
                  <span>{e.qty}</span>
                  <button onClick={() => adjust(i, 1)} aria-label={`One more ${e.name}`}>
                    <Icon name="plus" size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="scan-confirm-actions">
          <button className="primary" disabled={total === 0 || busy} onClick={onComplete}>
            {busy ? 'Adding…' : `Add ${total} card${total === 1 ? '' : 's'} to ${targetLabel(target)}`}
          </button>
          <button onClick={onClose} disabled={busy}>Keep scanning</button>
        </div>

        {editing && entries[editing.index] && (
          <CardSheet
            oracleCard={editing.oracle}
            sessionCard={{
              scryfallId: entries[editing.index]!.scryfallId,
              quantity: entries[editing.index]!.qty,
              lang: finishMatters(target) ? entries[editing.index]!.lang : undefined,
              finish: finishMatters(target) ? entries[editing.index]!.finish : undefined,
              condition: trackCondition ? entries[editing.index]!.condition : undefined,
            }}
            onApply={(v) => void applyEdit(editing.index, v)}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </div>
  );
}
