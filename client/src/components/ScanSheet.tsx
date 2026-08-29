import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Condition, ContainerKind, DeckBoard, DeckFormat, Finish, OracleCard, Printing, Priced } from '@mtg/shared';
import { CONDITIONS, FINISHES } from '@mtg/shared';
import { addToWishlistBulk, reconcileDeck } from '../db/dataAccess.js';
import { db } from '../db/schema.js';
import {
  getOracleCard,
  getOracleCardsByIds,
  getPrinting,
  getPrintingForSet,
  getPrintingsByIds,
  getPrintingsForOracle,
} from '../db/queries.js';
import { ImportConflicts } from '../import/ImportConflicts.js';
import { findImportConflicts, type ConflictChoice, type ImportConflict } from '../import/conflicts.js';
import { commitResolvedLines, filingCopiesFor } from '../import/commit.js';
import { useReplaceFlow } from '../import/useReplaceFlow.js';
import { UnownedPromptSheet, type UnownedCard } from './UnownedPromptSheet.js';
import { useFileThese } from '../deck/useFileThese.js';
import type { ResolvedLine } from '../import/types.js';
import { CardSheet, FINISH_LABELS, LANGS, type SessionCardValues } from './CardSheet.js';
import { filterScanIndex, parseHashBlob, type ScanIndex } from '../scan/blob.js';
import { getScanExcludedIds } from '../scan/exclusions.js';
import {
  CameraScan,
  CONSENSUS_FRAMES,
  getPreferredCameraId,
  listCameras,
  type CameraOption,
  type LiveScanState,
} from '../scan/camera.js';
import type { ScanPipelineResult } from '../scan/pipeline.js';
import { CANDIDATE_MAX_DISTANCE, distancesForIds } from '../scan/match.js';
import { resolveWithOcr } from '../scan/ocr.js';
import { playPop } from '../scan/pop.js';
import { checkScanDataUpdate, downloadScanData, getUsableScanData, type ScanDataManifest } from '../scan/store.js';
import { getPrefs, setPrefs } from '../prefs.js';
import { Icon } from './icons.js';
import { SetSymbol } from './SetSymbol.js';
import { EditionPicker } from './EditionPicker.js';
import { useToast } from './Toast.js';
import { ownedBadge, type OwnedBadgeSpec } from './OwnedBadge.js';
import { CONTAINER_META } from '../deck/containers.js';
import { useOwnershipIndex, type OwnershipIndex } from '../db/useOwnership.js';
import { useDismiss } from './useDismiss.js';
import { useConfirm } from './ConfirmSheet.js';
import { TAP_GUARD_MS, useTapGuard } from './useTapGuard.js';
import { useFiling } from '../deck/useFiling.js';
import { unfileClashes, type FilingCopy } from '../deck/filing.js';
import { useAsyncAction } from './useAsyncAction.js';
import { CardStacks, ViewToggle, useScanViewMode, type CardItem } from './CardViews.js';
import { formatPrice, pricedForFinish } from './cardSort.js';
import { useCardMaps } from '../db/useCardMaps.js';

// Camera scanning flow (handover §S5), built for one-handed binder entry: the
// camera fills the top of the screen and never pauses; each lock (S3 consensus
// + S4 OCR) fills a horizontal candidate tray along the bottom. Tapping a
// candidate's top half adds +1 to a session list, the bottom half takes one
// back — no scrolling, no per-card confirm step. A slim picker bar above the
// tray carries the finish/condition/language of the card in frame (changing one
// also re-tags what this lock already added, so noticing the foil after tapping
// costs nothing), and the scan settings can pin the language, finish or set for
// a prepared pile. A list button reviews and edits the session; completing it
// writes everything to the target at once.
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
  /** From the picker bar (deck slots store no finish, so they ignore it). */
  finish: Finish;
  /** From the picker bar. A trade offer prices by condition, so it carries. */
  condition: Condition;
  /** From the picker bar: what OCR read, or the pinned pile language. */
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
  // The whole session lands in one call: an offer is committed as a single
  // snapshot, so adding card-by-card would have each add overwrite the last.
  // `sessionKey` scopes the persisted scan to one trade + side, so a restored
  // scan can never land in somebody else's offer.
  | { kind: 'trade'; label?: string; sessionKey?: string; onAdd: (cards: ScannedCard[]) => void };

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
  /** Bumped once per accepted lock, so a second copy of the same card (same
   *  topId) still counts as a new tray for anything that rewinds on one. */
  seq: number;
  /** Top candidate of the lock that produced this tray — dedups re-locks of the same card. */
  topId: string;
  candidates: Candidate[];
  ocr: OcrState;
  /** The candidate OCR confirmed (or weakly matched), if any. */
  ocrHit: string | null;
}

/**
 * How long a lock holds the tray before it goes stale (time to tap, and to fix
 * the pickers). Once stale, the *next* time the card leaves the frame the lock
 * lets go, so a second copy of the same card can lock again — the padlock badge
 * shows the time left and releases it on tap.
 */
const LOCK_HOLD_MS = 3000;
/** Consecutive card-free frames that count as "the card left the frame". More
 *  than one, so a blurred frame mid-tap can't be mistaken for a card swap. */
const EMPTY_FRAMES_TO_RELEASE = 5;
/**
 * How long the tray belongs to the user after they scroll or tap it: while it's
 * held, a new lock can't swap the row out from under the finger that is reaching
 * for a printing. Every further touch refreshes it, a thin bar drains it, and
 * taking the card out of frame hands it straight back.
 */
const TRAY_HOLD_MS = 4000;
/** Touch this recent counts as "still browsing", so the card leaving the frame
 *  doesn't cut the hold short mid-scroll. */
const TRAY_TOUCH_GRACE_MS = 1000;
/** Dead time after the tray's contents do change before a tap counts: a reorder
 *  landing a frame before your finger must not add the printing that slid in. */
const TRAY_SETTLE_MS = 200;

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
  /** From the tray's Condition picker (NM unless changed or locked). */
  condition: Condition;
  board: DeckBoard;
  qty: number;
}

/**
 * "I've prepared a pile" pins, set in the scan settings: every card added takes
 * that value and a new lock can't reset the picker out of it (OCR won't override
 * a pinned language either). `null` = pin off. The set pin holds a set code,
 * chosen from the editions of the card in frame — it used to arm itself from
 * whatever scanned next, which on a card with twenty reprints pinned the wrong
 * set more often than the right one.
 */
interface ScanLocks {
  lang: string | null;
  finish: Finish | null;
  set: string | null;
}

const NO_LOCKS: ScanLocks = { lang: null, finish: null, set: null };

/** Locks survive a reload (a pile takes more than one sitting); every active one
 *  shows as a chip over the camera, so a stale pin can't apply unnoticed. */
function loadLocks(): ScanLocks {
  try {
    const raw = localStorage.getItem('scan-locks');
    if (!raw) return NO_LOCKS;
    const p = JSON.parse(raw) as Partial<Record<keyof ScanLocks, unknown>>;
    return {
      lang: typeof p.lang === 'string' && LANGS.includes(p.lang) ? p.lang : null,
      finish: FINISHES.includes(p.finish as Finish) ? (p.finish as Finish) : null,
      // '' was the old "waiting for the next card" state; there is no such
      // thing now, and a blank pin would filter nothing while showing a chip.
      set: typeof p.set === 'string' && p.set ? p.set : null,
    };
  } catch {
    return NO_LOCKS;
  }
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
  /** Scanned cards you own no copy of, in any printing — offered as a tick-list add. */
  unowned: SessionEntry[];
  /** Scanned cards already in the collection — offered the import's per-card Skip/Add/Update. */
  conflicts: ImportConflict[];
}

/** The review steps a container scan walks before anything is written (empty ones are skipped). */
type ReviewPhase = 'changes' | 'collection' | 'owned';

/** What the picker bar decides: applied to every +1, and to this lock's adds when changed. */
interface PickValues {
  finish: Finish;
  condition: Condition;
  lang: string;
}

// Language is part of the key (collectionKey has it too): scanning a card in
// Japanese and later the same card in English must stay two lines, not merge
// into whichever one landed first.
const entryKey = (e: Pick<SessionEntry, 'scryfallId' | 'finish' | 'condition' | 'lang' | 'board'>) =>
  `${e.scryfallId}|${e.finish}|${e.condition}|${e.lang}|${e.board}`;

/** A scanned line, described for the "add these to your collection too?" tick-list. */
const unownedCard = (e: SessionEntry): UnownedCard => ({
  key: entryKey(e),
  name: e.name,
  ...(e.image ? { image: e.image } : {}),
  sub: [
    `${e.set.toUpperCase()} #${e.collectorNumber}`,
    e.lang,
    e.finish !== 'nonfoil' ? FINISH_LABELS[e.finish] : null,
    e.condition !== 'NM' ? e.condition : null,
    e.qty > 1 ? `×${e.qty}` : null,
  ]
    .filter(Boolean)
    .join(' · '),
  qty: e.qty,
});

/** Session entries as filing-engine copies: a scan names every trait, so each one claims the exact physical copy it saw. */
function scanCopies(entries: SessionEntry[]): FilingCopy[] {
  return entries.map((e) => ({
    oracleId: e.oracleId,
    scryfallId: e.scryfallId,
    quantity: e.qty,
    board: e.board,
    wants: { condition: e.condition, finish: e.finish, lang: e.lang },
    label: e.name,
    sub: [e.set, e.condition, e.finish, e.lang !== 'en' ? e.lang : null].filter(Boolean).join(' · '),
  }));
}

/** Collapse duplicate (printing, finish, condition, language, board) lines after a row edit. */
function mergeSession(entries: SessionEntry[]): SessionEntry[] {
  const map = new Map<string, SessionEntry>();
  for (const e of entries) {
    const prev = map.get(entryKey(e));
    if (prev) prev.qty += e.qty;
    else map.set(entryKey(e), { ...e });
  }
  return [...map.values()];
}

/**
 * A wish is for a printing, not a graded copy, so its finish/condition/language
 * are wishes too: `undefined` means "any". The picker defaults (nonfoil, NM,
 * English) are what you get when you haven't said anything, so they map back to
 * "any" — anything else is a stated preference and is stored.
 */
function wishPreference<T extends string>(value: T, dflt: T): T | undefined {
  return value === dflt ? undefined : value;
}

/**
 * Set lock: only that set's printings are suggested — the point of scanning a
 * sealed-set pile. If the scan matched none of them the filter steps aside
 * rather than leaving an empty tray (the picker row says so).
 */
function filterBySet(candidates: Candidate[], set: string | null): Candidate[] {
  if (!set) return candidates;
  const hits = candidates.filter((c) => c.printing?.set === set);
  return hits.length ? hits : candidates;
}

/**
 * The single printing a candidate list names, or null when it names several —
 * what a set pin usually leaves standing. Foil and nonfoil siblings are one
 * printing here (same set, same collector number): which of them you're holding
 * is the finish picker's business, not the reader's, and the OCR scores them as
 * a tie for the same reason.
 */
function onePrinting(candidates: Candidate[]): Candidate | null {
  const first = candidates[0];
  if (!first?.printing) return null;
  const same = candidates.every(
    (c) => c.printing?.set === first.printing!.set && c.printing?.collectorNumber === first.printing!.collectorNumber,
  );
  return same ? first : null;
}

const BOARD_LABELS: Record<DeckBoard, string> = {
  main: 'mainboard',
  side: 'sideboard',
  commander: 'command zone',
  token: 'tokens',
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
// it. Every destination gets its own key — a re-scan is *not* the same session
// as an add (one reconciles the deck to exactly what was scanned, the other
// appends), and a trade scan belongs to one trade and one side of it.
const TRADE_SCAN_PREFIX = 'scan-session:trade:';

function sessionStorageKey(target: ScanTarget): string | null {
  switch (target.kind) {
    case 'collection':
      return 'scan-session:collection';
    case 'tradelist':
      return 'scan-session:tradelist';
    case 'wishlist':
      return 'scan-session:wishlist';
    case 'deck':
      return `scan-session:${target.rescan ? 'rescan' : 'deck'}:${target.deckId}`;
    case 'trade':
      return target.sessionKey ? `${TRADE_SCAN_PREFIX}${target.sessionKey}` : null;
  }
}

/**
 * Drop persisted trade scans that don't belong to trade `keep` (omit it to drop
 * all of them). An offer only exists inside its own trade, so a scan for one
 * that has finished — or that was walked away from — has nowhere left to land.
 */
export function clearTradeScanSessions(keep?: string): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(TRADE_SCAN_PREFIX)) continue;
      if (keep && k.startsWith(`${TRADE_SCAN_PREFIX}${keep}:`)) continue;
      doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* ignore */
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
 * Where auto-add stands for the card in frame. It runs behind the OCR, so the
 * status pill has to say what it is doing: a user who added the copy by hand
 * otherwise sits there waiting for a pinpoint that will never land.
 */
type AutoAddState = 'idle' | 'waiting' | 'added' | 'missed' | 'stopped';

const AUTO_ADD_NOTES: Record<AutoAddState, string | null> = {
  idle: null,
  waiting: 'Pinpointing edition…',
  added: 'Auto-added this edition',
  missed: 'Edition unclear: tap to add',
  stopped: 'Auto-add stopped: you added this one',
};

/**
 * Tray order: the OCR-confirmed printing stays first, then editions the user
 * already owns bubble up (so their double-check badge is the first thing in
 * view), then the scanner's own distance order. Array.sort is stable, so equal
 * items keep that distance order.
 *
 * Called once, when the tray is built, and stored in that order: deriving it on
 * every render meant a +1 (which makes you an owner of that printing) re-sorted
 * the row under the very finger that tapped it.
 */
function orderTrayCandidates(candidates: Candidate[], ocrHit: string | null, ownership?: OwnershipIndex): Candidate[] {
  const isHit = (c: Candidate) => (ocrHit === c.scryfallId ? 0 : 1);
  const ownsExact = (c: Candidate) => (ownership?.lookup(c.oracle?.oracleId ?? '', c.scryfallId).ownsExact ? 0 : 1);
  return [...candidates].sort((a, b) => isHit(a) - isHit(b) || ownsExact(a) - ownsExact(b));
}

export function ScanSheet({ target = { kind: 'collection' }, onClose }: { target?: ScanTarget; onClose: () => void }) {
  const commitAction = useAsyncAction();
  const storageKey = sessionStorageKey(target);
  const [stage, setStage] = useState<Stage>({ kind: 'setup', message: 'Checking scan data…' });
  // A newer card-art index is published and the user hasn't said whether we may
  // fetch it. Scanning carries on meanwhile with the copy already installed.
  const [refreshOffer, setRefreshOffer] = useState<ScanDataManifest | null>(null);
  const [rememberScanChoice, setRememberScanChoice] = useState(false);
  const [live, setLive] = useState<LiveScanState | null>(null);
  const [tray, setTray] = useState<Tray | null>(null);
  // Restore a previous scan for this destination that a reload interrupted.
  const [session, setSession] = useState<SessionEntry[]>(() => loadStoredSession(storageKey));
  const [listOpen, setListOpen] = useState(false);
  const [fx, setFx] = useState<TapFx | null>(null);
  // Pile pins (scan settings) and the values the card in frame is recorded with.
  // Unpinned, the pickers belong to that card: finish and condition fall back to
  // Nonfoil/NM on every new lock, and the language follows what OCR reads.
  const [locks, setLocks] = useState<ScanLocks>(loadLocks);
  const [finish, setFinish] = useState<Finish>(locks.finish ?? 'nonfoil');
  const [condition, setCondition] = useState<Condition>('NM');
  const [lang, setLang] = useState<string>(locks.lang ?? 'en');
  // When the current lock was taken, for the padlock badge's countdown ring
  // (null = no lock held, or it was released).
  const [lockAt, setLockAt] = useState<number | null>(null);
  const [lockNow, setLockNow] = useState(0);
  const [board, setBoard] = useState<DeckBoard>('main');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The sets the "set pile" pin can be pinned to: one printing per set of the
  // card in frame, the sets this scan actually matched first. Picking the set
  // from a list of the card's own editions is the whole point — arming the pin
  // from the top candidate pinned the wrong reprint half the time.
  const [setOptions, setSetOptions] = useState<{ matched: Priced<Printing>[]; others: Priced<Printing>[] }>({
    matched: [],
    others: [],
  });
  // The lenses this device offers, and which one is pinned ('' = let the OS
  // choose). Only enumerated once the settings are opened: labels stay blank
  // until camera permission has been granted anyway.
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState(() => getPreferredCameraId() ?? '');
  // When on, pinpointing an edition (OCR confirms the printing, the green check)
  // adds +1 of it on its own. Persisted so the preference sticks between scans.
  const [autoAdd, setAutoAdd] = useState(() => localStorage.getItem('scan-autoadd') === '1');
  // What auto-add is doing for the card in frame, for the status pill.
  const [autoState, setAutoState] = useState<AutoAddState>('idle');
  // True while the session is being written — guards against the double-tap
  // that used to commit the whole scan twice (adding two copies of everything).
  const [committing, setCommitting] = useState(false);
  // Set when a collection/tradelist commit finds cards already owned: the
  // skip/add/replace resolution screen (reused from import) shows until resolved.
  const [conflictStep, setConflictStep] = useState<{ lines: ResolvedLine[]; conflicts: ImportConflict[] } | null>(null);
  // Container scan review: the computed diff + which review phase is showing
  // ('changes' → 'collection' → 'owned'), plus the ticked unowned cards.
  const [rescanStep, setRescanStep] = useState<RescanReview | null>(null);
  const [rescanPhase, setRescanPhase] = useState<ReviewPhase>('changes');
  const [rescanPicked, setRescanPicked] = useState<Set<string>>(new Set());
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraScan | null>(null);
  const closedRef = useRef(false);
  // The live hash index, so a lock can re-check owned printings' scan distance.
  const indexRef = useRef<ScanIndex | null>(null);
  const trayRef = useRef<Tray | null>(null);
  const trayElRef = useRef<HTMLDivElement>(null);
  const traySeqRef = useRef(0);
  // The tray is the user's while they browse it. `holdUntil` is when it goes
  // back to the scanner (null = not held), `pendingId` is a different card that
  // locked meanwhile and was dropped — the camera never stops, so it re-locks on
  // its own the moment the hold drains.
  const [holdUntil, setHoldUntil] = useState<number | null>(null);
  const [holdNow, setHoldNow] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const holdUntilRef = useRef<number | null>(null);
  const touchedAtRef = useRef(0);
  /** Scrolled or tapped since this tray appeared: a late OCR result may badge
   *  the confirmed edition but must not re-front it in a row you're reading. */
  const touchedRef = useRef(false);
  /** When the row's contents last actually changed, for the tap dead-time. */
  const trayChangedAtRef = useRef(0);
  const fxSeq = useRef(0);
  // The last lock we auto-added for, so a confirmed edition adds itself once.
  const autoAddedRef = useRef<string | null>(null);
  // onLocked is the mount-time closure (the camera callback is built once), so
  // the locks it reads come through a ref, like the index and ownership do.
  const locksRef = useRef(locks);
  // The user picked a language for the card in frame — a late OCR reading must
  // not overwrite it (they can read the card; the OCR is guessing).
  const langTouchedRef = useRef(false);
  // Lock lifecycle (mount-time closure again, so: refs). `released` means the
  // tray no longer blocks a re-lock of the same card; `noCard` counts the
  // card-free frames that let a stale lock go.
  const lockAtRef = useRef<number | null>(null);
  const releasedRef = useRef(false);
  const noCardRef = useRef(0);
  // What this lock has put in the session, so a picker change can go back and
  // re-tag it (tap +1 first, then notice the card is foil).
  const lockAddsRef = useRef<{ scryfallId: string; board: DeckBoard; qty: number }[]>([]);
  const toast = useToast();
  // Scanning a card into a deck/binder/box means it's physically there now —
  // route the write through the same filing engine "File away" uses, so a
  // scan that names an exact copy already filed elsewhere asks (or, unattended,
  // moves it) instead of leaving a stale claim behind.
  const { file, ask, sheet: filingSheet } = useFiling();
  // "Update" (swap a copy you own for the scanned printing) is the same
  // question an import asks, so it comes from the same place.
  const { resolveReplacements, sheet: replaceSheet } = useReplaceFlow();
  // Cards you own but haven't filed are cards you'll have to file by hand
  // later, so a collection scan ends by offering to put the pile somewhere.
  const { offer: offerFiling, sheet: fileTheseSheet } = useFileThese();
  const { confirm, sheet: confirmSheet } = useConfirm();
  // The duplicates sheet is rendered inline by this component, so its guard
  // clock has to start when the step appears, not when the scanner opened.
  const conflictTapGuard = useTapGuard(TAP_GUARD_MS, conflictStep);
  // Same for the review's "already own these" step — it arrives mid-flow.
  const ownedTapGuard = useTapGuard(TAP_GUARD_MS, rescanPhase === 'owned' ? rescanStep : null);

  const total = session.reduce((n, e) => n + e.qty, 0);

  /** Hand the row to the user for a while (any scroll or tap inside it). */
  const holdTray = () => {
    touchedRef.current = true;
    touchedAtRef.current = Date.now();
    const until = touchedAtRef.current + TRAY_HOLD_MS;
    holdUntilRef.current = until;
    setHoldUntil(until);
    setHoldNow(touchedAtRef.current);
  };

  /** Give it back: the hold ran out, the row was scrolled home, or the card left. */
  const releaseTray = () => {
    if (holdUntilRef.current === null) return;
    holdUntilRef.current = null;
    setHoldUntil(null);
    setPendingId(null);
  };

  // Drain the hold bar, and stop ticking the moment it's up.
  useEffect(() => {
    if (holdUntil === null) return;
    setHoldNow(Date.now());
    const t = setInterval(() => {
      const now = Date.now();
      setHoldNow(now);
      if (now >= holdUntil) releaseTray();
    }, 100);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdUntil]);

  // Every new lock — a different card, or the next copy of the same one — starts
  // the row from the left, so a printing you scrolled to on the last card isn't
  // what's under your thumb on this one. Keyed on the lock counter rather than
  // the card, and laid out before paint so the old offset never flashes.
  useLayoutEffect(() => {
    touchedRef.current = false;
    if (trayElRef.current) trayElRef.current.scrollLeft = 0;
  }, [tray?.seq]);

  const updateTray = (t: Tray | null) => {
    const before = trayRef.current?.candidates.map((c) => c.scryfallId).join() ?? '';
    const after = t?.candidates.map((c) => c.scryfallId).join() ?? '';
    // Only a changed line-up starts the dead time — an OCR badge landing on a
    // row that didn't move shouldn't swallow the tap that was already coming.
    if (before !== after) trayChangedAtRef.current = Date.now();
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
      if (s.status === 'scanning') {
        // The card is out of frame and the lock has had its hold: let go, so the
        // next card locks even when it's a second copy of the same one.
        noCardRef.current = s.cardSeen ? 0 : noCardRef.current + 1;
        if (noCardRef.current >= EMPTY_FRAMES_TO_RELEASE) {
          // The card is out of frame: nobody is picking a printing off this row
          // any more (the tray sits at the bottom of the screen, so browsing it
          // never covers the card), so don't make the next card wait out a hold.
          if (Date.now() - touchedAtRef.current > TRAY_TOUCH_GRACE_MS) releaseTray();
          if (lockAtRef.current !== null && Date.now() - lockAtRef.current >= LOCK_HOLD_MS) releaseLock();
        }
      }
      if (s.status === 'locked') void onLocked(s.result);
    });
    cameraRef.current = cam;
    void cam.start();
  };

  // Scan data must be installed before the camera is useful.
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
        startScanning(index);
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

  // Fill the camera picker when the settings open, and re-read the pin: a
  // pinned lens that has since disappeared is dropped by the camera on start,
  // and the picker must show that rather than a device it isn't using.
  useEffect(() => {
    if (!settingsOpen || stage.kind !== 'scanning') return;
    void listCameras().then((list) => {
      setCameras(list);
      setCameraId(getPreferredCameraId() ?? '');
    });
  }, [settingsOpen, stage.kind]);

  // Load the set pin's options while the settings are open (and refresh them
  // when the card in frame changes underneath). A pin held over from another
  // card, or from last night's binder, isn't among this card's editions, so one
  // printing of that set is fetched just to give the closed picker its name.
  useEffect(() => {
    if (!settingsOpen) return;
    const cands = tray?.candidates ?? [];
    let cancelled = false;
    void (async () => {
      const matched = new Map<string, Priced<Printing>>();
      for (const c of cands) if (c.printing && !matched.has(c.printing.set)) matched.set(c.printing.set, c.printing);
      const others = new Map<string, Priced<Printing>>();
      for (const oracleId of new Set(cands.map((c) => c.printing?.oracleId).filter((id): id is string => !!id))) {
        for (const p of await getPrintingsForOracle(oracleId)) {
          if (!matched.has(p.set) && !others.has(p.set)) others.set(p.set, p);
        }
      }
      if (locks.set && !matched.has(locks.set) && !others.has(locks.set)) {
        const sample = await getPrintingForSet(locks.set);
        if (sample) others.set(locks.set, sample);
      }
      if (!cancelled) setSetOptions({ matched: [...matched.values()], others: [...others.values()] });
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen, tray?.topId, tray?.candidates, locks.set]);

  useEffect(() => {
    locksRef.current = locks;
    try {
      localStorage.setItem('scan-locks', JSON.stringify(locks));
    } catch {
      /* ignore */
    }
  }, [locks]);

  // Drive the padlock badge's countdown ring, and stop ticking the moment the
  // hold is up — an idle scanner shouldn't re-render four times a second.
  useEffect(() => {
    if (lockAt === null) return;
    setLockNow(Date.now());
    const t = setInterval(() => {
      const now = Date.now();
      setLockNow(now);
      if (now - lockAt >= LOCK_HOLD_MS) clearInterval(t);
    }, 120);
    return () => clearInterval(t);
  }, [lockAt]);

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

  /**
   * Let go of the current lock: the tray stays (you can still tap it), but the
   * very next lock is accepted even if it's the same card. Called by the padlock
   * badge and by the stale-lock rule in the camera callback.
   */
  const releaseLock = () => {
    releasedRef.current = true;
    lockAtRef.current = null;
    setLockAt(null);
  };

  const onLocked = async (result: ScanPipelineResult) => {
    // The camera never stops between cards, so it keeps re-locking whatever is
    // in frame — while the lock is held, only a *different* top candidate
    // replaces the tray (and re-runs the DB join + OCR). Once it's been released
    // the same card counts as a new one: that's the second copy in the pile.
    const topId = result.match.candidates[0]?.scryfallId;
    if (!topId || (topId === trayRef.current?.topId && !releasedRef.current)) {
      cameraRef.current?.resume();
      return;
    }

    // The row is under the user's finger, so dropping this lock is the whole
    // point of the hold. Nothing is queued: the camera never stops locking, so
    // the next one lands the moment the row is handed back. The bar only says
    // that something is waiting for it.
    if (holdUntilRef.current !== null && Date.now() < holdUntilRef.current) {
      if (topId !== trayRef.current?.topId) setPendingId(topId);
      cameraRef.current?.resume();
      return;
    }

    // A new card in frame: the pickers start from the pile pins, or from the
    // safe defaults when nothing is pinned, and nothing added under the previous
    // lock is re-tagged by them any more. The auto-add guard is per lock, so it
    // clears here too — without that, coming back to a card already auto-added
    // once (A, B, A — a binder page of near-duplicates) never adds the second copy.
    const pins = locksRef.current;
    autoAddedRef.current = null;
    setAutoState('idle');
    langTouchedRef.current = false;
    lockAddsRef.current = [];
    releasedRef.current = false;
    noCardRef.current = 0;
    lockAtRef.current = Date.now();
    setLockAt(lockAtRef.current);
    setLockNow(lockAtRef.current); // full ring on the first paint, not on the next tick
    setFinish(pins.finish ?? 'nonfoil');
    setCondition('NM');
    setLang(pins.lang ?? 'en');

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

    // A set pin is a promise about the pile, so the reader is only asked to tell
    // that set's printings apart: fewer candidates means a read stops being
    // ambiguous sooner (the tie rule is what costs strip attempts), and when the
    // pin leaves one printing standing there is nothing to read at all — that
    // one is pinpointed on the spot, before the first OCR pass.
    const inPin = pins.set ? candidates.filter((c) => c.printing?.set === pins.set) : [];
    const pool = (inPin.length ? inPin : candidates).filter((c) => c.printing);
    const pinpointed = inPin.length ? onePrinting(pool) : null;
    const ordered = pinpointed ? [pinpointed, ...candidates.filter((c) => c !== pinpointed)] : candidates;
    updateTray({
      seq: ++traySeqRef.current,
      topId,
      candidates: orderTrayCandidates(ordered, pinpointed?.scryfallId ?? null, ownershipRef.current),
      ocr: pinpointed ? 'confirmed' : 'pending',
      ocrHit: pinpointed?.scryfallId ?? null,
    });
    cameraRef.current?.resume();

    // Pinpointed and the pile's language is pinned too: the strip has nothing
    // left to tell us, so skip the reader (up to 32 passes, ~10 s) entirely.
    if (pinpointed && pins.lang) return;

    // S4: OCR the info strip to pin down printing + language. By the time it
    // resolves the user may already be on the next card — only touch the tray
    // if it still shows this lock.
    try {
      const resolution = await resolveWithOcr(
        result,
        (pinpointed ? [pinpointed] : pool).map((c) => ({
          scryfallId: c.scryfallId,
          set: c.printing!.set,
          collectorNumber: c.printing!.collectorNumber,
          releasedAt: c.printing!.releasedAt,
        })),
      );
      const current = trayRef.current;
      if (current?.topId !== topId) return;
      const read = resolution.parsed?.lang;
      if (read && !locksRef.current.lang && !langTouchedRef.current) setLang(read);
      // The pin already named the printing; this read was for the language only.
      if (pinpointed) return;
      const hit = resolution.confirmed ?? resolution.weak;
      // Bring the confirmed edition to the front — but only on a row nobody has
      // touched. Once the user is scrolling through the printings, shifting them
      // all sideways is how you end up tapping the reprint next to the one you
      // wanted; the green check has to carry the news instead.
      let trayOrder = current.candidates;
      const idx = hit && !touchedRef.current ? trayOrder.findIndex((c) => c.scryfallId === hit.scryfallId) : -1;
      if (idx > 0) trayOrder = [trayOrder[idx]!, ...trayOrder.filter((_, j) => j !== idx)];
      updateTray({
        ...current,
        candidates: trayOrder,
        ocr: resolution.confirmed ? 'confirmed' : resolution.weak ? 'weak' : 'none',
        ocrHit: hit?.scryfallId ?? null,
      });
    } catch {
      const current = trayRef.current;
      if (!pinpointed && current?.topId === topId) updateTray({ ...current, ocr: 'unavailable' });
    }
  };

  /** Net copies this lock has added of a printing — what a picker change re-tags. */
  const recordLockAdd = (scryfallId: string, b: DeckBoard, delta: 1 | -1) => {
    const rec = lockAddsRef.current.find((a) => a.scryfallId === scryfallId && a.board === b);
    if (rec) rec.qty = Math.max(0, rec.qty + delta);
    else if (delta > 0) lockAddsRef.current.push({ scryfallId, board: b, qty: 1 });
  };

  /**
   * Move what this lock already added onto new picker values. The tap comes
   * first as often as not ("+1 — hang on, that one's foil"), so the pickers work
   * both ways: they set what the next +1 records *and* fix what this lock has
   * recorded so far. Bounded by what's actually still in the session, in case a
   * line was edited or taken back in the meantime.
   */
  const retagLockAdds = (from: PickValues, to: PickValues) => {
    const adds = lockAddsRef.current.filter((a) => a.qty > 0);
    if (!adds.length) return;
    setSession((prev) => {
      const out = prev.map((e) => ({ ...e }));
      for (const a of adds) {
        const i = out.findIndex((e) => entryKey(e) === entryKey({ scryfallId: a.scryfallId, board: a.board, ...from }));
        if (i < 0) continue;
        const src = out[i]!;
        const take = Math.min(a.qty, src.qty);
        if (take <= 0) continue;
        src.qty -= take;
        const j = out.findIndex((e) => entryKey(e) === entryKey({ scryfallId: a.scryfallId, board: a.board, ...to }));
        if (j >= 0) out[j]!.qty += take;
        else out.push({ ...src, ...to, qty: take });
      }
      return out.filter((e) => e.qty > 0);
    });
  };

  /** +1/−1 from a tray tile, into the session list, with the picker bar's
   *  finish/condition/language (a deck slot or wish quietly ignores what it doesn't store). */
  const bump = (c: Candidate, delta: 1 | -1, auto = false) => {
    if (!c.printing) return;
    // The line-up moved a moment ago, so this tap was aimed at whatever used to
    // be here. Dropping it costs a re-tap; honouring it adds the wrong printing.
    if (!auto && Date.now() - trayChangedAtRef.current < TRAY_SETTLE_MS) return;
    // The user got there first: the copy is in the session, so call auto-add off
    // for this lock instead of dropping a second one in when the OCR lands.
    // Latching the guard ref is what actually stops it (a later set pin that
    // narrows the tray to one candidate would otherwise still fire).
    if (!auto && delta > 0 && autoAdd && trayRef.current && autoAddedRef.current !== trayRef.current.topId) {
      autoAddedRef.current = trayRef.current.topId;
      setAutoState('stopped');
    }
    const f = finish;
    const cond = condition;
    const l = lang;
    const b: DeckBoard = target.kind === 'deck' ? board : 'main';
    const key = entryKey({ scryfallId: c.scryfallId, finish: f, condition: cond, lang: l, board: b });
    let i = session.findIndex((e) => entryKey(e) === key);
    recordLockAdd(c.scryfallId, b, delta);
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
            finish: f,
            lang: l,
            condition: cond,
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

  // Auto-add: once the edition for a lock is pinpointed, drop +1 of it into the
  // session — one add per lock, guarded by the ref. OCR pinpoints it (the green
  // check on the tile); so does a set lock that leaves exactly one candidate
  // standing, which is how a foil-heavy set pile gets through without OCR.
  useEffect(() => {
    if (!autoAdd || !tray) return;
    if (autoAddedRef.current === tray.topId) return; // added already, or the user beat it to it
    if (tray.ocr === 'pending') {
      setAutoState('waiting');
      return;
    }
    const byOcr =
      tray.ocrHit && (tray.ocr === 'confirmed' || tray.ocr === 'weak')
        ? tray.candidates.find((c) => c.scryfallId === tray.ocrHit)
        : undefined;
    const inSet = locks.set ? tray.candidates.filter((c) => c.printing?.set === locks.set) : [];
    const hit = byOcr ?? (inSet.length === 1 ? inSet[0] : undefined);
    // No pinpoint: nothing lands on its own, so drop the "pinpointing" message.
    // The guard ref stays open — switching a set pin on can still land it.
    if (!hit) {
      setAutoState('missed');
      return;
    }
    autoAddedRef.current = tray.topId;
    setAutoState('added');
    bump(hit, 1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tray, autoAdd, locks.set]);

  // Picker change: re-tag what this lock already added, and if that value is
  // pinned the pin moves with it (the pile turned out to be Japanese after all).
  const picked: PickValues = { finish, condition, lang };
  const pickFinish = (f: Finish) => {
    setFinish(f);
    retagLockAdds(picked, { ...picked, finish: f });
    setLocks((l) => (l.finish ? { ...l, finish: f } : l));
  };
  const pickCondition = (c: Condition) => {
    setCondition(c);
    retagLockAdds(picked, { ...picked, condition: c });
  };
  const pickLang = (v: string) => {
    setLang(v);
    langTouchedRef.current = true;
    retagLockAdds(picked, { ...picked, lang: v });
    setLocks((l) => (l.lang ? { ...l, lang: v } : l));
  };

  // Pin selects in the settings popover ('' = off). Switching one on also
  // applies it to the card already in frame, so the first card isn't the odd one.
  const lockFinish = (v: string) => {
    setLocks((l) => ({ ...l, finish: (v || null) as Finish | null }));
    if (v) pickFinish(v as Finish);
  };
  const lockLang = (v: string) => {
    setLocks((l) => ({ ...l, lang: v || null }));
    if (v) {
      setLang(v);
      langTouchedRef.current = false;
    }
  };
  /** Pin the pile's set by picking one of the card's editions ('' = pin off). */
  const pickSetLock = (scryfallId: string) => {
    const p = [...setOptions.matched, ...setOptions.others].find((x) => x.scryfallId === scryfallId);
    setLocks((l) => ({ ...l, set: p?.set ?? null }));
  };

  /** Swap lenses without disturbing the session — the stream is all that changes. */
  const pickCamera = (id: string) => {
    setCameraId(id);
    void cameraRef.current?.switchTo(id || null);
  };

  const openList = () => {
    cameraRef.current?.pause();
    setListOpen(true);
  };

  const closeList = () => {
    setListOpen(false);
    cameraRef.current?.resume();
  };

  /** One scanned line as an import line (the collection write is the import write). */
  const entryLine = (e: SessionEntry): ResolvedLine => ({
    oracleId: e.oracleId,
    scryfallId: e.scryfallId,
    name: e.name,
    quantity: e.qty,
    // Marked for trade only when the destination is the tradelist.
    quantityForTrade: target.kind === 'tradelist' ? e.qty : 0,
    condition: e.condition,
    finish: e.finish,
    lang: e.lang,
  });

  /** The session as import lines (collection/tradelist go through applyImport). */
  const sessionLines = (): ResolvedLine[] => session.map(entryLine);

  const finishScan = () => {
    clearStored();
    cameraRef.current?.stop();
    onClose();
  };

  /**
   * Commit the collection/tradelist lines, honoring the conflict screen's
   * per-card choices — the same write an import does, through the same code.
   * A queued "which copy does this replace?" pick resolves first; backing out
   * of it leaves the scan untouched. Whatever lands is then offered a home.
   */
  const commitLines = async (
    lines: ResolvedLine[],
    choices: Map<string, ConflictChoice>,
    conflicts: ImportConflict[] = [],
  ) => {
    const outcome = await resolveReplacements(conflicts, choices);
    if (!outcome) return; // backed out of a pick — the session is still there

    setCommitting(true);
    let written: ResolvedLine[] = [];
    try {
      const res = await commitResolvedLines(lines, choices, outcome, { source: 'scan' });
      written = res.written;
      const n = res.added + res.flagged;
      toast(
        n === 0 ? 'Nothing added: every card was skipped' : `Added ${n} card${n === 1 ? '' : 's'} to ${targetLabel(target)}`,
      );
    } finally {
      setCommitting(false);
    }
    // You're holding the pile right now — this is the cheapest moment to say
    // where it goes, and the only one that doesn't mean re-selecting all of it.
    await offerFiling(filingCopiesFor(written), written.reduce((n, l) => n + l.quantity, 0));
    finishScan();
  };

  /**
   * Deck re-scan: collapse the session to deck slots (oracle + board, since
   * decks store no finish/condition/lang), diff it against the deck's current
   * contents, and list any scanned printing not in the collection.
   */
  /**
   * Split the scan for the "…and your collection?" step. A pile scanned into a
   * deck, binder or box is cardboard in hand, and it can be a mix: cards you've
   * never owned, cards you already have, or both. So both get a say —
   *
   *  - own none of it (any printing): the tick-list, everything on by default.
   *  - already own it: the import's per-card Skip / Add / Update.
   *
   * The split is per card, not per printing — the same rule findImportConflicts
   * uses — so no scanned card can turn up in both lists.
   */
  const buildCollectionStep = async (): Promise<Pick<RescanReview, 'unowned' | 'conflicts'>> => {
    const conflicts = await findImportConflicts(sessionLines());
    const owned = new Set(conflicts.map((c) => c.oracleId));
    return { unowned: session.filter((e) => !owned.has(e.oracleId)), conflicts };
  };

  /** Review steps with something to show, in the order they're walked. */
  const reviewPhases = (r: RescanReview): ReviewPhase[] => [
    ...(r.changes.length ? (['changes'] as ReviewPhase[]) : []),
    ...(r.unowned.length ? (['collection'] as ReviewPhase[]) : []),
    ...(r.conflicts.length ? (['owned'] as ReviewPhase[]) : []),
  ];

  /** Step `delta` phases from the current one; null means there's nothing further that way. */
  const stepPhase = (r: RescanReview, delta: 1 | -1): ReviewPhase | null => {
    const phases = reviewPhases(r);
    return phases[phases.indexOf(rescanPhase) + delta] ?? null;
  };

  const buildRescanReview = async (deckId: string): Promise<RescanReview> => {
    const slotMap = new Map<string, RescanSlot>();
    for (const e of session) {
      const key = `${e.oracleId}|${e.board}`;
      const cur = slotMap.get(key);
      if (cur) cur.quantity += e.qty;
      else slotMap.set(key, { oracleId: e.oracleId, board: e.board, quantity: e.qty, scryfallId: e.scryfallId, name: e.name, image: e.image });
    }
    // "Any printing" basics are invisible to a scan — reconcileDeck leaves them
    // alone, so the preview mustn't offer to sweep them away either.
    const current = (await db.deckCards.where('deckId').equals(deckId).toArray()).filter((c) => !c.anyBasic);
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

    return { slots: [...slotMap.values()], changes, ...(await buildCollectionStep()) };
  };

  /**
   * Apply the reviewed container write, then the collection write the review
   * settled: the ticked unowned cards, plus whatever the already-owned cards
   * were told to do. Re-scan reconciles the container to exactly the scan; a
   * regular scan just appends.
   */
  const applyRescan = async (choices: Map<string, ConflictChoice> = new Map()) => {
    if (!rescanStep || committing || target.kind !== 'deck') return;
    // "Update" swaps a copy you own for the scanned printing, and asks which
    // one when you own several — settle that before touching anything.
    const outcome = await resolveReplacements(rescanStep.conflicts, choices);
    if (outcome === null) {
      toast('Nothing changed: the swap was cancelled');
      return;
    }
    setCommitting(true);
    try {
      const r = rescanStep;
      if (target.rescan) {
        // "This is what's in the deck now" means any of these copies claimed by
        // another deck has physically left it. The add path has always asked;
        // re-scan reconciles its own slots, so it settles the same question by
        // hand rather than skipping it and leaving stale claims behind.
        const decided = await ask(target.deckId, scanCopies(session), { replacing: true });
        if (decided === null) {
          toast('Nothing changed: filing was cancelled');
          return;
        }
        if (decided.mode === 'move') await unfileClashes(decided.clashes);
        await reconcileDeck(
          target.deckId,
          r.slots.map((s) => ({ oracleId: s.oracleId, board: s.board, quantity: s.quantity, scryfallId: s.scryfallId })),
          { source: 'scan' },
        );
      } else {
        const mode = await file(target.deckId, scanCopies(session), { source: 'scan' });
        if (mode === null) {
          // Backed out of the prompt: leave the review up, but say so.
          toast('Nothing added: filing was cancelled');
          return;
        }
      }
      // One write for the whole collection side, through the same pipeline an
      // import uses: the ticked unowned lines, plus the owned cards' lines
      // (commitResolvedLines drops the ones set to Skip).
      const toAdd = [
        ...r.unowned.filter((e) => rescanPicked.has(entryKey(e))).map(entryLine),
        ...r.conflicts.flatMap((c) => c.incoming),
      ];
      const res = toAdd.length
        ? await commitResolvedLines(toAdd, choices, outcome, { source: 'scan' })
        : { added: 0, flagged: 0 };
      const addedToColl = res.added + res.flagged;
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

  /**
   * Every commit is fired and forgotten by a sheet's onClick, so a throw would
   * otherwise land in the void: no toast, no retry, the button simply looking
   * dead. Same wording as before, now off the shared helper every other async
   * handler in the app uses.
   */
  const runCommit = (run: () => Promise<void>): void => commitAction.run('save the scan', run);

  /** Write the whole session to the target and leave the scanner. */
  const complete = async () => {
    if (committing || session.length === 0) return;
    // Deck re-scan reconciles instead of adding: build the diff and route into
    // the two-step review (deck changes, then unowned-card collection prompt).
    if (target.kind === 'deck' && target.rescan) {
      const review = await buildRescanReview(target.deckId);
      const phase = reviewPhases(review)[0];
      if (!phase) {
        toast(`No changes — this ${targetNoun(target)} already matches your scan`);
        finishScan();
        return;
      }
      setRescanPicked(new Set(review.unowned.map((e) => entryKey(e))));
      setRescanPhase(phase);
      setRescanStep(review);
      return;
    }
    // Regular deck scan: physical cards are usually in hand, so — like re-scan —
    // ask what the collection should make of them. New cards, cards you already
    // own, or a mix: each one gets its own answer. The deck append itself is
    // deferred to applyRescan so both writes land together.
    if (target.kind === 'deck') {
      const review: RescanReview = { slots: [], changes: [], ...(await buildCollectionStep()) };
      const phase = reviewPhases(review)[0];
      if (phase) {
        setRescanPicked(new Set(review.unowned.map((e) => entryKey(e))));
        setRescanPhase(phase);
        setRescanStep(review);
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
          // A scanned card is a specific printing, so the wish is for that
          // edition — plus whatever the pickers were moved off their defaults to.
          await addToWishlistBulk(
            session.map((e) => ({
              oracleId: e.oracleId,
              scryfallId: e.scryfallId,
              quantity: e.qty,
              finish: wishPreference(e.finish, 'nonfoil'),
              condition: wishPreference(e.condition, 'NM'),
              lang: wishPreference(e.lang, 'en'),
            })),
            { source: 'scan' },
          );
          break;
        case 'deck': {
          // A scan names an exact copy (printing, condition, finish, language),
          // so it's physical cardboard being filed, not a brew line — route it
          // through the filing engine, which asks (or moves it) if that same
          // copy is already claimed somewhere else.
          const mode = await file(target.deckId, scanCopies(session), { source: 'scan' });
          if (mode === null) {
            // Backed out of the "already filed elsewhere" prompt. Silence here
            // reads as a dead button, so name what didn't happen.
            toast('Nothing added: filing was cancelled');
            return;
          }
          break;
        }
        case 'trade':
          target.onAdd(
            session.map((e) => ({
              oracleId: e.oracleId,
              scryfallId: e.scryfallId,
              name: e.name,
              finish: e.finish,
              // A trade values what's actually being handed over, and the
              // picker bar is right there through the whole scan — so a played
              // copy no longer enters the offer claiming to be Near Mint.
              condition: e.condition,
              lang: e.lang,
              quantity: e.qty,
            })),
          );
          break;
      }
      toast(`Added ${total} card${total === 1 ? '' : 's'} to ${targetLabel(target)}`);
      finishScan();
    } finally {
      setCommitting(false);
    }
  };

  const close = () =>
    void (async () => {
      if (total > 0) {
        const ok = await confirm({
          title: `Discard ${total} scanned card${total === 1 ? '' : 's'}?`,
          body: 'Nothing has been written yet, so the whole scan goes.',
          confirmLabel: 'Discard the scan',
          cancelLabel: 'Keep scanning',
          danger: true,
        });
        if (!ok) return;
      }
      clearStored();
      cameraRef.current?.stop();
      onClose();
    })();

  // Back / Escape peels the scanner's own layers before leaving the scan. The
  // sheets that live in their own components (session list, replace picker,
  // re-scan review) register themselves and sit above this one; only the
  // inline layers need naming here. A commit in flight claims nothing.
  useDismiss(
    committing
      ? null
      : conflictStep
        ? () => setConflictStep(null)
        : settingsOpen
          ? () => setSettingsOpen(false)
          : close,
  );

  /** Session copies of a printing across finishes/boards — the tile's badge. */
  const countOf = (scryfallId: string) => session.reduce((n, e) => (e.scryfallId === scryfallId ? n + e.qty : n), 0);

  const ownership = useOwnershipIndex();
  // onLocked is captured once (mount), but ownership loads/changes later — read
  // it through a ref so a lock always sees the current collection.
  const ownershipRef = useRef(ownership);
  useEffect(() => {
    ownershipRef.current = ownership;
  }, [ownership]);

  // Everything pinned right now, as chips over the camera: a pin left on from
  // the last pile is exactly the sort of thing you notice one binder too late.
  const lockChips = [
    locks.finish ? FINISH_LABELS[locks.finish] : null,
    locks.lang ? locks.lang.toUpperCase() : null,
    locks.set ? locks.set.toUpperCase() : null,
  ].filter((s): s is string => !!s);

  /** Which row of the set picker the pin is sitting on ('' = the "off" row). */
  const pinnedSetPrinting = locks.set
    ? ([...setOptions.matched, ...setOptions.others].find((p) => p.set === locks.set)?.scryfallId ?? '')
    : '';

  // Already ordered when the tray was built — sorting here would move tiles
  // whenever the collection changed underneath, which a +1 does every time.
  const shown = tray ? filterBySet(tray.candidates, locks.set) : [];
  /** Set lock on, but nothing in this scan came from it — the tray shows everything. */
  const setMissed = !!locks.set && !!tray && !tray.candidates.some((c) => c.printing?.set === locks.set);
  // Auto-add's running commentary, which outranks the camera's own status while
  // a card is held in frame. Once the card is pulled away the pill goes back to
  // "point the camera at a card", so the note clears itself.
  const autoNote =
    autoAdd && tray && live && (live.status !== 'scanning' || live.cardSeen) ? AUTO_ADD_NOTES[autoState] : null;
  /** Countdown ring: 1 right after a lock, 0 once the hold is up or it let go. */
  const holdLeft = lockAt === null ? 0 : Math.max(0, Math.min(1, 1 - (lockNow - lockAt) / LOCK_HOLD_MS));
  /**
   * The same ring, before a lock: the agreeing frames banked towards one. Real
   * progress, not a timer — a blurry or disagreeing frame drops it back to zero.
   * Only while nothing is held, so a held lock's drain isn't fighting the camera
   * re-converging on the card that is still in frame.
   */
  const arming = lockAt === null && live?.status === 'scanning' ? Math.min(1, live.streak / CONSENSUS_FRAMES) : 0;
  const ringFill = lockAt === null ? arming : holdLeft;
  /** The tray's own hold: 1 right after a touch, 0 once the row is the scanner's again. */
  const trayHoldLeft = holdUntil === null ? 0 : Math.max(0, Math.min(1, (holdUntil - holdNow) / TRAY_HOLD_MS));

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
            {cameras.length > 1 && (
              <label className="scan-setting scan-setting-stacked">
                <span>
                  <strong>Camera</strong>
                  <small>Phones with several rear lenses like to swap mid-pile. Pin the one that focuses best up close.</small>
                </span>
                <select className="scan-lock-select scan-camera-select" value={cameraId} onChange={(e) => pickCamera(e.target.value)}>
                  <option value="">Automatic</option>
                  {cameras.map((c) => (
                    <option key={c.deviceId} value={c.deviceId}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="scan-setting">
              <span>
                <strong>Auto-add pinpointed edition</strong>
                <small>
                  When the edition is confirmed (green check), add +1 on its own. Adding a copy yourself first stops
                  it for that card.
                </small>
              </span>
              <input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} />
            </label>
            <label className="scan-setting">
              <span>
                <strong>Finish pile</strong>
                <small>A stack of foils (or etched)? Pin it and every card you add gets that finish</small>
              </span>
              <select className="scan-lock-select" value={locks.finish ?? ''} onChange={(e) => lockFinish(e.target.value)}>
                <option value="">Off</option>
                {FINISHES.map((f) => (
                  <option key={f} value={f}>
                    {FINISH_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="scan-setting">
              <span>
                <strong>Language pile</strong>
                <small>Pin the pile&rsquo;s language; the reader can&rsquo;t overrule it (it misreads non-English cards)</small>
              </span>
              <select className="scan-lock-select" value={locks.lang ?? ''} onChange={(e) => lockLang(e.target.value)}>
                <option value="">Off</option>
                {LANGS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {/* Not a <label>: the picker is a button until it's opened, and a
                label wrapping a button turns its own text into a second trigger. */}
            <div className="scan-setting scan-setting-stacked">
              <span>
                <strong>Set pile</strong>
                <small>
                  {locks.set
                    ? `Only ${locks.set.toUpperCase()} printings are suggested (they still show if the scan matches none), and the reader has less to tell apart`
                    : tray
                      ? 'One set only. Pick it from the editions of the card in frame'
                      : 'One set only. Scan a card from the pile, then pick its set here'}
                </small>
              </span>
              <EditionPicker
                printings={setOptions.others}
                highlighted={setOptions.matched}
                highlightLabel="Matched this scan"
                restLabel="Other sets of this card"
                selected={pinnedSetPrinting}
                anyLabel="Off: suggest every set"
                placeholder="Pick the pile’s set…"
                hideCollector
                onSelect={pickSetLock}
              />
            </div>
          </div>
        )}

        <div className="scan-cam-side">
          <button className="scan-cam-btn" onClick={openList} aria-label={`Review ${total} scanned cards`}>
            <Icon name="list" />
            {total > 0 && <span className="scan-cam-badge">{total}</span>}
          </button>
          {lockChips.length > 0 && (
            <div className="scan-cam-locks" aria-label="Pinned for this pile">
              {lockChips.map((t) => (
                <span key={t} className="scan-cam-chip scan-cam-chip-on">
                  <Icon name="lock" size={11} /> {t}
                </span>
              ))}
            </div>
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

        {/* Lock state, bottom-left over the camera. One ring, one meaning: how
            committed the scanner is to the card in front of it. It fills as the
            agreeing frames stack up, is full the instant the card locks, then
            drains through the hold that keeps this same copy from re-locking.
            A tap at any point after the lock lets go at once. */}
        {stage.kind === 'scanning' && (
          <button
            className={`scan-lock-badge${lockAt !== null ? ' scan-lock-held' : ''}${holdLeft === 0 && lockAt !== null ? ' scan-lock-stale' : ''}${lockAt === null && arming > 0 ? ' scan-lock-arming' : ''}`}
            onClick={releaseLock}
            disabled={lockAt === null}
            aria-label={lockAt !== null ? 'Release the locked card' : 'No card locked'}
            title={
              lockAt === null
                ? arming > 0
                  ? 'Reading the card… hold steady to lock'
                  : tray
                    ? 'Released: show the next card'
                    : 'Nothing locked yet'
                : holdLeft === 0
                  ? 'Ready for the next card — tap to scan this one again'
                  : 'Locked on this card — tap to release'
            }
          >
            <svg className="scan-lock-ring" viewBox="0 0 36 36" aria-hidden>
              <circle className="scan-lock-ring-track" cx="18" cy="18" r="16" />
              <circle
                className="scan-lock-ring-fill"
                cx="18"
                cy="18"
                r="16"
                pathLength={100}
                strokeDasharray="100"
                strokeDashoffset={(100 - 100 * ringFill).toFixed(1)}
                // An empty ring still renders a hairline at 12 o'clock; hide it
                // rather than unmount, so the first step still tweens from zero.
                style={{ opacity: ringFill > 0 ? 1 : 0 }}
              />
            </svg>
            <Icon name={lockAt !== null ? 'lock' : 'unlock'} size={16} />
          </button>
        )}

        {stage.kind === 'scanning' && live && (
          <p className="scan-cam-status">
            {live.status === 'error'
              ? `Camera failed: ${live.message}`
              : (autoNote ??
                (live.status === 'starting'
                  ? 'Starting camera…'
                  : live.status === 'locked'
                    ? 'Card found'
                    : live.cardSeen
                      ? 'Hold steady…'
                      : 'Point the camera at a card'))}
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

        {refreshOffer && stage.kind === 'scanning' && (
          <div className="scan-cam-offer" role="status">
            <p>
              Newer card-art data is available (~{(refreshOffer.bytes / 1e6).toFixed(0)} MB). It installs for your
              next scan; this one carries on either way.
            </p>
            <div className="scan-cam-offer-actions">
              <button
                className="primary"
                onClick={() => {
                  if (rememberScanChoice) setPrefs({ scanDataPolicy: 'always' });
                  void downloadScanData(refreshOffer).catch(() => {});
                  setRefreshOffer(null);
                  toast('Downloading newer scan data in the background');
                }}
              >
                Download
              </button>
              <button
                onClick={() => {
                  if (rememberScanChoice) setPrefs({ scanDataPolicy: 'never' });
                  setRefreshOffer(null);
                }}
              >
                Not now
              </button>
            </div>
            <label className="scan-cam-offer-remember">
              <input
                type="checkbox"
                checked={rememberScanChoice}
                onChange={(e) => setRememberScanChoice(e.target.checked)}
              />
              <span>Don’t ask again (changeable in Settings)</span>
            </label>
          </div>
        )}
      </div>

      {/* The card in frame: what a +1 records, and what a change re-tags on this
          lock's adds. Pinned values wear a padlock; the rest reset with the next card. */}
      {stage.kind === 'scanning' && (
        <div className="scan-picks" role="group" aria-label="Details for the card you scan">
          <label className={locks.finish ? 'scan-pick scan-pick-locked' : 'scan-pick'}>
            <span>{locks.finish ? <Icon name="lock" size={10} /> : null} Finish</span>
            <select value={finish} onChange={(e) => pickFinish(e.target.value as Finish)}>
              {FINISHES.map((f) => (
                <option key={f} value={f}>
                  {FINISH_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="scan-pick">
            <span>Cond</span>
            <select value={condition} onChange={(e) => pickCondition(e.target.value as Condition)}>
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className={locks.lang ? 'scan-pick scan-pick-locked' : 'scan-pick'}>
            <span>{locks.lang ? <Icon name="lock" size={10} /> : null} Lang</span>
            <select value={lang} onChange={(e) => pickLang(e.target.value)}>
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
              {!LANGS.includes(lang) && <option value={lang}>{lang}</option>}
            </select>
          </label>
          {setMissed && <span className="scan-pick-note">No {locks.set!.toUpperCase()} match</span>}
          {pendingId && (
            <button className="scan-pick-new" onClick={releaseTray}>
              <Icon name="refresh" size={12} /> New card
            </button>
          )}
        </div>
      )}

      {/* The row is yours while this drains. Accent means a different card has
          already locked and is waiting for the handover, so the change that
          follows is announced rather than sprung. */}
      <div className={pendingId ? 'scan-tray-hold scan-tray-hold-new' : 'scan-tray-hold'} aria-hidden="true">
        <span style={{ transform: `scaleX(${trayHoldLeft})` }} />
      </div>

      <div
        className="scan-tray"
        ref={trayElRef}
        onPointerDown={holdTray}
        onScroll={(e) => {
          // Scrolled back to the start: you're done browsing, so hand the row
          // over now instead of sitting out the rest of the hold.
          if (e.currentTarget.scrollLeft <= 2) releaseTray();
          else holdTray();
        }}
      >
        {tray ? (
          shown.map((c) => (
            <TrayTile
              key={c.scryfallId}
              candidate={c}
              count={countOf(c.scryfallId)}
              confirmed={tray.ocrHit === c.scryfallId && (tray.ocr === 'confirmed' || tray.ocr === 'weak')}
              owned={ownedBadge(ownership?.lookup(c.oracle?.oracleId ?? '', c.scryfallId))}
              fx={fx?.id === c.scryfallId ? fx : null}
              onBump={(delta) => bump(c, delta)}
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
          onComplete={() => void runCommit(complete)}
          onClose={closeList}
        />
      )}

      {conflictStep &&
        (() => {
          const nConflicts = conflictStep.conflicts.length;
          const otherCount = conflictStep.lines.length - conflictStep.conflicts.reduce((s, c) => s + c.incoming.length, 0);
          const toTradelist = target.kind === 'tradelist';
          return (
            <div className="sheet-backdrop" onClick={() => setConflictStep(null)} {...conflictTapGuard}>
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
                  incomingLabel="Scanned"
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
                  onConfirm={(choices) => runCommit(() => commitLines(conflictStep.lines, choices, conflictStep.conflicts))}
                  onBack={() => setConflictStep(null)}
                />
              </div>
            </div>
          );
        })()}

      {rescanStep && target.kind === 'deck' && rescanPhase === 'changes' && (
        <RescanChangesSheet
          changes={rescanStep.changes}
          deckName={targetLabel(target)}
          showBoards={deckBoards(target).length > 1}
          busy={committing}
          nextLabel={
            stepPhase(rescanStep, 1)
              ? 'Next'
              : `Apply ${rescanStep.changes.length} change${rescanStep.changes.length === 1 ? '' : 's'}`
          }
          onNext={() => {
            const next = stepPhase(rescanStep, 1);
            if (next) setRescanPhase(next);
            else void runCommit(() => applyRescan());
          }}
          onBack={() => setRescanStep(null)}
        />
      )}

      {rescanStep && target.kind === 'deck' && rescanPhase === 'collection' && (
        <UnownedPromptSheet
          cards={rescanStep.unowned.map(unownedCard)}
          picked={rescanPicked}
          busy={committing}
          intro={
            <>
              You scanned {rescanStep.unowned.length} card{rescanStep.unowned.length === 1 ? '' : 's'} you don’t own
              yet. Pick which to also add to your collection:
            </>
          }
          confirmLabel={(q) =>
            stepPhase(rescanStep, 1) ? 'Next' : q > 0 ? `Apply · add ${q} to collection` : 'Apply without adding'
          }
          backLabel={stepPhase(rescanStep, -1) ? 'Back' : 'Cancel'}
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
          onBack={() => {
            const prev = stepPhase(rescanStep, -1);
            if (prev) setRescanPhase(prev);
            else setRescanStep(null);
          }}
          onConfirm={() => {
            const next = stepPhase(rescanStep, 1);
            if (next) setRescanPhase(next);
            else void runCommit(() => applyRescan());
          }}
        />
      )}

      {/* Last review step: the scanned cards you already own. Filing a pile into
          a container says where it lives, not that you suddenly have more of it,
          so these start on Skip — but a second physical copy (Add) or a printing
          correction (Update) is one tap away, per card. */}
      {rescanStep && target.kind === 'deck' && rescanPhase === 'owned' && (
        <div className="sheet-backdrop" onClick={() => setRescanStep(null)} {...ownedTapGuard}>
          <div className="sheet" role="dialog" aria-label="Cards you already own" onClick={(e) => e.stopPropagation()}>
            <ImportConflicts
              conflicts={rescanStep.conflicts}
              otherCount={rescanStep.unowned.filter((e) => rescanPicked.has(entryKey(e))).length}
              options={[
                { value: 'skip', label: 'Skip' },
                { value: 'add', label: 'Add' },
                { value: 'replace', label: 'Update' },
              ]}
              defaultChoice="skip"
              incomingLabel="Scanned"
              intro={
                <>
                  {rescanStep.conflicts.length} scanned card{rescanStep.conflicts.length === 1 ? '' : 's'}{' '}
                  {rescanStep.conflicts.length === 1 ? 'is' : 'are'} already in your collection (any printing counts).
                  Per card: <strong>Skip</strong> leaves your collection as it is (the copy is just being filed),{' '}
                  <strong>Add</strong> adds the scanned copy as a new one, <strong>Update</strong> swaps a copy you own
                  for the scanned printing (your total stays the same).
                </>
              }
              confirmLabel={(n) => (n > 0 ? `Apply · add ${n} to collection` : 'Apply without adding')}
              onConfirm={(choices) => runCommit(() => applyRescan(choices))}
              onBack={() => {
                const prev = stepPhase(rescanStep, -1);
                if (prev) setRescanPhase(prev);
                else setRescanStep(null);
              }}
            />
          </div>
        </div>
      )}

      {/* Last, so it stacks above any review step that can raise it: every
          sheet shares one z-index, so DOM order is what decides. */}
      {replaceSheet}

      {filingSheet}
      {fileTheseSheet}
      {confirmSheet}
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
  useDismiss(busy ? null : onBack);
  const tapGuard = useTapGuard();
  return (
    <div className="sheet-backdrop" onClick={onBack} {...tapGuard}>
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
  const action = useAsyncAction();
  // Row tap opens the card sheet on that line for full editing (edition,
  // condition, finish, language, quantity); Apply rewrites the line in place.
  const [editing, setEditing] = useState<{ index: number; oracle: Priced<OracleCard> } | null>(null);
  const [view, setView] = useScanViewMode();
  const showBoards = target.kind === 'deck' && deckBoards(target).length > 1;
  // Stacks show set names and prices, which a session entry doesn't carry;
  // plain rows don't, so they don't pay for the lookup.
  const { printMap } = useCardMaps(
    view === 'stack' ? entries.map((e) => ({ scryfallId: e.scryfallId, oracleId: e.oracleId })) : [],
  );

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

  // The per-line card sheet stacks above this one and dismisses first.
  useDismiss(busy ? null : onClose);
  const tapGuard = useTapGuard();

  return (
    <div className="sheet-backdrop" onClick={onClose} {...tapGuard}>
      <div className="sheet scan-list-sheet" role="dialog" aria-label="Scanned cards" onClick={(e) => e.stopPropagation()}>
        <div className="scan-sheet-head">
          <h2>Scanned cards</h2>
          <span className="scan-target">→ {targetLabel(target)}</span>
          <ViewToggle mode={view} onChange={setView} options={['list', 'stack']} />
          <button className="scan-close" onClick={onClose} aria-label="Close list">
            <Icon name="close" size={18} />
          </button>
        </div>

        {entries.length === 0 ? (
          <p className="scan-list-empty">Nothing scanned yet. Tap the top half of a match to add it.</p>
        ) : view === 'stack' ? (
          <CardStacks
            className="scan-stacks"
            items={entries.map((e, i): CardItem => {
              const printing = printMap?.get(e.scryfallId);
              const extras = [
                e.lang !== 'en' ? e.lang : null,
                e.finish !== 'nonfoil' ? FINISH_LABELS[e.finish] : null,
                e.condition !== 'NM' ? e.condition : null,
              ].filter(Boolean);
              return {
                key: entryKey(e),
                name: e.name,
                image: printing?.imageNormal ?? e.image ?? null,
                foil: e.finish !== 'nonfoil',
                count: e.qty,
                badge: showBoards ? BOARD_LABELS[e.board] : undefined,
                sub: (
                  <>
                    <SetSymbol set={e.set} title={printing?.setName ?? e.set.toUpperCase()} />
                    <span className="stack-setname">{printing?.setName ?? e.set.toUpperCase()}</span> #
                    {e.collectorNumber}
                    {extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}
                  </>
                ),
                price: formatPrice(pricedForFinish(printing, e.finish)),
                onClick: () => void action.run('open that card', () => openEntry(i)),
                actions: (
                  <>
                    <button onClick={() => adjust(i, -1)} aria-label={`One less ${e.name}`}>
                      <Icon name="minus" size={16} />
                    </button>
                    <span className="stack-qty">{e.qty}</span>
                    <button onClick={() => adjust(i, 1)} aria-label={`One more ${e.name}`}>
                      <Icon name="plus" size={16} />
                    </button>
                    {showBoards && (
                      <button className="scan-chip" onClick={() => cycleBoard(i)}>
                        {BOARD_LABELS[e.board]}
                      </button>
                    )}
                  </>
                ),
              };
            })}
          />
        ) : (
          <ul className="scan-list">
            {entries.map((e, i) => (
              <li key={entryKey(e)} className="scan-list-row">
                <button className="scan-list-main" onClick={() => action.run('open that card', () => openEntry(i))} aria-label={`Edit ${e.name}`}>
                  {e.image ? <img className="scan-list-thumb" src={e.image} alt="" /> : <span className="scan-list-thumb" />}
                  <span className="scan-list-info">
                    <strong>{e.name}</strong>
                    <span className="scan-printing">
                      {e.set.toUpperCase()} #{e.collectorNumber} · {e.lang}
                      {e.finish !== 'nonfoil' ? ` · ${FINISH_LABELS[e.finish]}` : ''}
                      {e.condition !== 'NM' ? ` · ${e.condition}` : ''}
                    </span>
                  </span>
                </button>
                {showBoards && (
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
            mode="session"
            oracleCard={editing.oracle}
            sessionCard={{
              scryfallId: entries[editing.index]!.scryfallId,
              quantity: entries[editing.index]!.qty,
              lang: entries[editing.index]!.lang,
              finish: entries[editing.index]!.finish,
              condition: entries[editing.index]!.condition,
            }}
            onApply={(v) => void applyEdit(editing.index, v)}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </div>
  );
}
