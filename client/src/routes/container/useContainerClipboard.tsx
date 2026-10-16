import type { DeckBoard, OracleCard } from '@mtg/shared';
import { getOracleCardsByIds } from '../../db/queries.js';
import { moveDeckCardsToContainer, removeDeckCard, setDeckCardQuantity } from '../../db/dataAccess.js';
import { isNonDeckCard } from '../../deck/legality.js';
import { clearCut, type ClipboardPayload } from '../../deck/cardClipboard.js';
import { useCardClipboard } from '../../deck/useCardClipboard.js';
import type { useFiling } from '../../deck/useFiling.js';
import { useToast } from '../../components/Toast.js';
import { useAsyncAction } from '../../components/useAsyncAction.js';
import { useShortcuts } from '../../components/useShortcuts.js';
import { useCardCursorCtx } from '../../components/useCardCursor.js';
import type { MultiSelect } from '../../components/useMultiSelect.js';
import { plural } from '../../util/format.js';
import { sumQty } from '../../util/groupBy.js';
import { clipSlot, rowToFilingCopy, type EditTarget, type Row } from './rows.js';

/** What the card keys act on: a slot id, or null when the cursor is on nothing. */
export interface CardKeys {
  step: (key: string | null, by: 1 | -1) => void;
  remove: (key: string | null) => void;
  open: (key: string | null) => void;
  pick: (key: string | null) => void;
}

/**
 * Ctrl+C / X / V, Ctrl+A and the card keys for a container page. Runs while the
 * page is still loading (hooks can't sit behind its early return), switched
 * off by `enabled` until the container is there to act on.
 */
export function useContainerClipboard({
  id,
  rows,
  selectedRows,
  allKeys,
  sel,
  isDeck,
  isCommander,
  noun,
  enabled,
  file,
  onPasteText,
  onOpen,
}: {
  id: string;
  rows: Row[];
  /** The selection as slots (a ticked stack is every slot under it). */
  selectedRows: Row[];
  /** One key per tile, what select-all ticks. */
  allKeys: string[];
  sel: MultiSelect;
  isDeck: boolean;
  isCommander: boolean;
  noun: string;
  enabled: boolean;
  file: ReturnType<typeof useFiling>['file'];
  /** A plain-text list on the clipboard: the page opens its import on it. */
  onPasteText: (text: string) => void;
  onOpen: (target: EditTarget) => void;
}): CardKeys {
  const toast = useToast();
  const action = useAsyncAction();

  /** Where a pasted card lands. The zone it came from is kept when this
   *  container has one to offer, and quietly corrected when it doesn't. */
  const pasteBoard = (board: DeckBoard, oracle: OracleCard | undefined): DeckBoard => {
    if (!isDeck) return 'main';
    if (oracle && isNonDeckCard(oracle)) return 'token';
    if (board === 'commander' && !isCommander) return 'main';
    return board;
  };

  async function pastePayload(payload: ClipboardPayload) {
    const oracles = await getOracleCardsByIds(payload.slots.map((s) => s.oracleId));
    const boardOf = new Map(payload.slots.map((s) => [s.oracleId, pasteBoard(s.board, oracles.get(s.oracleId))]));
    const cut = payload.cut;
    if (cut) {
      // The removal the cut deferred, happening now. One batch across both
      // containers, so it reads as a move and undoes from either end.
      const moved = await moveDeckCardsToContainer(cut.slotIds, id, (slot) => boardOf.get(slot.oracleId) ?? 'main');
      clearCut();
      if (moved === 0) {
        toast('Those cards have already moved on');
        return;
      }
      toast(`Moved ${moved} ${plural(moved, 'card')} into this ${noun}`);
      return;
    }
    // A copied slot that names a real copy of yours is that copy being filed
    // here too, so it takes the same road as "File away": capped at what you
    // own, and asked about when the copy is already promised elsewhere. Brew
    // lines and lands-box basics pass straight through, as they do everywhere.
    const filing = await file(
      id,
      payload.slots.map((s) => rowToFilingCopy(s, boardOf.get(s.oracleId) ?? 'main', { label: oracles.get(s.oracleId)?.name })),
      { source: 'manual' },
    );
    if (filing === null) return;
    const n = sumQty(payload.slots);
    toast(`Pasted ${n} ${plural(n, 'card')} into this ${noun}`);
  }

  // Copy takes the selection, or the whole container when nothing is picked:
  // "Ctrl+C on a deck" meaning "give me the decklist" is the reading everyone
  // arrives with. Cut insists on a selection: cutting an entire deck by
  // reflex is not a thing anyone meant to do.
  useCardClipboard({
    enabled,
    onCopy: () => {
      const picked = selectedRows.length > 0 ? selectedRows : rows;
      if (picked.length === 0) return null;
      const n = sumQty(picked);
      toast(`Copied ${n} ${plural(n, 'card')}`);
      return picked.map(clipSlot);
    },
    onCut: () => {
      if (selectedRows.length === 0) {
        toast('Select some cards first, then cut.');
        return null;
      }
      const n = sumQty(selectedRows);
      toast(`Cut ${n} ${plural(n, 'card')}. Paste them where they belong.`);
      sel.exit();
      return { slots: selectedRows.map(clipSlot), slotIds: selectedRows.map((r) => r.id), containerId: id };
    },
    onPastePayload: (payload) => void action.run('paste the cards', () => pastePayload(payload)),
    onPasteText,
  });

  // Ctrl+A means select all, every time. The bulk bar's own button is the
  // toggle; a key that silently deselects everything on the second press is how
  // you lose a selection you spent a minute building. Null with nothing to
  // select, which lets the key fall through.
  useShortcuts({
    'mod+a':
      enabled && allKeys.length
        ? () => {
            if (!sel.active) sel.enter();
            if (!sel.allSelected(allKeys)) sel.toggleAll(allKeys);
          }
        : null,
  });

  // What the card keys act on: whichever slot the cursor is pointing at.
  const cardAt = (key: string | null) => (key ? (rows.find((r) => r.id === key) ?? null) : null);

  return {
    /** Step a slot's copies. Down from one takes the slot out; Ctrl+Z is right
     *  there, which is what makes that safe to do on a keystroke. */
    step: (key, by) => {
      const row = cardAt(key);
      if (!row) return;
      const next = row.quantity + by;
      void action.run('change the count', async () => {
        await setDeckCardQuantity(row.id, next);
        if (next <= 0) toast(`Removed ${row.oracle?.name ?? 'the card'}`);
      });
    },
    remove: (key) => {
      const row = cardAt(key);
      if (!row) return;
      void action.run('remove the card', async () => {
        await removeDeckCard(row.id);
        toast(`Removed ${row.oracle?.name ?? 'the card'}`);
      });
    },
    open: (key) => {
      const row = cardAt(key);
      if (row?.oracle) onOpen({ card: row.oracle, deckCard: { ...row, deckId: id, commanderDeck: isCommander } });
    },
    /** Tick the card for a bulk action, turning select mode on if it's off, so
     *  a selection can be built by pointing rather than by clicking sixty rows. */
    pick: (key) => {
      if (!cardAt(key) || !key) return;
      if (!sel.active) sel.enter();
      sel.toggle(key);
    },
  };
}

/**
 * The keys bound to the card under the cursor. A child of the page's cursor
 * provider rather than part of the page, so a hover that moves the cursor
 * re-renders this and not the whole container. Renders nothing.
 */
export function CursorCardKeys({ keys }: { keys: CardKeys }) {
  const at = useCardCursorCtx()?.activeKey ?? null;
  // Only live while a card is actually under the cursor, so a stray `-` on an
  // empty page falls through instead of being swallowed.
  useShortcuts(
    at
      ? {
          // '+' is Shift+= on a US keyboard and a key of its own on a Nordic
          // one; '=' catches the people who don't reach for Shift.
          '+': () => keys.step(at, 1),
          '=': () => keys.step(at, 1),
          '-': () => keys.step(at, -1),
          Enter: () => keys.open(at),
          Delete: () => keys.remove(at),
          Backspace: () => keys.remove(at),
          x: () => keys.pick(at),
        }
      : {},
    { allowRepeat: true },
  );
  return null;
}
