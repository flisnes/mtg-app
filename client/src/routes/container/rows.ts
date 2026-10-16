import type { DeckBoard, OracleCard, Priced, Printing, SetTypeMap, SlotCopyFields, SlotShape } from '@mtg/shared';
import { pickOwnedPrinting } from '../../cardDb/preferredPrinting.js';
import { cardSortFields, sortCards, type CardSortPrefs } from '../../components/CardSorting.js';
import type { ClipboardSlot } from '../../deck/cardClipboard.js';
import type { FilingCopy } from '../../deck/filing.js';
import type { Prefs } from '../../prefs.js';
import { groupBy, sumQty } from '../../util/groupBy.js';

/** One slot of this container, joined to its card and what the collection holds.
 *  Everything the slot itself says comes from SlotShape. */
export interface Row extends SlotShape {
  id: string;
  oracleId: string;
  quantity: number;
  board: DeckBoard;
  oracle?: Priced<OracleCard>;
  printing?: Priced<Printing>;
  owned: number;
}
/** A Row before the ownership index has counted its copies. */
export type SlotRow = Omit<Row, 'owned'>;

/** What a card row hands the CardSheet to edit a deck slot (incl. commander context). */
export interface DeckCardEdit extends SlotShape {
  id: string;
  quantity: number;
  board: DeckBoard;
  deckId: string;
  commanderDeck: boolean;
}

/** What a tile hands the sheet: the slot, and (stacked) the other slots of the same card. */
export interface EditTarget {
  card: Priced<OracleCard>;
  deckCard: DeckCardEdit;
  slots?: DeckCardEdit[];
}

/**
 * Stack printings, deck edition: the slots of one card in one board folded
 * into one tile. The lead is the slot whose edition the tile wears (the
 * preferred one among the slots' printings), so the tile's key is a real slot
 * id and the cursor, the selection and the card keys keep working on it.
 */
export interface SlotStack {
  lead: Row;
  rows: Row[];
  quantity: number;
}

/** Grouping context, or null when the list isn't stacking. */
export type StackCtx = { prefs: Pick<Prefs, 'printing' | 'baseCurrency'>; setTypes: SetTypeMap | null } | null;

export function groupSlots(rows: Row[], stack: StackCtx): SlotStack[] {
  if (!stack) return rows.map((r) => ({ lead: r, rows: [r], quantity: r.quantity }));
  const byOracle = groupBy(rows, (r) => r.oracleId);
  const out: SlotStack[] = [];
  byOracle.forEach((group) => {
    if (group.length === 1) {
      out.push({ lead: group[0]!, rows: group, quantity: group[0]!.quantity });
      return;
    }
    const printings = new Map<string, Priced<Printing>>();
    for (const r of group) if (r.printing) printings.set(r.printing.scryfallId, r.printing);
    const shown = pickOwnedPrinting([...printings.values()], stack.prefs, stack.setTypes);
    const lead = (shown && group.find((r) => r.scryfallId === shown.scryfallId)) ?? group[0]!;
    out.push({
      lead,
      rows: [lead, ...group.filter((r) => r !== lead)],
      quantity: sumQty(group),
    });
  });
  return out;
}

export function sortRows(rows: Row[], prefs: CardSortPrefs): Row[] {
  return sortCards(
    rows,
    // A lands-box basic costs the deck nothing, so it sorts by nothing.
    (r) => ({ ...cardSortFields(r.oracle, r.printing), ...(r.anyBasic ? { price: 0 } : {}) }),
    prefs,
  );
}

/** A slot as the clipboard carries it: everything it names, nothing it doesn't. */
export function clipSlot(r: Row): ClipboardSlot {
  return {
    oracleId: r.oracleId,
    name: r.oracle?.name ?? '(unknown card)',
    quantity: r.quantity,
    board: r.board,
    ...(r.scryfallId ? { scryfallId: r.scryfallId } : {}),
    ...(r.anyBasic ? { anyBasic: true } : {}),
    ...(r.finish ? { finish: r.finish } : {}),
    ...(r.condition ? { condition: r.condition } : {}),
    ...(r.lang ? { lang: r.lang } : {}),
    ...(r.tags?.length ? { tags: r.tags } : {}),
  };
}

/**
 * A slot (or a copied one) as a copy to file into `board` somewhere. A
 * lands-box basic names no edition; anything else carries its printing and the
 * traits it asks for, so the foil doesn't merge into the nonfoil's slot.
 */
export function rowToFilingCopy(
  r: SlotCopyFields & { oracleId: string; quantity: number },
  board: DeckBoard,
  extra: { label?: string; sub?: string } = {},
): FilingCopy {
  return {
    oracleId: r.oracleId,
    quantity: r.quantity,
    board,
    ...(r.anyBasic ? { anyBasic: true } : r.scryfallId ? { scryfallId: r.scryfallId } : {}),
    ...(r.finish || r.condition || r.lang
      ? { wants: { ...(r.finish ? { finish: r.finish } : {}), ...(r.condition ? { condition: r.condition } : {}), ...(r.lang ? { lang: r.lang } : {}) } }
      : {}),
    ...(extra.label ? { label: extra.label } : {}),
    ...(extra.sub ? { sub: extra.sub } : {}),
  };
}
