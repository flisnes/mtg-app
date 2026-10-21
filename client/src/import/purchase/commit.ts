import type { UserEvent } from '@mtg/shared';
import { db } from '../../db/schema.js';
import { newId } from '../../db/keys.js';
import { putSyncedMany, write } from '../../db/write.js';
import type { PlannedMatch } from './plan.js';

// Writing a purchase's corrections: matched copies' collection.add events get
// the purchase's date and price. An add that covers more copies than the
// purchase did is split, the purchased copies moving to a new event, so the
// rest keep the date and price they had. No collection row changes: this is
// the copies' history being corrected, which is why it works the same for a
// card you have since traded away.
//
// Copies you tick to add are not written here. They go through the intake
// questionnaire like every other bulk add (filing, "is this the copy you
// have?"), carrying the receipt's date and price on ResolvedLine.acquired.
//
// Every event written carries the order's batchId, which is what lets a second
// import of the same file find its copies again (plan.ts) and keeps the edit
// history from offering to undo it: undoing a batch reverses its events, and
// reversing these adds would take away cards you owned before the import.

export interface CommitLine {
  unitCents: number;
  /** Adds to re-date and re-price (from planPurchase). */
  matches: PlannedMatch[];
}

export async function commitPurchase(
  lines: readonly CommitLine[],
  opts: {
    batchId: string;
    batchLabel: string;
    date: number | null;
    /** Adds the review offered and the user unticked: left exactly as they are. */
    exclude?: Iterable<string>;
  },
): Promise<number> {
  return write([db.events, db.outbox], async ({ now }) => {
    const stamp = { batchId: opts.batchId, batchLabel: opts.batchLabel, updatedAt: now };
    const out: UserEvent[] = [];
    let updated = 0;

    // Several lines can take from one add (a scan of 4 copies, bought as 1 NM
    // and 3 SP), so each add is carved up in turn: what's left of it after
    // every line has had its share stays where it was.
    const carving = new Map<string, UserEvent>();
    for (const line of lines) {
      for (const m of line.matches) {
        const ev = carving.get(m.eventId) ?? (await db.events.get(m.eventId));
        if (!ev) continue;
        const qty = ev.qty ?? 1;
        const take = Math.min(m.take, qty);
        if (take <= 0) continue;
        const bought: Partial<UserEvent> = {
          ts: opts.date ?? ev.ts,
          priceEurCents: line.unitCents,
          ...stamp,
        };
        if (take === qty) {
          out.push({ ...ev, ...bought });
          // Nothing left of it to carve; a later line asking for more gets nothing.
          carving.set(m.eventId, { ...ev, qty: 0 });
        } else {
          out.push({ ...ev, ...bought, id: newId(), qty: take });
          carving.set(m.eventId, { ...ev, qty: qty - take });
        }
        updated += take;
      }
    }
    for (const [id, rest] of carving) {
      // A partly carved add keeps its own id, date and price for what's left.
      if ((rest.qty ?? 0) > 0 && !out.some((e) => e.id === id)) out.push({ ...rest, updatedAt: now });
    }

    // One order, one date. Copies an earlier import of it pinned (a Cardmarket
    // CSV can name a card its PDF can't, but has no date) take this one too.
    // Adds only: a copy swapped out in the questionnaire left today, not then.
    // Not the ones unticked in the review: "leave this one" means that.
    if (opts.date != null) {
      const leave = new Set([...out.map((e) => e.id), ...(opts.exclude ?? [])]);
      for (const e of await db.events.where('batchId').equals(opts.batchId).toArray()) {
        if (e.kind !== 'collection.add') continue;
        if (!leave.has(e.id) && e.ts !== opts.date) out.push({ ...e, ts: opts.date, updatedAt: now });
      }
    }

    await putSyncedMany('events', out);
    return updated;
  }, { batchId: opts.batchId, batchLabel: opts.batchLabel });
}
