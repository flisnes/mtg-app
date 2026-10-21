import { useEffect, useRef, useState } from 'react';
import type { Finish } from '@mtg/shared';
import { useIntakeReview } from '../import/intake/useIntakeReview.js';
import { identifyDrop, loadDropIndex, type DropMatch } from '../scan/dropIdentify.js';
import type { DropItem } from '../scan/dropRead.js';
import { checkScanDataUpdate, downloadScanData, type ScanDataManifest } from '../scan/store.js';
import { commitSession, mergeSession, sessionTotal, type ScanTarget, type SessionEntry } from '../scan/session.js';
import { SessionSheet } from './SessionSheet.js';
import { useConfirm } from './ConfirmSheet.js';
import { useToast } from './Toast.js';
import { useAsyncAction } from './useAsyncAction.js';
import { plural } from '../util/format.js';

// The review for card images dropped onto a page (desktop drag and drop). It is
// the scanner's session list with the camera taken away: each dropped image is
// identified in the background and lands as a line, the edition is a tap away
// when the art alone couldn't settle it, and "Add N cards" writes through the
// same questionnaire a scan does. More drops while it is open join the list.

export interface DropBatch {
  /** Bumped per drop, so the same items dropped twice still count twice. */
  seq: number;
  items: DropItem[];
}

interface Failure {
  label: string;
  reason: string;
}

function toEntry({ printing, oracle, lang }: DropMatch): SessionEntry {
  // An image says nothing about foil, so it's nonfoil unless the printing
  // never came that way.
  const finish: Finish = printing.finishes.includes('nonfoil') ? 'nonfoil' : (printing.finishes[0] ?? 'nonfoil');
  return {
    scryfallId: printing.scryfallId,
    oracleId: printing.oracleId,
    name: oracle.name,
    set: printing.set,
    collectorNumber: printing.collectorNumber,
    image: printing.imageNormal ?? undefined,
    finish,
    lang: lang ?? 'en',
    condition: 'NM',
    board: 'main',
    qty: 1,
  };
}

export function DropSheet({ target, batch, onClose }: { target: ScanTarget; batch: DropBatch; onClose: () => void }) {
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [working, setWorking] = useState(0);
  const [failures, setFailures] = useState<Failure[]>([]);
  // Images waiting on the card-art index, which needs the user's say-so to download.
  const [waiting, setWaiting] = useState<{ items: DropItem[]; manifest: ScanDataManifest | null } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const { open: review, sheet: intakeSheet } = useIntakeReview();
  const { confirm, sheet: confirmSheet } = useConfirm();
  const toast = useToast();
  const action = useAsyncAction();
  // One at a time: the OCR worker is single-threaded anyway, and a folder of
  // fifty scans shouldn't decode fifty images at once.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const closed = useRef(false);
  const seen = useRef(0);
  // The index the beacon offered, once it has offered one.
  const manifestRef = useRef<ScanDataManifest | null>(null);

  const enqueue = (items: DropItem[]) => {
    setWorking((n) => n + items.length);
    for (const item of items) {
      chain.current = chain.current.then(async () => {
        if (closed.current) return;
        const out = await identifyDrop(item);
        if (closed.current) return;
        setWorking((n) => n - 1);
        if (out.kind === 'match') setEntries((prev) => mergeSession([...prev, toEntry(out.match)]));
        else if (out.kind === 'fail') setFailures((prev) => [...prev, { label: item.label, reason: out.reason }]);
        else {
          // Ask the beacon until it answers: a server that was down for the
          // first image may be back by the next one.
          if (!manifestRef.current) {
            const u = await checkScanDataUpdate();
            if (u.kind === 'update') manifestRef.current = u.manifest;
          }
          const manifest = manifestRef.current;
          setWaiting((w) => ({ items: [...(w?.items ?? []), item], manifest }));
        }
      });
    }
  };

  useEffect(() => {
    if (batch.seq === seen.current) return;
    seen.current = batch.seq;
    enqueue(batch.items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.seq]);

  // StrictMode mounts twice on one instance; the flag must re-open on the second.
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  const download = async () => {
    if (!waiting?.manifest) return;
    setDownloading(true);
    try {
      await downloadScanData(waiting.manifest);
      await loadDropIndex();
      const items = waiting.items;
      setWaiting(null);
      manifestRef.current = null;
      enqueue(items);
    } catch (e) {
      toast(`Download failed: ${(e as Error).message}`);
    } finally {
      setDownloading(false);
    }
  };

  const total = sessionTotal(entries);

  const complete = async () => {
    if (committing || total === 0) return;
    const direct = target.kind === 'wishlist' || target.kind === 'trade';
    if (direct) setCommitting(true);
    try {
      const message = await commitSession(target, entries, review, 'Dropped');
      if (message === null) return;
      toast(message);
      onClose();
    } finally {
      if (direct) setCommitting(false);
    }
  };

  const close = () =>
    void (async () => {
      if (total > 0) {
        const ok = await confirm({
          title: `Discard ${total} dropped ${plural(total, 'card')}?`,
          body: 'Nothing has been added yet.',
          confirmLabel: 'Discard',
          cancelLabel: 'Keep them',
          danger: true,
        });
        if (!ok) return;
      }
      onClose();
    })();

  const waitingCount = waiting?.items.length ?? 0;
  const notice =
    working > 0 || failures.length > 0 || waitingCount > 0 ? (
      <div className="drop-notice" role="status">
        {working > 0 && (
          <p className="drop-working">
            Identifying {working} {plural(working, 'image')}…
          </p>
        )}
        {waitingCount > 0 &&
          (waiting?.manifest ? (
            <p className="drop-index">
              Matching {waitingCount === 1 ? 'this image' : `these ${waitingCount} images`} needs a one-time download of the
              card-art index ({(waiting.manifest.bytes / 1e6).toFixed(1)} MB).{' '}
              <button className="primary" disabled={downloading} onClick={() => void download()}>
                {downloading ? 'Downloading…' : 'Download'}
              </button>
            </p>
          ) : (
            <p className="drop-index">
              {waitingCount} {plural(waitingCount, 'image')} can’t be matched right now: the card-art index isn’t
              available.
            </p>
          ))}
        {failures.length > 0 && (
          <ul className="drop-failures">
            {failures.map((f, i) => (
              <li key={i}>
                <strong>{f.label}</strong>: {f.reason}
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null;

  return (
    <>
      <SessionSheet
        entries={entries}
        target={target}
        total={total}
        busy={committing}
        onChange={setEntries}
        onComplete={() => action.run('add the dropped cards', complete)}
        onClose={close}
        title="Dropped cards"
        emptyText={working > 0 ? 'Looking at your images…' : 'Drop card images here to add them.'}
        closeLabel="Cancel"
        notice={notice}
      />
      {intakeSheet}
      {confirmSheet}
    </>
  );
}
