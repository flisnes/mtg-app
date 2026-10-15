import { deckBehaviorId } from '@mtg/shared';
import type { CardBehavior, DeckBehavior } from '@mtg/shared';
import { db } from './schema.js';
import { deleteSynced, putSynced } from './write.js';

// ---------------------------------------------------------------------------
// Card behavior. What the user says a card does in this deck, overriding the
// card database's reading of its oracle text. See shared/src/behavior.ts.
// The readers live in db/behaviors.ts so the sanitizer (and the 40 kB
// vocabulary it needs) stays out of the boot chunk.
// ---------------------------------------------------------------------------

/**
 * Write one card's behavior, or clear it with null.
 *
 * Clearing stores nothing rather than an empty rule list: "this card does
 * nothing" and "we never asked" are the same instruction to the sequencer, and
 * only one of them should count towards the authored number on the coverage
 * line.
 *
 * Stamped after the row it replaces, not just at Date.now(). The rule on
 * screen may have come from another device whose clock runs ahead, and sync
 * is last-writer-wins on those stamps: an edit stamped earlier than what it
 * edits loses on the server, which hands the old rule back a couple of
 * seconds after the toast said it saved.
 */
export async function setCardBehavior(deckId: string, oracleId: string, behavior: CardBehavior | null): Promise<void> {
  const rowId = deckBehaviorId(deckId, oracleId);
  await db.transaction('rw', [db.deckBehaviors, db.outbox], async () => {
    const existing = await db.deckBehaviors.get(rowId);
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    if (!behavior || (behavior.rules.length === 0 && !behavior.cast?.length)) {
      if (!existing) return;
      await deleteSynced('deckBehaviors', rowId, updatedAt);
      return;
    }
    const row: DeckBehavior = { id: rowId, deckId, oracleId, behavior, updatedAt };
    await putSynced('deckBehaviors', row);
  });
}
