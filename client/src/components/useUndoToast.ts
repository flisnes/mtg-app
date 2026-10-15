import { useCallback } from 'react';
import { undoEntry } from '../db/dataAccess.js';
import { useToast } from './Toast.js';

/**
 * A toast with Undo for an add that has already left the screen (a sheet that
 * closed, a quick-add from a result row). The caller mints the event id up
 * front and hands it to the add, so Undo reverses exactly that add through the
 * edit history's own undoEntry, never a bespoke delete.
 */
export function useUndoToast(): (message: string, eventId: string) => void {
  const toast = useToast();
  return useCallback(
    (message: string, eventId: string) =>
      toast(message, {
        label: 'Undo',
        run: () =>
          void undoEntry({ type: 'single', id: eventId }).then((res) =>
            toast(res.undone ? 'Undone' : res.reason === 'conflict' ? 'Changed since, undo it from Edit history' : 'Already undone'),
          ),
      }),
    [toast],
  );
}
