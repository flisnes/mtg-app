import { BOARD_NOUN } from '../../deck/boards.js';
import type { DeckChange } from '../../scan/rescan.js';
import { ScanListRow } from '../ScanListRow.js';

/** Deck re-scan step 1: the add/remove/quantity diff, before anything is written
 *  (the first step of the intake questionnaire, which supplies the sheet). */
export function RescanChangesList({
  changes,
  deckName,
  showBoards,
}: {
  changes: DeckChange[];
  deckName: string;
  /** Decks split into boards; a binder or box is one pile, so the label is noise. */
  showBoards: boolean;
}) {
  const added = changes.filter((c) => c.kind === 'add');
  const changed = changes.filter((c) => c.kind === 'change');
  const removed = changes.filter((c) => c.kind === 'remove');
  const rows = [...added, ...changed, ...removed];
  return (
    <>
      <p className="fine-print">
        Sets “{deckName}” to exactly what you scanned, and files those copies into it. Cards left unchanged aren’t
        listed.
      </p>
      {rows.length === 0 ? (
        <p className="scan-list-empty">
          Same cards as before. The copies you scanned get filed here, so “{deckName}” is holding them.
        </p>
      ) : (
        <ul className="scan-list">
          {rows.map((c) => (
            <ScanListRow
              key={`${c.kind}|${c.oracleId}|${c.board}`}
              image={c.image}
              name={c.name}
              sub={showBoards && BOARD_NOUN[c.board]}
            >
              {c.kind === 'add' && <span className="rescan-tag rescan-add">Added ×{c.quantity}</span>}
              {c.kind === 'remove' && <span className="rescan-tag rescan-remove">Removed ×{c.quantity}</span>}
              {c.kind === 'change' && (
                <span className={`rescan-tag ${c.to > c.from ? 'rescan-add' : 'rescan-remove'}`}>
                  {c.from} → {c.to}
                </span>
              )}
            </ScanListRow>
          ))}
        </ul>
      )}
    </>
  );
}
