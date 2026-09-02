import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CONDITIONS, type CollectionEntry, type ContainerKind, type Priced, type Printing } from '@mtg/shared';
import { CONTAINER_META } from '../deck/containers.js';
import { useFiling } from '../deck/useFiling.js';
import { getPrintingsForOracle } from '../db/queries.js';
import { db } from '../db/schema.js';
import { CopyGrid, copyDetail } from './CopyPicker.js';
import { Sheet } from './Sheet.js';

// "Assemble from my collection": the deck exists on screen, now go and find the
// cardboard. One card at a time, each showing the copies you own so a slot stops
// being "a Lightning Bolt" and becomes "that Beta one, lightly played" — which is
// what makes the green badge, the filed-in pills and the conflict count mean
// anything at all.
//
// Picking a copy that's filed somewhere else asks the usual move-or-both
// question, because taking a card out of one deck to build another is exactly
// what assembling one means.

/** One card to work through. Frozen when the walkthrough opens, so resolving a
 *  card doesn't renumber the ones behind it. */
export interface AssembleItem {
  slotId: string;
  oracleId: string;
  name: string;
}

export function AssembleSheet({
  containerId,
  kind,
  items,
  onClose,
}: {
  containerId: string;
  kind: ContainerKind;
  items: AssembleItem[];
  onClose: () => void;
}) {
  const meta = CONTAINER_META[kind];
  const { pin, sheet: filingSheet } = useFiling();
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState(0);
  const [skipped, setSkipped] = useState(0);

  const item = items[i];
  // The slot is read live: pinning part of it leaves a smaller slot behind, and
  // the header has to say how many copies are still looking for a home.
  const slot = useLiveQuery(async () => (item ? (await db.deckCards.get(item.slotId)) ?? null : null), [item?.slotId]);
  const owned = useLiveQuery(
    async () => (item ? db.collection.where('oracleId').equals(item.oracleId).toArray() : []),
    [item?.oracleId],
  );
  const [printings, setPrintings] = useState<Priced<Printing>[]>([]);
  useEffect(() => {
    if (!item) return;
    let live = true;
    void getPrintingsForOracle(item.oracleId).then((p) => {
      if (live) setPrintings(p);
    });
    return () => {
      live = false;
    };
  }, [item?.oracleId]);

  // What the slot asked for first, then newest edition, then best condition.
  // A slot that names a printing, a finish, a language or a minimum condition is
  // telling you which piece of cardboard it wants; those copies belong at the
  // front instead of somewhere down a grid of twelve Lightning Bolts. A slot
  // that names nothing scores every copy zero and the old order stands.
  const copies = useMemo(() => {
    const order = new Map(printings.map((p, n) => [p.scryfallId, n]));
    const rank = (e: CollectionEntry) => order.get(e.scryfallId) ?? printings.length;
    const fit = (e: CollectionEntry) => {
      if (!slot) return 0;
      let score = 0;
      if (slot.scryfallId && slot.scryfallId === e.scryfallId) score += 8;
      if (slot.finish && slot.finish === e.finish) score += 4;
      // Condition is a minimum, same as a wish: better than asked still fits.
      if (slot.condition && CONDITIONS.indexOf(e.condition) <= CONDITIONS.indexOf(slot.condition)) score += 2;
      if (slot.lang && slot.lang === e.lang) score += 1;
      return score;
    };
    return [...(owned ?? [])].sort(
      (a, b) =>
        fit(b) - fit(a) || rank(a) - rank(b) || CONDITIONS.indexOf(a.condition) - CONDITIONS.indexOf(b.condition),
    );
  }, [owned, printings, slot]);

  const done = i >= items.length;

  function advance() {
    setI((n) => n + 1);
  }

  async function choose(copy: CollectionEntry) {
    if (!slot || busy) return;
    const take = Math.min(copy.quantity, slot.quantity);
    setBusy(true);
    const mode = await pin(
      { id: slot.id, deckId: containerId, oracleId: slot.oracleId, board: slot.board, quantity: slot.quantity },
      {
        oracleId: slot.oracleId,
        scryfallId: copy.scryfallId,
        quantity: take,
        board: slot.board,
        wants: { condition: copy.condition, finish: copy.finish, lang: copy.lang },
        label: item?.name,
        sub: copyDetail(copy),
      },
    );
    setBusy(false);
    if (mode === null) return; // backed out of the move question
    setPlaced((n) => n + take);
    // A copy that only covers part of the slot leaves the rest behind: stay on
    // this card and let them pick something for the remainder.
    if (take >= slot.quantity) advance();
  }

  if (done) {
    return (
      <Sheet onClose={onClose} title={`${meta.Noun} assembled`} label="Assembling finished">
        <p className="search-meta">
          {placed === 0
            ? 'Nothing pointed at a copy this time.'
            : `${placed} card${placed === 1 ? '' : 's'} now point at a copy you own.`}
          {skipped > 0 && ` ${skipped} skipped.`}
        </p>
        <p className="fine-print">
          Cards you skipped keep their slot — pick a copy any time from the card’s own sheet.
        </p>
        <div className="sheet-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
        {filingSheet}
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose} className="assemble-sheet" label={`Assembling ${meta.noun}`}>
      <div className="assemble-head">
        <div className="grow">
          <h2 className="assemble-name">{item?.name ?? 'Card'}</h2>
          <p className="search-meta">
            Card {i + 1} of {items.length}
            {slot && (
              <>
                {' · '}
                <strong>{slot.quantity}</strong> to place
              </>
            )}
          </p>
        </div>
      </div>
      <div className="assemble-bar" aria-hidden>
        <span style={{ width: `${(i / items.length) * 100}%` }} />
      </div>

      {copies.length === 0 ? (
        <p className="search-meta">You don’t own a copy of this one any more.</p>
      ) : (
        <CopyGrid
          copies={copies}
          printings={printings}
          hereId={containerId}
          selected={
            slot
              ? {
                  scryfallId: slot.scryfallId ?? '',
                  condition: slot.condition ?? '',
                  finish: slot.finish ?? '',
                  lang: slot.lang ?? '',
                }
              : undefined
          }
          onSelect={(copy) => void choose(copy)}
        />
      )}

      <div className="sheet-actions">
        <button onClick={onClose}>Stop here</button>
        <button
          disabled={busy}
          onClick={() => {
            setSkipped((n) => n + 1);
            advance();
          }}
        >
          Skip
        </button>
      </div>
      {filingSheet}
    </Sheet>
  );
}
