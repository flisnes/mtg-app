import { useState, type ReactNode } from 'react';
import { holdsCopy, traitsLine, type ContainerKind, type DeckBoard } from '@mtg/shared';
import {
  moveDeckCardsBulk,
  removeDeckCardsBulk,
  removeDeckCardsMatching,
  setDeckCardsForTrade,
  setDeckCardsUnfiled,
} from '../../db/dataAccess.js';
import type { PlacementIndex } from '../../db/usePlacements.js';
import { BOARD_LABEL, boardOptions } from '../../deck/boards.js';
import { CONTAINER_META } from '../../deck/containers.js';
import { rowToFilingCopy } from '../../deck/filing.js';
import { describeFilingResult, type useFiling } from '../../deck/useFiling.js';
import type { BulkAction } from '../../components/BulkActionBar.js';
import type { useConfirm } from '../../components/ConfirmSheet.js';
import { ContainerPickerSheet } from '../../components/ContainerPickerSheet.js';
import { TagSheet } from '../../components/TagSheet.js';
import { useToast } from '../../components/Toast.js';
import type { MultiSelect } from '../../components/useMultiSelect.js';
import { plural } from '../../util/format.js';
import { MoveZoneSheet } from './MoveZoneSheet.js';
import type { Row } from './rows.js';

/** Which bulk sheet is open. 'file' picks somewhere to *also* put the
 *  selection, 'unfile' somewhere to take it out of: the two halves of sorting
 *  out a card promised twice. Tagging is frozen on the slots selected then. */
type BulkSheet = { kind: 'file' } | { kind: 'unfile' } | { kind: 'move' } | { kind: 'tag'; slotIds: string[] } | null;

/**
 * The selection bar's actions on a container page, and the sheets they open.
 * Selection is keyed by slot id, so it spans every board: pick a commander and
 * three sideboard cards and one action covers the lot.
 */
export function useContainerBulkActions({
  id,
  deckName,
  noun,
  isDeck,
  isCommander,
  commander,
  selectedRows,
  sel,
  placements,
  file,
  confirm,
}: {
  id: string;
  deckName: string;
  noun: string;
  isDeck: boolean;
  isCommander: boolean;
  /** The command zone, so "Move to…" knows whether a partner fits. */
  commander: Row[];
  selectedRows: Row[];
  sel: MultiSelect;
  placements?: PlacementIndex;
  file: ReturnType<typeof useFiling>['file'];
  confirm: ReturnType<typeof useConfirm>['confirm'];
}): { bulkActions: BulkAction[]; sheets: ReactNode } {
  const toast = useToast();
  const [sheet, setSheet] = useState<BulkSheet>(null);
  const close = () => setSheet(null);

  // Which *other* containers hold the selection, and how much of it: the list
  // the "Unfile" picker offers, so resolving a double-promised card is two taps
  // rather than a hunt through every deck you own.
  // A slot's own wants narrow the list the same way they narrow the badges: the
  // deck holding your English copy isn't holding the Spanish one.
  const elsewhere = new Map<string, number>();
  for (const r of selectedRows) {
    const wants = { condition: r.condition, finish: r.finish, lang: r.lang };
    for (const p of placements?.lookup(r.oracleId, r.scryfallId, wants).places ?? []) {
      if (p.containerId === id) continue;
      elsewhere.set(p.containerId, (elsewhere.get(p.containerId) ?? 0) + 1);
    }
  }

  // Selected slots this container is holding cardboard for, and the ones it has
  // been emptied of: the two directions of "the card is (not) in the box".
  // Only a slot that names one physical copy can go either way; a brew line and
  // a lands-box basic never held anything (see DeckCard.unfiled).
  const filedHereRows = selectedRows.filter(holdsCopy);
  const unfiledRows = selectedRows.filter((r) => r.unfiled);
  const ids = () => selectedRows.map((r) => r.id);

  async function bulkRemove() {
    const n = selectedRows.length;
    const ok = await confirm({
      title: `Remove ${n} ${plural(n, 'card')}?`,
      body: `${n === 1 ? 'It leaves' : 'They leave'} “${deckName}”. Copies you own stay in your collection.`,
      confirmLabel: `Remove from ${noun}`,
      danger: true,
    });
    if (!ok) return;
    const copies = await removeDeckCardsBulk(ids());
    toast(`Removed ${copies} ${plural(copies, 'card')} from the ${noun}`);
    sel.exit();
  }

  /** Mark the selected cards' owned copies for trade (or take them back off). */
  async function bulkTrade(forTrade: boolean) {
    const n = await setDeckCardsForTrade(ids(), forTrade);
    if (n === 0) {
      toast(forTrade ? 'None of those are in your collection to mark' : 'None of those were for trade');
    } else {
      toast(`${forTrade ? 'Marked' : 'Unmarked'} ${n} ${plural(n, 'card')} for trade`);
    }
    sel.exit();
  }

  /**
   * File the selection into another deck, binder or box. Same cardboard, new
   * home: the printing and traits travel with it rather than merging the foil
   * into the slot that happens to hold the nonfoil, and a copy that's already
   * filed elsewhere gets the move-or-both question.
   */
  async function bulkFile(containerId: string, targetKind: ContainerKind) {
    close();
    const filing = await file(
      containerId,
      selectedRows.map((r) =>
        rowToFilingCopy(r, 'main', { label: r.oracle?.name, sub: traitsLine(r, { lead: r.printing?.setName }) }),
      ),
    );
    if (filing === null) return;
    toast(describeFilingResult(filing, CONTAINER_META[targetKind].noun));
    sel.exit();
  }

  /**
   * Take the cards out of this container without editing the list: the slots
   * stay, still naming the copies they want, and hand the cardboard back (the
   * deck box you emptied into a trade binder). The green collection badge drops
   * to the double checkmark, and the copies are free for another deck.
   */
  async function unfileHere() {
    close();
    const copies = await setDeckCardsUnfiled(filedHereRows.map((r) => r.id), true);
    toast(
      copies === 0
        ? `Nothing in this selection is filed here`
        : `Took ${copies} ${plural(copies, 'card')} out of the ${noun} · the list is unchanged`,
    );
    sel.exit();
  }

  /** Put the cardboard back in: the other half of `unfileHere`. */
  async function refileHere() {
    const copies = await setDeckCardsUnfiled(unfiledRows.map((r) => r.id), false);
    toast(copies === 0 ? `Those are already filed here` : `Filed ${copies} ${plural(copies, 'card')} back here`);
    sel.exit();
  }

  /** Take the selection back out of another container (the conflict fix). */
  async function bulkUnfile(containerId: string, targetKind: ContainerKind) {
    if (containerId === id) return void unfileHere();
    close();
    const removed = await removeDeckCardsMatching(
      containerId,
      selectedRows.map((r) => rowToFilingCopy(r, r.board)),
    );
    const there = CONTAINER_META[targetKind].noun;
    toast(
      removed === 0
        ? `Nothing matched in that ${there}`
        : `Removed ${removed} ${plural(removed, 'card')} from that ${there}`,
    );
    sel.exit();
  }

  /**
   * Move the selection into another zone of this deck. A slot already in the
   * target zone is left alone, and one that meets its card there merges with it,
   * so moving the same cards twice is not a way to duplicate them.
   */
  async function bulkMove(board: DeckBoard) {
    close();
    const copies = await moveDeckCardsBulk(ids(), board);
    const zone = BOARD_LABEL[board].toLowerCase();
    toast(copies === 0 ? `Already in the ${zone}` : `Moved ${copies} ${plural(copies, 'card')} to the ${zone}`);
    sel.exit();
  }

  // Which zones the selection may move to. Storage has no zones; the
  // command-zone check mustn't count a selected commander as its own partner;
  // and a selection that's all in one zone isn't offered that zone back.
  // Only worked out while the sheet is open.
  const moveZones = () => {
    const sharedBoard =
      selectedRows.length > 0 && selectedRows.every((r) => r.board === selectedRows[0]!.board)
        ? selectedRows[0]!.board
        : undefined;
    return boardOptions({
      cards: selectedRows.map((r) => r.oracle),
      commanderDeck: isCommander,
      commandZone: commander
        .filter((r) => !!r.oracle && !selectedRows.some((sr) => sr.oracleId === r.oracleId))
        .map((r) => r.oracle!),
    }).filter((z) => z.board !== sharedBoard);
  };

  // Most-used first: the bar shows the first two inline (BulkActionBar).
  const bulkActions: BulkAction[] = [
    ...(isDeck ? [{ label: 'Move to…', icon: 'moveTo' as const, onClick: () => setSheet({ kind: 'move' }) }] : []),
    { label: 'File away…', icon: 'decks', onClick: () => setSheet({ kind: 'file' }) },
    { label: 'Tag…', icon: 'tags', onClick: () => setSheet({ kind: 'tag', slotIds: ids() }) },
    { label: 'Add to tradelist', icon: 'tradelist', onClick: () => void bulkTrade(true) },
    { label: 'Remove from tradelist', icon: 'close', onClick: () => void bulkTrade(false) },
    // Somewhere to take these out of: here (if this container is holding any of
    // them) or another container promised the same copies.
    {
      label: 'Unfile…',
      icon: 'minus',
      disabled: elsewhere.size === 0 && filedHereRows.length === 0,
      onClick: () => setSheet({ kind: 'unfile' }),
    },
    // Only worth offering once something in the selection has been taken out.
    ...(unfiledRows.length > 0
      ? [{ label: 'File back here', icon: 'collection' as const, onClick: () => void refileHere() }]
      : []),
    { label: `Remove from ${noun}`, icon: 'trash', danger: true, onClick: () => void bulkRemove() },
  ];

  let sheets: ReactNode = null;
  if (sheet?.kind === 'move') {
    sheets = (
      <MoveZoneSheet zones={moveZones()} count={selectedRows.length} onPick={(board) => void bulkMove(board)} onClose={close} />
    );
  } else if (sheet?.kind === 'tag') {
    sheets = (
      <TagSheet
        deckId={id}
        slotIds={sheet.slotIds}
        onClose={() => {
          close();
          sel.exit();
        }}
      />
    );
  } else if (sheet?.kind === 'file') {
    sheets = (
      <ContainerPickerSheet
        title="File away"
        label="Choose a deck, binder or box"
        excludeId={id}
        onPick={bulkFile}
        onClose={close}
      />
    );
  } else if (sheet?.kind === 'unfile') {
    sheets = (
      <ContainerPickerSheet
        title="Take out of"
        label="Choose where to take these out of"
        only={new Set([...(filedHereRows.length > 0 ? [id] : []), ...elsewhere.keys()])}
        noteFor={(cid) =>
          cid === id
            ? `holds ${filedHereRows.length} of these · the list stays as it is`
            : `holds ${elsewhere.get(cid) ?? 0} of these · they leave that list`
        }
        emptyText="None of the selected cards are filed anywhere."
        onPick={bulkUnfile}
        onClose={close}
      />
    );
  }
  return { bulkActions, sheets };
}
