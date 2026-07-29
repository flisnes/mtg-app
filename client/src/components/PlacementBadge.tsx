import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CONTAINER_META } from '../deck/containers.js';
import type { PlacementInfo } from '../db/usePlacements.js';
import { Icon } from './icons.js';

// "Where do I keep this card?", in two shapes: a corner badge on card images
// (collection, tradelist, search results) and tappable pills in the card sheet.
// Both read the same PlacementInfo, so a card's badge and its pills can never
// disagree.
//
//   deck glyph / binder glyph / box glyph — the kind of container holding it
//   ×N                                    — how many containers, when >1
//   ⚠ (amber)                             — more copies placed than owned

export interface PlacementBadgeSpec {
  node: ReactNode;
  cls: string;
  title: string;
}

/** Corner badge for a card image; null when the card isn't filed anywhere. */
export function placementBadge(info: PlacementInfo | undefined, size = 12): PlacementBadgeSpec | null {
  if (!info || info.places.length === 0) return null;
  // Decks sort first, so the leading placement's kind is the glyph we show; the
  // title spells out every container either way.
  const lead = info.places[0]!;
  const detail = info.places
    .map((p) => `${p.name} (${p.quantity})`)
    .join(' · ');
  const title = info.over
    ? `${detail} · ${info.placed} placed, only ${info.owned} owned`
    : `In ${detail}`;
  return {
    node: (
      <>
        <Icon name={CONTAINER_META[lead.kind].icon} size={size} />
        {info.places.length > 1 && <span className="place-badge-count">{info.places.length}</span>}
        {info.over && <span aria-hidden>⚠</span>}
      </>
    ),
    cls: info.over ? 'badge-place badge-place-over' : 'badge-place',
    title,
  };
}

/**
 * The card sheet's "it lives here" row: one pill per container, each tapping
 * through to that deck / binder / box. `onNavigate` fires first so the sheet can
 * close itself before the route changes.
 */
export function PlacementPills({ info, onNavigate }: { info: PlacementInfo; onNavigate?: () => void }) {
  const navigate = useNavigate();
  if (info.places.length === 0) return null;
  return (
    <div className="place-pills">
      {info.places.map((p) => {
        const meta = CONTAINER_META[p.kind];
        return (
          <button
            key={p.containerId}
            type="button"
            className="place-pill"
            title={`Go to ${p.name}`}
            onClick={() => {
              onNavigate?.();
              navigate(`${meta.path}/${p.containerId}`);
            }}
          >
            <Icon name={meta.icon} size={13} />
            <span className="place-pill-name">{p.name}</span>
            {p.quantity > 1 && <span className="place-pill-qty">×{p.quantity}</span>}
          </button>
        );
      })}
      {info.over && (
        <span className="place-pill place-pill-warn" title={`${info.placed} copies placed, ${info.owned} owned`}>
          ⚠ {info.placed} placed / {info.owned} owned
        </span>
      )}
    </div>
  );
}
