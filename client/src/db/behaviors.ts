import { sanitizeCardBehavior, type CardBehavior, type DeckBehavior } from '@mtg/shared';
import { db } from './schema.js';

// Readers for authored card behavior. Kept apart from dataAccess.ts because
// sanitizeCardBehavior drags the whole behavior vocabulary (shared/behavior.ts)
// with it, and only the lazy deck-analysis screens read behaviors.

/**
 * A stored behavior, read through the sanitizer. A row that came down from
 * another device is stored as written there (transfer/payload.ts keeps the
 * grammar whole so nothing is lost on an older build), which means the rules
 * in it are only what THIS build can read once they pass through here. A
 * behavior this build cannot read at all plays as nothing, as it always did.
 */
function readBehavior(row: DeckBehavior): CardBehavior | null {
  return sanitizeCardBehavior(row.behavior);
}

/** Every authored behavior in one deck, as a map the sim deck builder can take. */
export async function deckBehaviorMap(deckId: string): Promise<Map<string, CardBehavior>> {
  const rows = await db.deckBehaviors.where('deckId').equals(deckId).toArray();
  const out = new Map<string, CardBehavior>();
  for (const r of rows) {
    const behavior = readBehavior(r);
    if (behavior) out.set(r.oracleId, behavior);
  }
  return out;
}

/** One card's rule as another deck wrote it, with every deck that wrote the same one. */
export interface BorrowableBehavior {
  behavior: CardBehavior;
  /** Deck names, most recently written first. */
  decks: string[];
  updatedAt: number;
}

/**
 * Rules the user wrote for the same card in their other decks (rebuild plan
 * C4), by oracleId. Identical rules from several decks are one offer: the rows
 * are stored through the sanitizer, so the same rule is the same bytes.
 */
export async function otherDeckBehaviors(deckId: string): Promise<Map<string, BorrowableBehavior[]>> {
  const [rows, decks] = await Promise.all([db.deckBehaviors.toArray(), db.decks.toArray()]);
  const names = new Map(decks.map((d) => [d.id, d.name]));
  const out = new Map<string, BorrowableBehavior[]>();
  const byKey = new Map<string, BorrowableBehavior>();
  for (const r of [...rows].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (r.deckId === deckId) continue;
    const name = names.get(r.deckId);
    // A row whose deck has not synced down yet has nobody to credit.
    if (name === undefined) continue;
    const behavior = readBehavior(r);
    if (!behavior) continue;
    const key = `${r.oracleId}\n${JSON.stringify(behavior)}`;
    const seen = byKey.get(key);
    if (seen) {
      if (!seen.decks.includes(name)) seen.decks.push(name);
      continue;
    }
    const offer: BorrowableBehavior = { behavior, decks: [name], updatedAt: r.updatedAt };
    byKey.set(key, offer);
    const list = out.get(r.oracleId);
    if (list) list.push(offer);
    else out.set(r.oracleId, [offer]);
  }
  return out;
}
