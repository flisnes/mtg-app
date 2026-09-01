import { Sheet } from './Sheet.js';

/**
 * "Archive this deck?" — and the one question archiving always raises: is the
 * cardboard still in it?
 *
 * Archiving is about the list, not the cards. It keeps everything the deck has
 * (slots, printings, history) and moves it out of the deck list, which is what
 * you want for the deck you took apart but built for a reason. So the two are
 * separate answers: the pile you sleeved for last season's league stays filed,
 * while the brew you just harvested for parts gives its copies back.
 *
 * "Unfile" empties the slots without editing the list (see setDeckCardsUnfiled):
 * the deck still says what it was, the copies are free for another deck, and
 * restoring it later tells you exactly what to go and find.
 */
export function ArchiveDeckSheet({
  deckName,
  filedCopies,
  onArchive,
  onClose,
}: {
  deckName: string;
  /** Copies the deck is holding right now; 0 means there is nothing to unfile. */
  filedCopies: number;
  onArchive: (unfile: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose} title={`Archive “${deckName}”?`} label={`Archive ${deckName}`}>
      <p className="search-meta">
        It moves to the Archived folder and keeps its whole list, so you can still see what you built, or bring
        it back, whenever you like.
      </p>

      {filedCopies > 0 ? (
        <>
          <p className="search-meta">
            {filedCopies} card{filedCopies === 1 ? '' : 's'} {filedCopies === 1 ? 'is' : 'are'} filed in it. Take
            them out too? The list stays either way; unfiling just frees the copies for your other decks.
          </p>
          <div className="sheet-actions sheet-actions-stack">
            <button className="primary" onClick={() => onArchive(true)}>
              Archive and unfile the cards
            </button>
            <button onClick={() => onArchive(false)}>Archive, leave it assembled</button>
            <button onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="sheet-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onArchive(false)}>
            Archive deck
          </button>
        </div>
      )}
    </Sheet>
  );
}
