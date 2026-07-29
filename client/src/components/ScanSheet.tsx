import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CollectionEntry, Condition, ContainerKind, DeckBoard, DeckFormat, Finish, OracleCard, Printing, Priced } from '@mtg/shared';
import { addDeckCardsBulk, addToWishlistBulk, applyImport, collectionKey, markOwnedForTrade, reconcileDeck } from '../db/dataAccess.js';
import { db } from '../db/schema.js';
import { getOracleCard, getOracleCardsByIds, getPrinting, getPrintingsByIds } from '../db/queries.js';
import { ImportConflicts } from '../import/ImportConflicts.js';
import { findImportConflicts, type ConflictChoice, type ImportConflict } from '../import/conflicts.js';
import type { ResolvedLine } from '../import/types.js';
import { CardSheet, type SessionCardValues } from './CardSheet.js';
import { filterScanIndex, parseHashBlob, type ScanIndex } from '../scan/blob.js';
import { getScanExcludedIds } from '../scan/exclusions.js';
import { CameraScan, type LiveScanState } from '../scan/camera.js';
import type { ScanPipelineResult } from '../scan/pipeline.js';
import { CANDIDATE_MAX_DISTANCE, distancesForIds } from '../scan/match.js';
import { resolveWithOcr } from '../scan/ocr.js';
import { playPop } from '../scan/pop.js';
import { checkScanDataUpdate, downloadScanData, getInstalledScanData, type ScanDataManifest } from '../scan/store.js';
import { Icon } from './icons.js';
import { SetSymbol } from './SetSymbol.js';
import { useToast } from './Toast.js';
import { ownedBadge, type OwnedBadgeSpec } from './OwnedBadge.js';
import { CONTAINER_META } from '../deck/containers.js';
import { useOwnershipIndex, type OwnershipIndex } from '../db/useOwnership.js';

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
  // A deck, binder or box (all the same stored row — `containerKind` only picks
  // the wording and, for storage, drops the board picker). `rescan` reconciles
  // it to exactly what was scanned (add/remove/change quantities) instead of
  // only adding — see complete()'s deck branch.
  | {
      kind: 'deck';
      deckId: string;
      deckName?: string;
      containerKind?: ContainerKind;
      format?: DeckFormat;
      rescan?: boolean;
    }
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

/** A deck re-scan target slot (session collapsed to what a deck stores: oracle + board). */
interface RescanSlot {
  oracleId: string;
  board: DeckBoard;
  quantity: number;
  scryfallId?: string;
  name: string;
  image?: string;
}

/** One line of the re-scan diff shown before the deck is reconciled. */
type DeckChange =
  | { kind: 'add'; oracleId: string; board: DeckBoard; name: string; image?: string; quantity: number }
  | { kind: 'remove'; oracleId: string; board: DeckBoard; name: string; image?: string; quantity: number }
  | { kind: 'change'; oracleId: string; board: DeckBoard; name: string; image?: string; from: number; to: number };

/** Everything a deck re-scan needs to review before committing. */
interface RescanReview {
  /** The deck's desired final slots (what reconcileDeck receives). */
  slots: RescanSlot[];
  /** Human-readable diff vs the deck's current contents (unchanged slots omitted). */
  changes: DeckChange[];
  /** Scanned printings not currently in the collection — offered as a follow-up add. */
  unowned: SessionEntry[];
}

/** One 'Update' conflict: the scanned card, the owned versions it could replace, and how many copies to swap. */
interface ReplacePlan {
  conflict: ImportConflict;
  /** Owned variants eligible to be the copy swapped out (excludes any exact match of the scanned printing). */
  candidates: CollectionEntry[];
  /** Copies to convert = min(scanned qty, owned candidate qty). */
  need: number;
}

/** In-progress 'Update' resolution: removals decided so far, plus the queue of ambiguous picks left. */
interface ReplaceFlow {
  lines: ResolvedLine[];
  choices: Map<string, ConflictChoice>;
  /** 'Update' conflicts with nothing distinct to replace — their scanned lines are dropped (no-op). */
  noSource: Set<string>;
  removals: { id: string; qty: number }[];
  queue: ReplacePlan[];
  idx: number;
}

/**
 * Which owned copies a swap draws from: the chosen version first, then the rest
 * (so a scan of N copies still nets out even if the picked version holds fewer).
 */
function planRemovals(plan: ReplacePlan, chosenId?: string): { id: string; qty: number }[] {
  const order = [
    ...plan.candidates.filter((e) => e.id === chosenId),
    ...plan.candidates.filter((e) => e.id !== chosenId),
  ];
  let need = plan.need;
  const out: { id: string; qty: number }[] = [];
  for (const e of order) {
    if (need <= 0) break;
    const take = Math.min(need, e.quantity);
    if (take > 0) {
      out.push({ id: e.id, qty: take });
      need -= take;
    }
  }
  return out;
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

/** Which boards a scan can target: storage has one pile, decks have boards
 *  (and the command zone only in Commander). */
function deckBoards(target: { containerKind?: ContainerKind; format?: DeckFormat }): DeckBoard[] {
  if ((target.containerKind ?? 'deck') !== 'deck') return ['main'];
  return target.format === 'commander' ? ['main', 'side', 'commander'] : ['main', 'side'];
}

/** "deck" / "binder" / "box" for a container target; the target's own name otherwise. */
function targetNoun(target: ScanTarget): string {
  if (target.kind === 'deck') return CONTAINER_META[target.containerKind ?? 'deck'].noun;
  return target.kind === 'trade' ? 'offer' : target.kind;
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

// A scan session survives an accidental reload: it's mirrored to localStorage
// keyed by its destination and only cleared when the user commits or discards
// it. Trade offers are in-memory (the offer itself is gone after a reload), so
// there's nothing to restore — those aren't persisted.
function sessionStorageKey(target: ScanTarget): string | null {
  switch (target.kind) {
    case 'collection':
      return 'scan-session:collection';
    case 'tradelist':
      return 'scan-session:tradelist';
    case 'wishlist':
      return 'scan-session:wishlist';
    case 'deck':
      return `scan-session:deck:${target.deckId}`;
    case 'trade':
      return null;
  }
}

function loadStoredSession(key: string | null): SessionEntry[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SessionEntry =>
        !!e && typeof e.scryfallId === 'string' && typeof e.oracleId === 'string' && typeof e.qty === 'number',
    );
  } catch {
    return [];
  }
}

/**
 * Tray order: the OCR-confirmed printing stays first, then editions the user
 * already owns bubble up (so their double-check badge is the first thing in
 * view), then the scanner's own distance order. Array.sort is stable, so equal
 * items keep that distance order.
 */
function orderTrayCandidates(tray: Tray, ownership?: OwnershipIndex): Candidate[] {
  const isHit = (c: Candidate) => (tray.ocrHit === c.scryfallId ? 0 : 1);
  const ownsExact = (c: Candidate) => (ownership?.lookup(c.oracle?.oracleId ?? '', c.scryfallId).ownsExact ? 0 : 1);
  return [...tray.candidates].sort((a, b) => isHit(a) - isHit(b) || ownsExact(a) - ownsExact(b));
}

export function ScanSheet({ target = { kind: 'collection' }, onClose }: { target?: ScanTarget; onClose: () => void }) {
  const storageKey = sessionStorageKey(target);
  const [stage, setStage] = useState<Stage>({ kind: 'setup', message: 'Checking scan data…' });
  const [live, setLive] = useState<LiveScanState | null>(null);
  const [tray, setTray] = useState<Tray | null>(null);
  // Restore a previous scan for this destination that a reload interrupted.
  const [session, setSession] = useState<SessionEntry[]>(() => loadStoredSession(storageKey));
  const [listOpen, setListOpen] = useState(false);
  const [fx, setFx] = useState<TapFx | null>(null);
  const [foil, setFoil] = useState(false);
  const [board, setBoard] = useState<DeckBoard>('main');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // When on, pinpointing an edition (OCR confirms the printing, the green check)
  // adds +1 of it on its own. Persisted so the preference sticks between scans.
  const [autoAdd, setAutoAdd] = useState(() => localStorage.getItem('scan-autoadd') === '1');
  // True while the session is being written — guards against the double-tap
  // that used to commit the whole scan twice (adding two copies of everything).
  const [committing, setCommitting] = useState(false);
  // Set when a collection/tradelist commit finds cards already owned: the
  // skip/add/replace resolution screen (reused from import) shows until resolved.
  const [conflictStep, setConflictStep] = useState<{ lines: ResolvedLine[]; conflicts: ImportConflict[] } | null>(null);
  // Set when one or more 'Update' choices are ambiguous (you own the card in
  // more than one version): the "which copy to replace?" picks run one at a
  // time (with a counter) before the collection commit fires.
  const [replaceFlow, setReplaceFlow] = useState<ReplaceFlow | null>(null);
  // Deck re-scan review: the computed diff + which of the two review phases
  // ('changes' → 'collection') is showing, plus the ticked unowned cards.
  const [rescanStep, setRescanStep] = useState<RescanReview | null>(null);
  const [rescanPhase, setRescanPhase] = useState<'changes' | 'collection'>('changes');
  const [rescanPicked, setRescanPicked] = useState<Set<string>>(new Set());
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraScan | null>(null);
  const closedRef = useRef(false);
  // The live hash index, so a lock can re-check owned printings' scan distance.
  const indexRef = useRef<ScanIndex | null>(null);
  const trayRef = useRef<Tray | null>(null);
  const fxSeq = useRef(0);
  // The last lock we auto-added for, so a confirmed edition adds itself once.
  const autoAddedRef = useRef<string | null>(null);
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
    indexRef.current = index;
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

  // Mirror the session to storage so an accidental reload doesn't lose it, and
  // clear the mirror when it empties. Best-effort: a full data-URI fixture card
  // can blow the quota, which is fine — this is a convenience, not a guarantee.
  useEffect(() => {
    if (!storageKey) return;
    try {
      if (session.length === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(session));
    } catch {
      /* quota exceeded — skip persisting this session */
    }
  }, [session, storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem('scan-autoadd', autoAdd ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [autoAdd]);

  // Tell the user once if a previous scan was restored after a reload.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const restored = session.reduce((n, e) => n + e.qty, 0);
    if (restored > 0) toast(`Restored ${restored} card${restored === 1 ? '' : 's'} from your last scan`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearStored = () => {
    if (!storageKey) return;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

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

    // Cards with a swarm of same-art printings (Command Tower!) can push the
    // very edition you own past the search's top-N. So re-check the printings
    // you own of the matched card(s) directly, and splice in any whose art
    // still matches this scan (within the candidate cutoff) — orderTrayCandidates
    // then floats them to the front by their owned badge.
    const idx = indexRef.current;
    const own = ownershipRef.current;
    if (idx && own) {
      const have = new Set(ids);
      const ownedIds = new Set<string>();
      for (const oracleId of new Set([...printings.values()].map((p) => p.oracleId))) {
        for (const sid of own.ownedPrintings(oracleId)) if (!have.has(sid)) ownedIds.add(sid);
      }
      const extra = [...distancesForIds(idx, result.hash, ownedIds)].filter(([, d]) => d <= CANDIDATE_MAX_DISTANCE[idx.algo]);
      if (extra.length) {
        const extraPrintings = await getPrintingsByIds(extra.map(([id]) => id));
        for (const [id, distance] of extra) {
          const printing = extraPrintings.get(id);
          // Same oracle as a top match, so its OracleCard is already loaded.
          candidates.push({ scryfallId: id, distance, printing, oracle: printing && oracles.get(printing.oracleId) });
        }
      }
    }

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
      // Rising pop: pitch climbs a semitone per copy already piled up.
      playPop(countOf(c.scryfallId));
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

  // Auto-add: once OCR pinpoints the edition for a lock (the green check on the
  // tile), drop +1 of it into the session — one add per lock, guarded by the ref.
  useEffect(() => {
    if (!autoAdd || !tray || !tray.ocrHit) return;
    if (tray.ocr !== 'confirmed' && tray.ocr !== 'weak') return;
    if (autoAddedRef.current === tray.topId) return;
    autoAddedRef.current = tray.topId;
    const hit = tray.candidates.find((c) => c.scryfallId === tray.ocrHit);
    if (hit) bump(hit, 1, tray.lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray, autoAdd]);

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
    clearStored();
    cameraRef.current?.stop();
    onClose();
  };

  /**
   * Commit the collection/tradelist lines, honoring the conflict screen's
   * per-card choices. 'trade' (tradelist only) flags copies already owned for
   * trade without adding any; 'skip' drops the line. 'add' stacks a new copy.
   * 'replace' ("Update") swaps one owned copy for the scanned printing without
   * changing your count: unambiguous swaps resolve here; when you own the card
   * in more than one version, the pick is deferred to the ReplaceCopySheet
   * queue and the commit runs once every pick is in.
   */
  const commitLines = async (
    lines: ResolvedLine[],
    choices: Map<string, ConflictChoice>,
    conflicts: ImportConflict[] = [],
  ) => {
    const plans: ReplacePlan[] = conflicts
      .filter((c) => choices.get(c.oracleId) === 'replace')
      .map((c) => {
        // A version identical to what was scanned isn't something to swap out.
        const scannedKeys = new Set(c.incoming.map((l) => collectionKey(l)));
        const candidates = c.existing.filter((e) => e.quantity > 0 && !scannedKeys.has(collectionKey(e)));
        const scanQty = c.incoming.reduce((s, l) => s + l.quantity, 0);
        const ownedQty = candidates.reduce((s, e) => s + e.quantity, 0);
        return { conflict: c, candidates, need: Math.min(scanQty, ownedQty) };
      });
    // Nothing distinct to replace → "Update" is a no-op; don't add the scan either.
    const noSource = new Set(plans.filter((p) => p.need === 0).map((p) => p.conflict.oracleId));
    const autoRemovals = plans
      .filter((p) => p.need > 0 && p.candidates.length === 1)
      .flatMap((p) => planRemovals(p, p.candidates[0]!.id));
    const queue = plans.filter((p) => p.need > 0 && p.candidates.length >= 2);

    if (queue.length === 0) {
      await commitCollection(lines, choices, autoRemovals, noSource);
      return;
    }
    setReplaceFlow({ lines, choices, noSource, removals: autoRemovals, queue, idx: 0 });
  };

  /** Final write for a collection/tradelist scan once every 'Update' pick is resolved. */
  const commitCollection = async (
    lines: ResolvedLine[],
    choices: Map<string, ConflictChoice>,
    removals: { id: string; qty: number }[],
    noSource: Set<string>,
  ) => {
    const tradeReqs = lines.filter((l) => choices.get(l.oracleId) === 'trade');
    const importLines = lines.filter((l) => {
      const c = choices.get(l.oracleId);
      if (c === 'skip' || c === 'trade') return false;
      return !noSource.has(l.oracleId);
    });

    const flagged = tradeReqs.length
      ? await markOwnedForTrade(
          tradeReqs.map((l) => ({ oracleId: l.oracleId, scryfallId: l.scryfallId, condition: l.condition, finish: l.finish, lang: l.lang, quantity: l.quantity })),
          { source: 'scan' },
        )
      : 0;
    const added = importLines.length ? (await applyImport(importLines, { source: 'scan', removals })).cards : 0;

    const n = added + flagged;
    toast(n === 0 ? 'Nothing added: every card was skipped' : `Added ${n} card${n === 1 ? '' : 's'} to ${targetLabel(target)}`);
    finishScan();
  };

  /**
   * Deck re-scan: collapse the session to deck slots (oracle + board, since
   * decks store no finish/condition/lang), diff it against the deck's current
   * contents, and list any scanned printing not in the collection.
   */
  /** Scanned printings you don't own a single copy of yet (physical scans are usually in hand). */
  const computeUnowned = async (): Promise<SessionEntry[]> => {
    const scryfallIds = [...new Set(session.map((e) => e.scryfallId))];
    const owned = await db.collection.where('scryfallId').anyOf(scryfallIds).toArray();
    const ownedSet = new Set(owned.filter((e) => e.quantity > 0).map((e) => e.scryfallId));
    return session.filter((e) => !ownedSet.has(e.scryfallId));
  };

  const buildRescanReview = async (deckId: string): Promise<RescanReview> => {
    const slotMap = new Map<string, RescanSlot>();
    for (const e of session) {
      const key = `${e.oracleId}|${e.board}`;
      const cur = slotMap.get(key);
      if (cur) cur.quantity += e.qty;
      else slotMap.set(key, { oracleId: e.oracleId, board: e.board, quantity: e.qty, scryfallId: e.scryfallId, name: e.name, image: e.image });
    }
    const current = await db.deckCards.where('deckId').equals(deckId).toArray();
    const oracleMap = await getOracleCardsByIds(current.map((c) => c.oracleId));
    const curMap = new Map(current.map((c) => [`${c.oracleId}|${c.board}`, c]));

    const changes: DeckChange[] = [];
    for (const [key, s] of slotMap) {
      const cur = curMap.get(key);
      if (!cur) changes.push({ kind: 'add', oracleId: s.oracleId, board: s.board, name: s.name, image: s.image, quantity: s.quantity });
      else if (cur.quantity !== s.quantity)
        changes.push({ kind: 'change', oracleId: s.oracleId, board: s.board, name: s.name, image: s.image, from: cur.quantity, to: s.quantity });
    }
    for (const [key, cur] of curMap) {
      if (slotMap.has(key)) continue;
      changes.push({ kind: 'remove', oracleId: cur.oracleId, board: cur.board, name: oracleMap.get(cur.oracleId)?.name ?? 'Unknown card', quantity: cur.quantity });
    }

    // "Not in your collection" = you don't own that exact printing at all.
    const unowned = await computeUnowned();

    return { slots: [...slotMap.values()], changes, unowned };
  };

  /**
   * Apply the reviewed deck write, then add the ticked unowned cards to the collection.
   * Re-scan reconciles the deck to exactly the scan; a regular scan just appends the cards.
   */
  const applyRescan = async () => {
    if (!rescanStep || committing || target.kind !== 'deck') return;
    setCommitting(true);
    try {
      const r = rescanStep;
      if (target.rescan) {
        await reconcileDeck(
          target.deckId,
          r.slots.map((s) => ({ oracleId: s.oracleId, board: s.board, quantity: s.quantity, scryfallId: s.scryfallId })),
          { source: 'scan' },
        );
      } else {
        await addDeckCardsBulk(
          target.deckId,
          session.map((e) => ({ oracleId: e.oracleId, scryfallId: e.scryfallId, board: e.board, quantity: e.qty })),
          { source: 'scan' },
        );
      }
      const toAdd = r.unowned.filter((e) => rescanPicked.has(entryKey(e)));
      if (toAdd.length) {
        await applyImport(
          toAdd.map((e) => ({ oracleId: e.oracleId, scryfallId: e.scryfallId, condition: e.condition, finish: e.finish, lang: e.lang, quantity: e.qty, quantityForTrade: 0 })),
          { source: 'scan' },
        );
      }
      const addedToColl = toAdd.reduce((n, e) => n + e.qty, 0);
      const collSuffix = addedToColl ? ` · ${addedToColl} added to collection` : '';
      toast(
        target.rescan
          ? `Updated ${targetLabel(target)}${collSuffix}`
          : `Added ${total} card${total === 1 ? '' : 's'} to ${targetLabel(target)}${collSuffix}`,
      );
      finishScan();
    } finally {
      setCommitting(false);
    }
  };

  /** Write the whole session to the target and leave the scanner. */
  const complete = async () => {
    if (committing || session.length === 0) return;
    // Deck re-scan reconciles instead of adding: build the diff and route into
    // the two-step review (deck changes, then unowned-card collection prompt).
    if (target.kind === 'deck' && target.rescan) {
      const review = await buildRescanReview(target.deckId);
      if (review.changes.length === 0 && review.unowned.length === 0) {
        toast(`No changes — this ${targetNoun(target)} already matches your scan`);
        finishScan();
        return;
      }
      setRescanPicked(new Set(review.unowned.map((e) => entryKey(e))));
      setRescanPhase(review.changes.length === 0 ? 'collection' : 'changes');
      setRescanStep(review);
      return;
    }
    // Regular deck scan: physical cards are usually in hand, so — like re-scan —
    // offer to also register any scanned printing you don't own in your collection.
    // The deck append itself is deferred to applyRescan so both writes land together.
    if (target.kind === 'deck') {
      const unowned = await computeUnowned();
      if (unowned.length > 0) {
        setRescanPicked(new Set(unowned.map((e) => entryKey(e))));
        setRescanPhase('collection');
        setRescanStep({ slots: [], changes: [], unowned });
        return;
      }
    }
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
    clearStored();
    cameraRef.current?.stop();
    onClose();
  };

  /** Session copies of a printing across finishes/boards — the tile's badge. */
  const countOf = (scryfallId: string) => session.reduce((n, e) => (e.scryfallId === scryfallId ? n + e.qty : n), 0);

  const ownership = useOwnershipIndex();
  // onLocked is captured once (mount), but ownership loads/changes later — read
  // it through a ref so a lock always sees the current collection.
  const ownershipRef = useRef(ownership);
  useEffect(() => {
    ownershipRef.current = ownership;
  }, [ownership]);

  return createPortal(
    <div className="scan-screen" role="dialog" aria-label="Scan cards">
      <div className="scan-camera">
        <video ref={videoRef} className="scan-camera-video" playsInline autoPlay muted />

        <div className="scan-cam-top">
          <button className="scan-cam-btn" onClick={close} aria-label="Close scanner">
            <Icon name="close" />
          </button>
          <span className="scan-cam-target">
            {target.kind === 'deck' && target.rescan ? (
              <>
                <Icon name="refresh" size={13} /> {targetLabel(target)}
              </>
            ) : (
              <>→ {targetLabel(target)}</>
            )}
          </span>
          {stage.kind === 'scanning' && (
            <button
              className={settingsOpen ? 'scan-cam-btn scan-cam-btn-on' : 'scan-cam-btn'}
              style={{ marginLeft: 'auto' }}
              onClick={() => setSettingsOpen((o) => !o)}
              aria-label="Scan settings"
              aria-pressed={settingsOpen}
            >
              <Icon name="settings" />
            </button>
          )}
        </div>

        {settingsOpen && stage.kind === 'scanning' && (
          <div className="scan-settings" role="group" aria-label="Scan settings">
            <label className="scan-setting">
              <span>
                <strong>Auto-add pinpointed edition</strong>
                <small>When the edition is confirmed (green check), add +1 on its own</small>
              </span>
              <input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} />
            </label>
            {finishMatters(target) && (
              <label className="scan-setting">
                <span>
                  <strong>Foil pile</strong>
                  <small>Scanning a stack of foils? Every card you add is marked as foil</small>
                </span>
                <input type="checkbox" checked={foil} onChange={(e) => setFoil(e.target.checked)} />
              </label>
            )}
          </div>
        )}

        <div className="scan-cam-side">
          <button className="scan-cam-btn" onClick={openList} aria-label={`Review ${total} scanned cards`}>
            <Icon name="list" />
            {total > 0 && <span className="scan-cam-badge">{total}</span>}
          </button>
          {finishMatters(target) && foil && (
            <span className="scan-cam-chip scan-cam-chip-on" aria-hidden>
              Foil pile
            </span>
          )}
        </div>

        {target.kind === 'deck' && deckBoards(target).length > 1 && stage.kind === 'scanning' && (
          <div className="seg-row scan-cam-board" role="radiogroup" aria-label="Add to board">
            {deckBoards(target).map((b) => (
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
          orderTrayCandidates(tray, ownership).map((c) => (
            <TrayTile
              key={c.scryfallId}
              candidate={c}
              count={countOf(c.scryfallId)}
              confirmed={tray.ocrHit === c.scryfallId && (tray.ocr === 'confirmed' || tray.ocr === 'weak')}
              owned={ownedBadge(ownership?.lookup(c.oracle?.oracleId ?? '', c.scryfallId))}
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
        !replaceFlow &&
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
                      : [
                          { value: 'skip', label: 'Skip' },
                          { value: 'add', label: 'Add' },
                          { value: 'replace', label: 'Update' },
                        ]
                  }
                  defaultChoice={toTradelist ? 'trade' : 'add'}
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
                    ) : (
                      <>
                        {nConflicts} scanned card{nConflicts === 1 ? '' : 's'} {nConflicts === 1 ? 'is' : 'are'} already in your
                        collection (any printing counts). Per card: <strong>Add</strong> adds the scanned copy as a new one,{' '}
                        <strong>Update</strong> swaps one copy you already own for the scanned printing (your total stays the same
                        &mdash; you&rsquo;ll pick which copy if you own more than one version), <strong>Skip</strong> changes nothing.
                        {otherCount > 0 && (
                          <>
                            {' '}
                            The other {otherCount} card{otherCount === 1 ? '' : 's'} you don&rsquo;t own yet {otherCount === 1 ? 'is' : 'are'}{' '}
                            added either way.
                          </>
                        )}
                      </>
                    )
                  }
                  confirmLabel={(n) => (n === 0 ? 'Nothing to add' : `Add ${n} card${n === 1 ? '' : 's'} to ${targetLabel(target)}`)}
                  onConfirm={(choices) => commitLines(conflictStep.lines, choices, conflictStep.conflicts)}
                  onBack={() => setConflictStep(null)}
                />
              </div>
            </div>
          );
        })()}

      {replaceFlow &&
        (() => {
          const plan = replaceFlow.queue[replaceFlow.idx]!;
          return (
            <ReplaceCopySheet
              plan={plan}
              index={replaceFlow.idx}
              total={replaceFlow.queue.length}
              busy={committing}
              onPick={(entryId) => {
                const removals = [...replaceFlow.removals, ...planRemovals(plan, entryId)];
                const nextIdx = replaceFlow.idx + 1;
                if (nextIdx >= replaceFlow.queue.length) {
                  setReplaceFlow(null);
                  void commitCollection(replaceFlow.lines, replaceFlow.choices, removals, replaceFlow.noSource);
                } else {
                  setReplaceFlow({ ...replaceFlow, removals, idx: nextIdx });
                }
              }}
              onBack={() => setReplaceFlow(null)}
            />
          );
        })()}

      {rescanStep && target.kind === 'deck' && rescanPhase === 'changes' && (
        <RescanChangesSheet
          changes={rescanStep.changes}
          deckName={targetLabel(target)}
          showBoards={deckBoards(target).length > 1}
          busy={committing}
          nextLabel={rescanStep.unowned.length > 0 ? 'Next' : `Apply ${rescanStep.changes.length} change${rescanStep.changes.length === 1 ? '' : 's'}`}
          onNext={() => (rescanStep.unowned.length > 0 ? setRescanPhase('collection') : void applyRescan())}
          onBack={() => setRescanStep(null)}
        />
      )}

      {rescanStep && target.kind === 'deck' && rescanPhase === 'collection' && (
        <RescanCollectionSheet
          entries={rescanStep.unowned}
          picked={rescanPicked}
          busy={committing}
          hasChanges={rescanStep.changes.length > 0}
          onToggle={(key) =>
            setRescanPicked((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onToggleAll={() =>
            setRescanPicked((prev) =>
              prev.size === rescanStep.unowned.length ? new Set() : new Set(rescanStep.unowned.map((e) => entryKey(e))),
            )
          }
          onBack={() => (rescanStep.changes.length > 0 ? setRescanPhase('changes') : setRescanStep(null))}
          onConfirm={() => void applyRescan()}
        />
      )}
    </div>,
    document.body,
  );
}

/** Deck re-scan step 1: the add/remove/quantity diff, before anything is written. */
function RescanChangesSheet({
  changes,
  deckName,
  showBoards,
  busy,
  nextLabel,
  onNext,
  onBack,
}: {
  changes: DeckChange[];
  deckName: string;
  /** Decks split into boards; a binder or box is one pile, so the label is noise. */
  showBoards: boolean;
  busy: boolean;
  nextLabel: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const added = changes.filter((c) => c.kind === 'add');
  const changed = changes.filter((c) => c.kind === 'change');
  const removed = changes.filter((c) => c.kind === 'remove');
  const rows = [...added, ...changed, ...removed];
  return (
    <div className="sheet-backdrop" onClick={onBack}>
      <div className="sheet scan-list-sheet" role="dialog" aria-label="Re-scan changes" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>Re-scan changes</h2>
          <span className="scan-target">→ {deckName}</span>
          <button className="scan-close" onClick={onBack} aria-label="Back">
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="fine-print">Sets “{deckName}” to exactly what you scanned. Cards left unchanged aren’t listed.</p>
        {rows.length === 0 ? (
          <p className="scan-list-empty">No card changes — only the collection add below.</p>
        ) : (
          <ul className="scan-list">
            {rows.map((c) => (
              <li key={`${c.kind}|${c.oracleId}|${c.board}`} className="scan-list-row">
                <span className="scan-list-main scan-list-static">
                  {c.image ? <img className="scan-list-thumb" src={c.image} alt="" /> : <span className="scan-list-thumb" />}
                  <span className="scan-list-info">
                    <strong>{c.name}</strong>
                    {showBoards && <span className="scan-printing">{BOARD_LABELS[c.board]}</span>}
                  </span>
                </span>
                {c.kind === 'add' && <span className="rescan-tag rescan-add">Added ×{c.quantity}</span>}
                {c.kind === 'remove' && <span className="rescan-tag rescan-remove">Removed ×{c.quantity}</span>}
                {c.kind === 'change' && (
                  <span className={`rescan-tag ${c.to > c.from ? 'rescan-add' : 'rescan-remove'}`}>
                    {c.from} → {c.to}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="scan-confirm-actions">
          <button className="primary" disabled={busy} onClick={onNext}>
            {busy ? 'Applying…' : nextLabel}
          </button>
          <button onClick={onBack} disabled={busy}>
            Keep scanning
          </button>
        </div>
      </div>
    </div>
  );
}

/** Deck re-scan step 2: offer to also add scanned cards you don't own to the collection. */
function RescanCollectionSheet({
  entries,
  picked,
  busy,
  hasChanges,
  onToggle,
  onToggleAll,
  onBack,
  onConfirm,
}: {
  entries: SessionEntry[];
  picked: Set<string>;
  busy: boolean;
  hasChanges: boolean;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const allPicked = picked.size === entries.length;
  const chosen = entries.filter((e) => picked.has(entryKey(e)));
  const chosenQty = chosen.reduce((n, e) => n + e.qty, 0);
  return (
    <div className="sheet-backdrop" onClick={onBack}>
      <div className="sheet scan-list-sheet" role="dialog" aria-label="Add scanned cards to collection" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>Add to collection?</h2>
          <button className="scan-close" onClick={onBack} aria-label={hasChanges ? 'Back' : 'Close'}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="fine-print">
          You scanned {entries.length} card{entries.length === 1 ? '' : 's'} you don’t own yet. Pick which to also add to your
          collection:
        </p>
        <div className="list-toolbar">
          <label className="chip" style={{ alignSelf: 'flex-start' }}>
            <input type="checkbox" checked={allPicked} onChange={onToggleAll} /> {allPicked ? 'Unselect all' : 'Select all'}
          </label>
          <span className="search-meta grow">
            {chosen.length} of {entries.length} selected
          </span>
        </div>
        <ul className="scan-list">
          {entries.map((e) => (
            <li key={entryKey(e)} className="scan-list-row">
              <label className="scan-list-main" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={picked.has(entryKey(e))} onChange={() => onToggle(entryKey(e))} />
                {e.image ? <img className="scan-list-thumb" src={e.image} alt="" /> : <span className="scan-list-thumb" />}
                <span className="scan-list-info">
                  <strong>{e.name}</strong>
                  <span className="scan-printing">
                    {e.set.toUpperCase()} #{e.collectorNumber} · {e.lang}
                    {e.finish === 'foil' ? ' · Foil' : ''}
                    {e.qty > 1 ? ` · ×${e.qty}` : ''}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="scan-confirm-actions">
          <button className="primary" disabled={busy} onClick={onConfirm}>
            {busy ? 'Applying…' : chosenQty > 0 ? `Apply · add ${chosenQty} to collection` : 'Apply without adding'}
          </button>
          <button onClick={onBack} disabled={busy}>
            {hasChanges ? 'Back' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "Update" follow-up: when you own the scanned card in more than one version,
 * pick which owned copy the scanned printing swaps in for. One card at a time,
 * with a counter when several are queued. The total for the card never changes.
 */
function ReplaceCopySheet({
  plan,
  index,
  total,
  busy,
  onPick,
  onBack,
}: {
  plan: ReplacePlan;
  index: number;
  total: number;
  busy: boolean;
  onPick: (entryId: string) => void;
  onBack: () => void;
}) {
  const [picked, setPicked] = useState<string>('');
  const [printings, setPrintings] = useState<Map<string, Priced<Printing>>>(new Map());

  // Fresh default selection (and label lookup) whenever the queue advances.
  useEffect(() => {
    setPicked(plan.candidates[0]?.id ?? '');
    const ids = [...plan.candidates.map((e) => e.scryfallId), ...plan.conflict.incoming.map((l) => l.scryfallId)];
    void getPrintingsByIds(ids).then(setPrintings);
  }, [plan]);

  const describe = (v: { scryfallId: string; condition: Condition; finish: Finish; lang: string }) => {
    const p = printings.get(v.scryfallId);
    const parts: string[] = [];
    if (p) parts.push(`${p.set.toUpperCase()} #${p.collectorNumber}`);
    parts.push(v.condition);
    if (v.finish !== 'nonfoil') parts.push(v.finish);
    if (v.lang && v.lang !== 'en') parts.push(v.lang);
    return parts.join(' · ');
  };
  const scanned = plan.conflict.incoming.map((l) => describe(l)).join(', ');

  return (
    <div className="sheet-backdrop" onClick={onBack}>
      <div className="sheet scan-list-sheet" role="dialog" aria-label="Which copy to replace" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>Which copy to replace?</h2>
          {total > 1 && (
            <span className="scan-target">
              {index + 1} / {total}
            </span>
          )}
          <button className="scan-close" onClick={onBack} aria-label="Cancel">
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="fine-print">
          You own <strong>{plan.conflict.name}</strong> in more than one version. Pick the copy the scanned{' '}
          {scanned ? <em>{scanned}</em> : 'printing'} should replace — one copy is swapped out, so your total for this card
          stays the same.
        </p>
        <ul className="scan-list">
          {plan.candidates.map((e) => (
            <li key={e.id} className="scan-list-row">
              <label className="scan-list-main" style={{ cursor: 'pointer' }}>
                <input type="radio" name="replace-copy" checked={picked === e.id} onChange={() => setPicked(e.id)} />
                <span className="scan-list-info">
                  <strong>{describe(e)}</strong>
                  <span className="scan-printing">You own ×{e.quantity}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="scan-confirm-actions">
          <button className="primary" disabled={busy || !picked} onClick={() => onPick(picked)}>
            {index + 1 < total ? 'Next' : 'Replace'}
          </button>
          <button onClick={onBack} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function TrayTile({
  candidate: c,
  count,
  confirmed,
  owned,
  fx,
  onBump,
}: {
  candidate: Candidate;
  count: number;
  confirmed: boolean;
  owned: OwnedBadgeSpec | null;
  fx: TapFx | null;
  onBump: (delta: 1 | -1) => void;
}) {
  const name = c.oracle?.name ?? 'Unknown card';
  return (
    <div className="scan-tile">
      <div className="scan-tile-card">
        {c.printing?.imageNormal ? <img src={c.printing.imageNormal} alt={name} /> : <div className="scan-tile-ph">{name}</div>}
        {owned && (
          <span className={`tile-badge ${owned.cls}`} title={owned.title}>
            {owned.icon}
          </span>
        )}
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
      <span className="scan-tile-caption">
        {c.printing ? (
          <>
            <SetSymbol set={c.printing.set} className="scan-tile-set" title={c.printing.setName} />
            {c.printing.set.toUpperCase()} #{c.printing.collectorNumber}
          </>
        ) : (
          '—'
        )}
      </span>
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
    const boards = deckBoards(target);
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
                {target.kind === 'deck' && deckBoards(target).length > 1 && (
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
            {busy
              ? 'Adding…'
              : target.kind === 'deck' && target.rescan
                ? `Review changes to ${targetLabel(target)}`
                : `Add ${total} card${total === 1 ? '' : 's'} to ${targetLabel(target)}`}
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
