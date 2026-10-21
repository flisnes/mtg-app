import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readLocal, writeLocal } from '../util/localStore.js';
import { createPortal } from 'react-dom';
import type { Condition, DeckBoard, Finish } from '@mtg/shared';
import { CONDITIONS, FINISHES } from '@mtg/shared';
import { useIntakeReview } from '../import/intake/useIntakeReview.js';
import { FINISH_LABELS, LANGS } from '@mtg/shared';
import type { ScanIndex } from '../scan/blob.js';
import { CameraScan, CONSENSUS_FRAMES, type LiveScanState } from '../scan/camera.js';
import type { ScanPipelineResult } from '../scan/pipeline.js';

import { resolveWithOcr } from '../scan/ocr.js';
import { playPop } from '../scan/pop.js';
import { downloadScanData } from '../scan/store.js';
import { buildRescanReview } from '../scan/rescan.js';
import {
  commitSession,
  countByPrinting,
  entryLine,
  loadStoredSession,
  sessionKey,
  sessionTotal,
  sessionStorageKey,
  targetLabel,
  targetNoun,
  type ScanLocks,
  type ScanTarget,
  type SessionEntry,
} from '../scan/session.js';
import { filterBySet, joinCandidates, onePrinting, orderTrayCandidates, type Candidate, type Tray } from '../scan/tray.js';
import { setPrefs } from '../prefs.js';
import { Icon } from './icons.js';
import { useToast } from './Toast.js';
import { ownedBadge } from './OwnedBadge.js';
import { useOwnershipIndex, type OwnershipIndex } from '../db/useOwnership.js';
import { useDismiss } from './useDismiss.js';
import { useConfirm } from './ConfirmSheet.js';
import { useAsyncAction } from './useAsyncAction.js';
import { plural } from '../util/format.js';
import { scanBoards } from '../deck/boards.js';
import { SessionSheet } from './SessionSheet.js';
import { CyclePick } from './scan/CyclePick.js';
import { LockBadge, useLockRing } from './scan/LockBadge.js';
import { RescanChangesList } from './scan/RescanChangesList.js';
import { ScanSettings, useScanLocks } from './scan/ScanSettings.js';
import { TrayTile, type TapFx } from './scan/TrayTile.js';
import { useScanData } from './scan/useScanData.js';
import { useTrayHold } from './scan/useTrayHold.js';

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
// the commit is identical; only the final write differs (scan/session.ts).

/** Consecutive card-free frames that count as "the card left the frame". More
 *  than one, so a blurred frame mid-tap can't be mistaken for a card swap. */
const EMPTY_FRAMES_TO_RELEASE = 5;
/** Dead time after the tray's contents do change before a tap counts: a reorder
 *  landing a frame before your finger must not add the printing that slid in. */
const TRAY_SETTLE_MS = 200;

/** What the picker bar decides: applied to every +1, and to this lock's adds when changed. */
interface PickValues {
  finish: Finish;
  condition: Condition;
  lang: string;
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
 * The one window onto the current render for code that outlives it: the camera
 * callback is built once, and onLocked reads the tray again after its awaits.
 * Anything read after an await, or from a callback built on an earlier render,
 * goes through this and never through the render closure.
 */
interface Latest {
  tray: Tray | null;
  session: SessionEntry[];
  locks: ScanLocks;
  ownership: OwnershipIndex | undefined;
  ring: ReturnType<typeof useLockRing>;
  trayHold: ReturnType<typeof useTrayHold>;
  onLocked: (result: ScanPipelineResult) => Promise<void>;
  bump: (c: Candidate, delta: 1 | -1, auto?: boolean) => void;
}

export function ScanSheet({ target = { kind: 'collection' }, onClose }: { target?: ScanTarget; onClose: () => void }) {
  const commitAction = useAsyncAction();
  const storageKey = sessionStorageKey(target);
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
  const [locks, setLocks] = useScanLocks();
  const [finish, setFinish] = useState<Finish>(locks.finish ?? 'nonfoil');
  const [condition, setCondition] = useState<Condition>('NM');
  const [lang, setLang] = useState<string>(locks.lang ?? 'en');
  const [board, setBoard] = useState<DeckBoard>('main');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // When on, pinpointing an edition (OCR confirms the printing, the green check)
  // adds +1 of it on its own. Persisted so the preference sticks between scans.
  const [autoAdd, setAutoAdd] = useState(() => readLocal('scan-autoadd') === '1');
  // What auto-add is doing for the card in frame, for the status pill.
  const [autoState, setAutoState] = useState<AutoAddState>('idle');
  // True while the session is being written — guards against the double-tap
  // that used to commit the whole scan twice (adding two copies of everything).
  const [committing, setCommitting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<CameraScan | null>(null);
  // The live hash index, so a lock can re-check owned printings' scan distance.
  const indexRef = useRef<ScanIndex | null>(null);
  const traySeqRef = useRef(0);
  /** When the row's contents last actually changed, for the tap dead-time. */
  const trayChangedAtRef = useRef(0);
  const fxSeq = useRef(0);
  // The last lock we auto-added for, so a confirmed edition adds itself once.
  const autoAddedRef = useRef<string | null>(null);
  // The user picked a language for the card in frame — a late OCR reading must
  // not overwrite it (they can read the card; the OCR is guessing).
  const langTouchedRef = useRef(false);
  // Card-free frames in a row, which let a stale lock go.
  const noCardRef = useRef(0);
  // What this lock has put in the session, so a picker change can go back and
  // re-tag it (tap +1 first, then notice the card is foil).
  const lockAddsRef = useRef<{ scryfallId: string; board: DeckBoard; qty: number }[]>([]);
  const toast = useToast();
  // Everything between "Add N cards" and the write: which scanned cards are
  // yours, what the collection should make of them, where they live and whether
  // a copy moved. One questionnaire, shared with import, so it asks each
  // question once and the container write goes through the same filing engine
  // "File away" uses.
  const { open: review, sheet: intakeSheet } = useIntakeReview();
  const { confirm, sheet: confirmSheet } = useConfirm();
  const ownership = useOwnershipIndex();
  const ring = useLockRing();
  const trayHold = useTrayHold(tray?.seq);
  // Declared here so everything below can read it; filled in at the bottom of
  // the render, once the functions it carries exist (see `Latest`).
  const latest = useRef<Latest>(null as unknown as Latest);

  const total = sessionTotal(session);
  const counts = useMemo(() => countByPrinting(session), [session]);
  /** Session copies of a printing across finishes/boards — the tile's badge. */
  const countOf = (scryfallId: string) => counts.get(scryfallId) ?? 0;

  const updateTray = (t: Tray | null) => {
    const before = latest.current.tray?.candidates.map((c) => c.scryfallId).join() ?? '';
    const after = t?.candidates.map((c) => c.scryfallId).join() ?? '';
    // Only a changed line-up starts the dead time — an OCR badge landing on a
    // row that didn't move shouldn't swallow the tap that was already coming.
    if (before !== after) trayChangedAtRef.current = Date.now();
    // Ahead of the render: the OCR step reads it back after its await.
    latest.current.tray = t;
    setTray(t);
  };

  const onScanReady = (index: ScanIndex): boolean => {
    if (!videoRef.current) return false;
    indexRef.current = index;
    // Built once, so everything it reads that changes between renders comes
    // through `latest`.
    const cam = new CameraScan(videoRef.current, index, (s) => {
      setLive(s);
      const l = latest.current;
      if (s.status === 'scanning') {
        // The card is out of frame and the lock has had its hold: let go, so the
        // next card locks even when it's a second copy of the same one.
        noCardRef.current = s.cardSeen ? 0 : noCardRef.current + 1;
        if (noCardRef.current >= EMPTY_FRAMES_TO_RELEASE) {
          // The card is out of frame: nobody is picking a printing off this row
          // any more (the tray sits at the bottom of the screen, so browsing it
          // never covers the card), so don't make the next card wait out a hold.
          if (!l.trayHold.browsing()) l.trayHold.release();
          if (l.ring.stale()) l.ring.release();
        }
      }
      if (s.status === 'locked') void l.onLocked(s.result);
    });
    cameraRef.current = cam;
    void cam.start();
    return true;
  };
  const { stage, refreshOffer, dismissOffer, download } = useScanData(onScanReady);

  useEffect(() => () => cameraRef.current?.stop(), []);

  // Mirror the session to storage so an accidental reload doesn't lose it, and
  // clear the mirror when it empties. Best-effort: a full data-URI fixture card
  // can blow the quota, which is fine — this is a convenience, not a guarantee.
  useEffect(() => {
    if (!storageKey) return;
    writeLocal(storageKey, session.length === 0 ? null : JSON.stringify(session));
  }, [session, storageKey]);

  useEffect(() => {
    writeLocal('scan-autoadd', autoAdd ? '1' : '0');
  }, [autoAdd]);

  // Tell the user once if a previous scan was restored after a reload.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (total > 0) toast(`Restored ${total} ${plural(total, 'card')} from your last scan`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearStored = () => {
    if (storageKey) writeLocal(storageKey, null);
  };

  const onLocked = async (result: ScanPipelineResult) => {
    const l = latest.current;
    // The camera never stops between cards, so it keeps re-locking whatever is
    // in frame — while the lock is held, only a *different* top candidate
    // replaces the tray (and re-runs the DB join + OCR). Once it's been released
    // the same card counts as a new one: that's the second copy in the pile.
    const topId = result.match.candidates[0]?.scryfallId;
    if (!topId || (topId === l.tray?.topId && !l.ring.released())) {
      cameraRef.current?.resume();
      return;
    }

    // The row is under the user's finger, so dropping this lock is the whole
    // point of the hold. Nothing is queued: the camera never stops locking, so
    // the next one lands the moment the row is handed back. The bar only says
    // that something is waiting for it.
    if (l.trayHold.isHeld()) {
      if (topId !== l.tray?.topId) l.trayHold.setPendingId(topId);
      cameraRef.current?.resume();
      return;
    }

    // A new card in frame: the pickers start from the pile pins, or from the
    // safe defaults when nothing is pinned, and nothing added under the previous
    // lock is re-tagged by them any more. The auto-add guard is per lock, so it
    // clears here too — without that, coming back to a card already auto-added
    // once (A, B, A — a binder page of near-duplicates) never adds the second copy.
    const pins = l.locks;
    autoAddedRef.current = null;
    setAutoState('idle');
    langTouchedRef.current = false;
    lockAddsRef.current = [];
    noCardRef.current = 0;
    l.ring.start();
    setFinish(pins.finish ?? 'nonfoil');
    setCondition('NM');
    setLang(pins.lang ?? 'en');

    const candidates = await joinCandidates(result, indexRef.current, latest.current.ownership);

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
      candidates: orderTrayCandidates(ordered, pinpointed?.scryfallId ?? null, latest.current.ownership),
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
      const current = latest.current.tray;
      if (current?.topId !== topId) return;
      const read = resolution.parsed?.lang;
      if (read && !latest.current.locks.lang && !langTouchedRef.current) setLang(read);
      // The pin already named the printing; this read was for the language only.
      if (pinpointed) return;
      const hit = resolution.confirmed ?? resolution.weak;
      // Bring the confirmed edition to the front — but only on a row nobody has
      // touched. Once the user is scrolling through the printings, shifting them
      // all sideways is how you end up tapping the reprint next to the one you
      // wanted; the green check has to carry the news instead.
      let trayOrder = current.candidates;
      const at =
        hit && !latest.current.trayHold.touchedRef.current
          ? trayOrder.findIndex((c) => c.scryfallId === hit.scryfallId)
          : -1;
      if (at > 0) trayOrder = [trayOrder[at]!, ...trayOrder.filter((_, j) => j !== at)];
      updateTray({
        ...current,
        candidates: trayOrder,
        ocr: resolution.confirmed ? 'confirmed' : resolution.weak ? 'weak' : 'none',
        ocrHit: hit?.scryfallId ?? null,
      });
    } catch {
      const current = latest.current.tray;
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
        const i = out.findIndex((e) => sessionKey(e) === sessionKey({ scryfallId: a.scryfallId, board: a.board, ...from }));
        if (i < 0) continue;
        const src = out[i]!;
        const take = Math.min(a.qty, src.qty);
        if (take <= 0) continue;
        src.qty -= take;
        const j = out.findIndex((e) => sessionKey(e) === sessionKey({ scryfallId: a.scryfallId, board: a.board, ...to }));
        if (j >= 0) out[j]!.qty += take;
        else out.push({ ...src, ...to, qty: take });
      }
      return out.filter((e) => e.qty > 0);
    });
  };

  /** +1/−1 from a tray tile, into the session list, with the picker bar's
   *  finish/condition/language (a deck slot or wish quietly ignores what it doesn't store). */
  const bump = (c: Candidate, delta: 1 | -1, auto = false) => {
    const printing = c.printing;
    if (!printing) return;
    // The line-up moved a moment ago, so this tap was aimed at whatever used to
    // be here. Dropping it costs a re-tap; honouring it adds the wrong printing.
    if (!auto && Date.now() - trayChangedAtRef.current < TRAY_SETTLE_MS) return;
    // The user got there first: the copy is in the session, so call auto-add off
    // for this lock instead of dropping a second one in when the OCR lands.
    // Latching the guard ref is what actually stops it (a later set pin that
    // narrows the tray to one candidate would otherwise still fire).
    const current = latest.current.tray;
    if (!auto && delta > 0 && autoAdd && current && autoAddedRef.current !== current.topId) {
      autoAddedRef.current = current.topId;
      setAutoState('stopped');
    }
    const b: DeckBoard = target.kind === 'deck' ? board : 'main';
    const line = { scryfallId: c.scryfallId, finish, condition, lang, board: b };
    const key = sessionKey(line);
    recordLockAdd(c.scryfallId, b, delta);
    if (delta > 0) {
      // Rising pop: pitch climbs a semitone per copy already piled up.
      playPop(countOf(c.scryfallId));
      setSession((prev) => {
        const i = prev.findIndex((e) => sessionKey(e) === key);
        if (i >= 0) return prev.map((e, j) => (j === i ? { ...e, qty: e.qty + 1 } : e));
        return [
          ...prev,
          {
            ...line,
            oracleId: printing.oracleId,
            name: c.oracle?.name ?? 'Unknown card',
            set: printing.set,
            collectorNumber: printing.collectorNumber,
            image: printing.imageNormal ?? undefined,
            qty: 1,
          },
        ];
      });
    } else {
      // Nothing to take back: no feedback either. Read through `latest`, since
      // a tile's tap handler is built on an earlier render than this one.
      if (!latest.current.session.some((e) => e.scryfallId === c.scryfallId)) return;
      setSession((prev) => {
        let i = prev.findIndex((e) => sessionKey(e) === key);
        // Fall back to any entry of this printing (e.g. the foil toggle moved since the +1).
        if (i < 0) i = prev.findLastIndex((e) => e.scryfallId === c.scryfallId);
        if (i < 0) return prev;
        const e = prev[i]!;
        return e.qty <= 1 ? prev.filter((_, j) => j !== i) : prev.map((x, j) => (j === i ? { ...x, qty: x.qty - 1 } : x));
      });
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
  // A pinned language from an older session can sit outside the list; keep it
  // in the cycle so the button can leave it and come back to it.
  const langOptions = LANGS.includes(lang) ? LANGS : [...LANGS, lang];
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

  const openList = () => {
    cameraRef.current?.pause();
    setListOpen(true);
  };

  const closeList = () => {
    setListOpen(false);
    cameraRef.current?.resume();
  };

  const finishScan = () => {
    clearStored();
    cameraRef.current?.stop();
    onClose();
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
    // A deck re-scan shows its diff first and reconciles instead of appending.
    // Every other destination is the shared write, which a drop uses too.
    if (target.kind === 'deck' && target.rescan) {
      const label = targetLabel(target);
      const changes = await buildRescanReview(session, target.deckId);
      if (changes.changes.length === 0 && !changes.refiles) {
        toast(`No changes: this ${targetNoun(target)} already matches your scan`);
        finishScan();
        return;
      }
      const res = await review({
        flow: 'rescan',
        lines: session.map((e) => entryLine(e, target)),
        source: 'scan',
        incomingLabel: 'Scanned',
        target: { id: target.deckId, name: label, kind: target.containerKind ?? 'deck' },
        preface: {
          title: 'Re-scan changes',
          body: <RescanChangesList changes={changes.changes} deckName={label} showBoards={scanBoards(target.containerKind, target.format).length > 1} />,
          nextLabel: changes.changes.length
            ? `Apply ${changes.changes.length} ${plural(changes.changes.length, 'change')}`
            : 'File the copies you scanned',
        },
      });
      if (!res) return; // backed out: the session is still there
      toast(`Updated ${label}${res.added ? ` · ${res.added} added to collection` : ''}`);
      finishScan();
      return;
    }
    // The questionnaire flows carry their own busy state; only the direct
    // writes need the double-tap guard.
    const direct = target.kind === 'wishlist' || target.kind === 'trade';
    if (direct) setCommitting(true);
    try {
      const message = await commitSession(target, session, review, 'Scanned');
      if (message === null) return; // backed out: the session is still there
      toast(message);
      finishScan();
    } finally {
      if (direct) setCommitting(false);
    }
  };

  const close = () =>
    void (async () => {
      if (total > 0) {
        const ok = await confirm({
          title: `Discard ${total} scanned ${plural(total, 'card')}?`,
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
  // sheets rendered through <Sheet> (session list, replace picker, re-scan
  // review, duplicates) register themselves and sit above this one; only the
  // inline layers need naming here. A commit in flight claims nothing.
  useDismiss(committing ? null : settingsOpen ? () => setSettingsOpen(false) : close);

  // This render's values, for everything that reads `latest` (declared up top).
  latest.current = { tray, session, locks, ownership, ring, trayHold, onLocked, bump };
  // Stable, so a memoized tile only repaints when its own props change.
  const onTileBump = useCallback((c: Candidate, delta: 1 | -1) => latest.current.bump(c, delta), []);

  // Everything pinned right now, as chips over the camera: a pin left on from
  // the last pile is exactly the sort of thing you notice one binder too late.
  const lockChips = [
    locks.finish ? FINISH_LABELS[locks.finish] : null,
    locks.lang ? locks.lang.toUpperCase() : null,
    locks.set ? locks.set.toUpperCase() : null,
  ].filter((s): s is string => !!s);

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
  /**
   * The lock ring before a lock: the agreeing frames banked towards one. Real
   * progress, not a timer — a blurry or disagreeing frame drops it back to zero.
   * Only while nothing is held, so a held lock's drain isn't fighting the camera
   * re-converging on the card that is still in frame.
   */
  const arming = !ring.held && live?.status === 'scanning' ? Math.min(1, live.streak / CONSENSUS_FRAMES) : 0;
  const boards = target.kind === 'deck' ? scanBoards(target.containerKind, target.format) : [];

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
          <ScanSettings
            locks={locks}
            candidates={tray?.candidates ?? null}
            autoAdd={autoAdd}
            onAutoAdd={setAutoAdd}
            onPinFinish={lockFinish}
            onPinLang={lockLang}
            onPinSet={(set) => setLocks((l) => ({ ...l, set }))}
            // Swap lenses without disturbing the session: the stream is all that changes.
            onPickCamera={(id) => void cameraRef.current?.switchTo(id || null)}
          />
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

        {boards.length > 1 && stage.kind === 'scanning' && (
          <div className="seg-row scan-cam-board" role="radiogroup" aria-label="Add to board">
            {boards.map((b) => (
              <button key={b} role="radio" aria-checked={board === b} className={board === b ? 'seg seg-active' : 'seg'} onClick={() => setBoard(b)}>
                {b === 'main' ? 'Main' : b === 'side' ? 'Side' : b === 'maybe' ? 'Maybe' : 'Commander'}
              </button>
            ))}
          </div>
        )}

        {stage.kind === 'scanning' && (
          <LockBadge held={ring.held} holdLeft={ring.holdLeft} arming={arming} hasTray={!!tray} onRelease={ring.release} />
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
                  dismissOffer();
                  toast('Downloading newer scan data in the background');
                }}
              >
                Download
              </button>
              <button
                onClick={() => {
                  if (rememberScanChoice) setPrefs({ scanDataPolicy: 'never' });
                  dismissOffer();
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
          <CyclePick
            label="Finish"
            locked={!!locks.finish}
            value={finish}
            options={FINISHES}
            render={(f) => FINISH_LABELS[f]}
            onPick={pickFinish}
          />
          <CyclePick label="Cond" value={condition} options={CONDITIONS} onPick={pickCondition} />
          <CyclePick
            label="Lang"
            locked={!!locks.lang}
            value={lang}
            options={langOptions}
            onPick={pickLang}
          />
          {setMissed && <span className="scan-pick-note">No {locks.set!.toUpperCase()} match</span>}
          {trayHold.pendingId && (
            <button className="scan-pick-new" onClick={trayHold.release}>
              <Icon name="refresh" size={12} /> New card
            </button>
          )}
        </div>
      )}

      {/* The row is yours while this drains. Accent means a different card has
          already locked and is waiting for the handover, so the change that
          follows is announced rather than sprung. */}
      <div className={trayHold.pendingId ? 'scan-tray-hold scan-tray-hold-new' : 'scan-tray-hold'} aria-hidden="true">
        <span style={{ transform: `scaleX(${trayHold.left})` }} />
      </div>

      <div
        className="scan-tray"
        ref={trayHold.elRef}
        onPointerDown={trayHold.hold}
        onScroll={(e) => {
          // Scrolled back to the start: you're done browsing, so hand the row
          // over now instead of sitting out the rest of the hold.
          if (e.currentTarget.scrollLeft <= 2) trayHold.release();
          else trayHold.hold();
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
              onBump={onTileBump}
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

      {/* The questionnaire stacks above the session list: every sheet shares
          one z-index, so DOM order is what decides. */}
      {intakeSheet}
      {confirmSheet}
    </div>,
    document.body,
  );
}
