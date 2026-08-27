import { useShortcuts } from '../components/useShortcuts.js';
import { useToast } from '../components/Toast.js';
import { redoEntry } from '../db/dataAccess.js';
import type { UndoScope } from '../db/undoScope.js';
import { describeBatch, describeEvent, placeLabel } from './eventRegistry.js';
import { dropRedo, noteRedoEvents, peekRedo, pushRedo, redoEventIds, redoItemFor } from './redoStack.js';
import { entryEvents, type HistoryEntry } from './useHistoryEntries.js';
import { useUndoStack } from './useUndoStack.js';

// Ctrl+Z and Ctrl+Y on a page, wired to that page's own stacks (Cmd on a Mac,
// and Ctrl+Shift+Z redoes too, since that's what half of people reach for).
//
// One line per page, because the interesting decisions are all made elsewhere:
// useUndoStack picks what's undoable here and now, undoScope decides whether
// it's safe, redoStack holds what came back off. What's left is saying out loud
// what happened, which matters more than usual: a keystroke leaves no trace of
// itself, so every outcome gets a toast, including the ones where nothing
// happened.
//
// Neither key is bound to auto-repeat. Holding one down to rewind a deck at 30
// undos a second is a way to lose an evening's work, and the seconds it saves
// aren't worth it.

/** Past tense for whatever the entry was, e.g. "Added to Goblins". */
function verbOf(entry: HistoryEntry): string {
  return entry.kind === 'batch'
    ? describeBatch(entry.source, entry.label, entry.events).verb
    : describeEvent(entry.event).verb;
}

export function useUndoShortcut(scope: UndoScope): void {
  const { next, elsewhere, undo } = useUndoStack(scope);
  const toast = useToast();

  async function runUndo(): Promise<void> {
    if (!next) {
      // Nothing here doesn't mean nothing anywhere. Say where it was rather
      // than dead-ending, and above all don't quietly undo it from here.
      toast(
        elsewhere
          ? `Nothing left to undo here. Your last change was in ${placeLabel(entryEvents(elsewhere))}.`
          : 'Nothing to undo.',
      );
      return;
    }
    const verb = verbOf(next);
    const res = await undo();
    if (res?.undone) {
      pushRedo(redoItemFor(res.events, res.trade, verb));
      toast(`Undone: ${verb}`);
    } else if (res?.reason === 'conflict') toast("Can't undo: a newer change touched these cards");
    else toast("Couldn't undo that change");
  }

  async function runRedo(): Promise<void> {
    const { mine, elsewhere: other } = peekRedo(scope);
    if (!mine) {
      toast(other ? `Nothing to redo here. Your last undo was in ${placeLabel(other.events)}.` : 'Nothing to redo.');
      return;
    }
    const res = await redoEntry({
      events: mine.events,
      ...(mine.trade ? { trade: mine.trade } : {}),
      since: mine.undoneAt,
      ownEventIds: redoEventIds(),
    });
    // Off the stack either way: a redo refused because the cards changed under
    // it will be refused just as hard next time, so leaving it there only makes
    // the key lie about having something to offer.
    dropRedo(mine);
    if (res.redone) {
      noteRedoEvents(res.events);
      toast(`Redone: ${mine.verb}`);
    } else toast("Can't redo: these cards have changed since");
  }

  useShortcuts({
    'mod+z': () => void runUndo(),
    'mod+y': () => void runRedo(),
    'mod+shift+z': () => void runRedo(),
  });
}
