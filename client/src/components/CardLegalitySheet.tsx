import { FORMATS, type Format, type LegalityStatus, type OracleCard } from '@mtg/shared';
import { Sheet } from './Sheet.js';
import { formatLabel } from '../deck/legality.js';

// "Can I actually play this in Modern?" — the seven formats we track, each with
// the card's standing in it. Oracle-invariant, so the printing you're looking at
// doesn't change a single row.

const STATUS_LABEL: Record<LegalityStatus, string> = {
  legal: 'Legal',
  banned: 'Banned',
  restricted: 'Restricted',
  not_legal: 'Not legal',
};

export function CardLegalitySheet({ oracleCard, onClose }: { oracleCard: OracleCard; onClose: () => void }) {
  const legalities = oracleCard.legalities;
  // A card DB built before legality data existed has nothing to say here, and a
  // column of grey "Not legal" would be a lie rather than an absence.
  const known = legalities && Object.keys(legalities).length > 0;

  return (
    <Sheet onClose={onClose} title={`Format legality: ${oracleCard.name}`} className="legality-sheet">
      {!known ? (
        <p className="fine-print">No legality data for this card yet. Refresh the card database from About.</p>
      ) : (
        <ul className="legality-list">
          {FORMATS.map((f: Format) => {
            const status = legalities[f] ?? 'not_legal';
            return (
              <li key={f} className="legality-row">
                <span className="legality-format">{formatLabel(f)}</span>
                <span className={`legality-chip legality-${status.replace('_', '-')}`}>{STATUS_LABEL[status]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
