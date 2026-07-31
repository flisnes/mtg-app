import { useLiveQuery } from 'dexie-react-hooks';
import type { ContainerKind } from '@mtg/shared';
import { db } from '../db/schema.js';
import { containerKind } from '../deck/containers.js';
import { getOracleCardsByIds, getOwnedCountsFor, getPrintingsByIds } from '../db/queries.js';
import { addToTotal, formatTotal, pricedForFinish, type PriceTotal } from './CardSorting.js';

// Compact "total value" readout for page headers. It sits in the empty space
// beside a page's options menu, so it costs no extra vertical room.

export function HeaderValue({
  label = 'Total value',
  value,
  note,
}: {
  label?: string;
  value: string | undefined;
  /** Second line under the amount, for context the amount leaves out. */
  note?: string;
}) {
  return (
    <div className="header-value" title={value ? `${label}: ${value}${note ? ` (${note})` : ''}` : undefined}>
      <span className="header-value-label">{label}</span>
      <span className="header-value-amount">{value ?? '…'}</span>
      {note && <span className="header-value-note">{note}</span>}
    </div>
  );
}

/** Total value of the collection (or just the copies marked for trade). */
export function useCollectionValue(onlyTrade = false): PriceTotal | undefined {
  return useLiveQuery(async () => {
    const entries = await db.collection.toArray();
    const relevant = onlyTrade ? entries.filter((e) => e.quantityForTrade > 0) : entries;
    const [oracleMap, printMap] = await Promise.all([
      getOracleCardsByIds(relevant.map((e) => e.oracleId)),
      getPrintingsByIds(relevant.map((e) => e.scryfallId)),
    ]);
    const total: PriceTotal = { eur: 0, usd: 0 };
    for (const e of relevant) {
      const qty = onlyTrade ? e.quantityForTrade : e.quantity;
      addToTotal(total, qty, pricedForFinish(printMap.get(e.scryfallId), e.finish), oracleMap.get(e.oracleId));
    }
    return total;
  }, [onlyTrade]);
}

// ---- Deck / binder / box value ----
// A container is worth two different numbers and only one of them is real money:
// what the copies you actually have are worth, and what the whole list would
// cost. Owned leads everywhere; the gap follows as context.

type PriceSource = { priceEur: number | null; priceUsd: number | null } | undefined;

export interface ContainerValue {
  /** Value of the copies of these cards you hold in the collection. */
  owned: PriceTotal;
  /** Value of every slot, owned or not. */
  listed: PriceTotal;
}

/** One slot of a container, plus how many copies of that card the collection holds. */
export interface ValueSlot {
  oracleId: string;
  quantity: number;
  /** Copies of this oracle card owned, across every printing. */
  owned: number;
  /** "Any printing" basic land — free, and no claim on the collection. */
  anyBasic?: boolean;
  printing?: PriceSource;
  oracle?: PriceSource;
}

function emptyValue(): ContainerValue {
  return { owned: { eur: 0, usd: 0 }, listed: { eur: 0, usd: 0 } };
}

function addValue(into: ContainerValue, from: ContainerValue): void {
  into.owned.eur += from.owned.eur;
  into.owned.usd += from.owned.usd;
  into.listed.eur += from.listed.eur;
  into.listed.usd += from.listed.usd;
}

/** Split a container's slots into what you own and what the full list is worth. */
export function containerValue(slots: ValueSlot[]): ContainerValue {
  const value = emptyValue();
  // "Any printing" basics are worth nothing on either side of the ledger: you
  // never bought them for this deck, and nobody prices a lands-box Island.
  const counted = slots.filter((s) => !s.anyBasic);
  // One copy in the collection covers one slot, so spend a pool per oracle card:
  // the same card in a mainboard and a sideboard isn't two copies you own.
  const pool = new Map<string, number>();
  for (const s of counted) if (!pool.has(s.oracleId)) pool.set(s.oracleId, s.owned);
  for (const s of counted) {
    addToTotal(value.listed, s.quantity, s.printing, s.oracle);
    const have = Math.min(pool.get(s.oracleId) ?? 0, s.quantity);
    if (have > 0) {
      pool.set(s.oracleId, (pool.get(s.oracleId) ?? 0) - have);
      addToTotal(value.owned, have, s.printing, s.oracle);
    }
  }
  return value;
}

/** What the copies you're missing would add on top of the owned value. */
export function missingValue({ owned, listed }: ContainerValue): PriceTotal {
  return { eur: Math.max(0, listed.eur - owned.eur), usd: Math.max(0, listed.usd - owned.usd) };
}

export interface ContainersValue {
  /** Value per container, keyed by its row id. */
  byId: Map<string, ContainerValue>;
  /** Every container of the kind added up. */
  total: ContainerValue;
}

/** Value of every deck, binder or box of one kind — per row and in total. */
export function useContainersValue(kind: ContainerKind): ContainersValue | undefined {
  return useLiveQuery(async () => {
    const rows = (await db.decks.toArray()).filter((d) => containerKind(d) === kind);
    const ids = new Set(rows.map((d) => d.id));
    const cards = (await db.deckCards.toArray()).filter((c) => ids.has(c.deckId));
    const [oracleMap, printMap, ownedMap] = await Promise.all([
      getOracleCardsByIds(cards.map((c) => c.oracleId)),
      getPrintingsByIds(cards.map((c) => c.scryfallId).filter((s): s is string => !!s)),
      getOwnedCountsFor(cards.map((c) => c.oracleId)),
    ]);
    const slots = new Map<string, ValueSlot[]>();
    for (const c of cards) {
      const list = slots.get(c.deckId) ?? [];
      list.push({
        oracleId: c.oracleId,
        quantity: c.quantity,
        owned: ownedMap.get(c.oracleId) ?? 0,
        ...(c.anyBasic ? { anyBasic: true } : {}),
        printing: c.scryfallId ? printMap.get(c.scryfallId) : undefined,
        oracle: oracleMap.get(c.oracleId),
      });
      slots.set(c.deckId, list);
    }
    const byId = new Map<string, ContainerValue>();
    const total = emptyValue();
    for (const row of rows) {
      // Owned copies are pooled per container, so a card filed in two boxes (or
      // brewed into three decks) counts in each — same as the card counts do.
      const value = containerValue(slots.get(row.id) ?? []);
      byId.set(row.id, value);
      addValue(total, value);
    }
    return { byId, total };
  }, [kind]);
}

/** Format a live total for the header, or undefined while it loads. */
export function headerValue(total: PriceTotal | undefined): string | undefined {
  return total ? formatTotal(total) : undefined;
}

/** Format a total, or undefined when there is nothing worth showing (or no data yet). */
export function valueText(total: PriceTotal | undefined): string | undefined {
  if (!total || (total.eur <= 0 && total.usd <= 0)) return undefined;
  return formatTotal(total);
}
