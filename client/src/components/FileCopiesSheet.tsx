import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CONDITIONS, type CollectionEntry, type ContainerKind, type Priced, type Printing } from '@mtg/shared';
import { CONTAINER_META } from '../deck/containers.js';
import { collectionKey } from '../db/dataAccess.js';
import { roomForCopies, type FilingCopy } from '../deck/filing.js';
import { getPrintingsForOracle } from '../db/queries.js';
import { CopyGrid, copyDetail } from './CopyPicker.js';
import { Sheet } from './Sheet.js';

// "Which copies?" — the step between picking a container and writing the slots.
//
// Own two Command Beacons, one already in a Commander deck and one loose, and
// "file this copy" has exactly one sensible answer: the loose one. Handing the
// whole line over files both, which is what this asks about instead. Tap a copy
// to send it, tap it again to add another (or to take the last one back), then
// file. Same grid as "pick one from my collection" and the deck assembler, so
// each tile still says where that copy is right now — picking one that's in
// another deck means taking it out, and the move-or-both question still follows.
//
// Only worth asking when you own more than one copy; the card sheet files a
// single copy without this detour.

/** How many copies of each of your rows are going in, by collection entry id. */
type Picked = Map<string, number>;

export function FileCopiesSheet({
  oracleId,
  cardName,
  containerId,
  containerName,
  kind,
  copies,
  startWith,
  onCancel,
  onFile,
}: {
  oracleId: string;
  cardName: string;
  containerId: string;
  containerName: string;
  kind: ContainerKind;
  /** Every copy of this card you own. */
  copies: CollectionEntry[];
  /** The row the card sheet was opened on: one of it is taken to begin with, so
   *  the button they pressed ("file this copy") still means what it said. */
  startWith?: string;
  onCancel: () => void;
  onFile: (picked: FilingCopy[]) => void;
}) {
  const meta = CONTAINER_META[kind];
  // Room the container has left, in the same units the filing engine caps with,
  // so a tile can never offer a copy the write would drop.
  const room = useLiveQuery(() => roomForCopies(containerId, [oracleId]), [containerId, oracleId]);
  const [picked, setPicked] = useState<Picked>(new Map());
  const [printings, setPrintings] = useState<Priced<Printing>[]>([]);

  useEffect(() => {
    let live = true;
    void getPrintingsForOracle(oracleId).then((p) => {
      if (live) setPrintings(p);
    });
    return () => {
      live = false;
    };
  }, [oracleId]);

  // Newest edition first, best condition first — the copy you'd reach for.
  const shown = useMemo(() => {
    const order = new Map(printings.map((p, n) => [p.scryfallId, n]));
    const rank = (e: CollectionEntry) => order.get(e.scryfallId) ?? printings.length;
    return [...copies].sort(
      (a, b) => rank(a) - rank(b) || CONDITIONS.indexOf(a.condition) - CONDITIONS.indexOf(b.condition),
    );
  }, [copies, printings]);

  // One of the copy they came from, as soon as we know there's room for it.
  useEffect(() => {
    if (!room || !startWith) return;
    const e = copies.find((c) => c.id === startWith);
    if (e && (room.get(collectionKey(e)) ?? 0) > 0) setPicked(new Map([[e.id, 1]]));
  }, [room, startWith, copies]);

  // Rows that differ only in what's remarkable about the cardboard (your altered
  // Bolt and your plain one) are one copy identity to the filing engine, so they
  // share a room and the tally has to be read across them.
  const roomLeft = (e: CollectionEntry, from: Picked): number => {
    const key = collectionKey(e);
    let left = room?.get(key) ?? 0;
    from.forEach((n, id) => {
      const other = copies.find((c) => c.id === id);
      if (other && collectionKey(other) === key) left -= n;
    });
    return Math.max(0, Math.min(e.quantity - (from.get(e.id) ?? 0), left));
  };
  const roomFor = (e: CollectionEntry) => roomLeft(e, picked);

  // Tap to take one more, and past the last one back round to none: a tile is a
  // row, not a copy, so this is the only place a count can go up or down.
  function tap(e: CollectionEntry) {
    setPicked((cur) => {
      const next = new Map(cur);
      if (roomLeft(e, cur) === 0) next.delete(e.id);
      else next.set(e.id, (cur.get(e.id) ?? 0) + 1);
      return next;
    });
  }

  const total = [...picked.values()].reduce((n, q) => n + q, 0);
  const noRoom = !!room && shown.length > 0 && shown.every((e) => roomFor(e) === 0 && !picked.get(e.id));

  function confirm() {
    const out: FilingCopy[] = [];
    for (const [id, quantity] of picked) {
      const e = copies.find((c) => c.id === id);
      if (!e || quantity <= 0) continue;
      out.push({
        oracleId: e.oracleId,
        scryfallId: e.scryfallId,
        quantity,
        board: 'main',
        wants: { condition: e.condition, finish: e.finish, lang: e.lang },
        label: cardName,
        sub: copyDetail(e),
      });
    }
    onFile(out);
  }

  return (
    <Sheet
      onClose={onCancel}
      className="file-copies-sheet"
      title="Which copies?"
      label={`Choose the copies going into ${containerName}`}
    >
      <p className="search-meta">
        Tap the copies of {cardName} going into {containerName}. Tap one again for a second copy, or once more to
        take it back.
      </p>
      {room === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : (
        <CopyGrid
          copies={shown}
          printings={printings}
          hereId={containerId}
          picked={picked}
          roomFor={roomFor}
          onSelect={tap}
        />
      )}
      {noRoom && (
        <p className="fine-print">
          Every copy you own is already in this {meta.noun}. Nothing left to file.
        </p>
      )}
      <div className="sheet-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={total === 0} onClick={confirm}>
          {total <= 1 ? `File in ${meta.noun}` : `File ${total} copies`}
        </button>
      </div>
    </Sheet>
  );
}
