import { isPurchaseBatch, type CollectionEntry, type Condition, type Finish, type UserEvent } from '@mtg/shared';

// Which copies a purchase was. Pure, so the matching rules can be tested on
// plain arrays.
//
// The unit is the collection.add event, not the collection row. Every copy you
// ever registered has one, and it outlives the copy: a card you scanned in and
// later traded away still has its add in the log, so its acquisition date and
// price can be set right without a row being touched or recreated. Rows only
// come into it to say whether you still have the card.
//
// An add can be this purchase's copy when it is the same printing, finish and
// language, and:
//   - it wasn't received in a trade or opened from sealed product (those
//     copies came from somewhere else; a trade's backfill add is fine, that
//     one *is* a card you had before the trade);
//   - no other purchase has claimed it already;
//   - it went in no earlier than the day before the purchase (you can't have
//     registered a copy before you bought it), when the purchase has a date.
// Adds this same order claimed on an earlier import go first, so importing a
// file twice updates the same copies again rather than reaching for new ones.
// After that, oldest first. The grade is a preference, not a rule: your NM
// scan of a card the seller called EX is still the card you bought.

const DAY = 24 * 60 * 60 * 1000;

export interface PlanLine {
  scryfallId: string;
  finish: Finish;
  lang: string;
  condition: Condition;
  quantity: number;
  /** Paid per copy. On a re-import, the copy already carrying this price is this line's. */
  unitCents?: number;
}

export interface PlannedMatch {
  eventId: string;
  /** Copies of that event this line takes. */
  take: number;
  /** The event as it stands: what the review shows as "on record". */
  ts: number;
  priceEurCents: number | null;
  condition?: Condition;
}

export interface LinePlan {
  matches: PlannedMatch[];
  /** Copies with no add to pin on. */
  missing: number;
  /** Copies of this printing, finish and language in the collection now. */
  owned: number;
  /** Matched copies were last updated by this same order. */
  reimport: boolean;
}

function eligible(e: UserEvent, batchId: string, date: number | null): boolean {
  if (e.kind !== 'collection.add' || !e.scryfallId) return false;
  if ((e.source === 'trade' || e.tradeId) && !e.reconcile) return false;
  if (e.source === 'sealed') return false;
  if (e.batchId === batchId) return true;
  if (isPurchaseBatch(e.batchId)) return false;
  return date == null || e.ts >= date - DAY;
}

const copyKey = (x: { scryfallId?: string | null; finish?: Finish; lang?: string }) =>
  `${x.scryfallId}|${x.finish ?? 'nonfoil'}|${x.lang ?? 'en'}`;

export function planPurchase(
  lines: readonly PlanLine[],
  events: readonly UserEvent[],
  collection: readonly CollectionEntry[],
  opts: { batchId: string; date: number | null },
): LinePlan[] {
  // Adds per copy identity, in the order they should be handed out.
  const pools = new Map<string, UserEvent[]>();
  for (const e of events) {
    if (!eligible(e, opts.batchId, opts.date)) continue;
    const k = copyKey(e);
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k)!.push(e);
  }
  for (const pool of pools.values()) {
    pool.sort((a, b) => Number(b.batchId === opts.batchId) - Number(a.batchId === opts.batchId) || a.ts - b.ts);
  }
  const left = new Map<string, number>();
  for (const pool of pools.values()) for (const e of pool) left.set(e.id, e.qty ?? 1);

  const owned = new Map<string, number>();
  for (const r of collection) owned.set(copyKey(r), (owned.get(copyKey(r)) ?? 0) + r.quantity);

  const plans: LinePlan[] = lines.map((l) => ({
    matches: [],
    missing: l.quantity,
    owned: owned.get(copyKey(l)) ?? 0,
    reimport: false,
  }));

  // Two passes: first every line takes adds of its own grade, then whatever is
  // left. Otherwise an order of "1 NM + 3 SP" of the same card could hand the
  // NM line the SP copies just because it came first in the file.
  for (const sameGrade of [true, false]) {
    lines.forEach((l, i) => {
      const plan = plans[i]!;
      // Two lines of one card at two prices (CardTrader lists each copy on its
      // own): on a re-import each takes back the copy with its own price, not
      // whichever the order happens to hand out first. Stable, so ties keep
      // the pool's order.
      const mine = (e: UserEvent) => e.batchId === opts.batchId && l.unitCents != null && e.priceEurCents === l.unitCents;
      const pool = [...(pools.get(copyKey(l)) ?? [])].sort((a, b) => Number(mine(b)) - Number(mine(a)));
      for (const e of pool) {
        if (plan.missing === 0) break;
        if (sameGrade && e.condition !== l.condition) continue;
        const avail = left.get(e.id) ?? 0;
        if (avail === 0) continue;
        const take = Math.min(avail, plan.missing);
        left.set(e.id, avail - take);
        plan.missing -= take;
        const had = plan.matches.find((m) => m.eventId === e.id);
        if (had) had.take += take;
        else {
          plan.matches.push({
            eventId: e.id,
            take,
            ts: e.ts,
            priceEurCents: e.priceEurCents ?? null,
            ...(e.condition ? { condition: e.condition } : {}),
          });
        }
        if (e.batchId === opts.batchId) plan.reimport = true;
      }
    });
  }
  return plans;
}
