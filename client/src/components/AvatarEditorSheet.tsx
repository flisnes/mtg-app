import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { AVATAR_MAX_ZOOM, type OracleCard, type Priced, type Printing, type ProfileAvatar } from '@mtg/shared';
import { searchCards } from '../cardDb/search.js';
import { getPrintingsForOracle } from '../db/queries.js';
import { artCropUrl, clampCropCenter, cropLayout } from './Avatar.js';
import { useEscapeToClose } from './useEscapeToClose.js';

// Profile-picture editor: search any card, pick a printing, then pan (drag),
// pinch or slide to zoom the art inside a circular frame — the usual
// profile-photo crop flow, except the photo library is all of Magic.

const STAGE = 260; // crop circle diameter, px

export function AvatarEditorSheet({
  onSave,
  onClose,
}: {
  onSave: (avatar: ProfileAvatar) => void;
  onClose: () => void;
}) {
  useEscapeToClose(onClose);
  const [card, setCard] = useState<Priced<OracleCard> | null>(null);

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose a profile picture">
        <div className="sheet-name">{card ? 'Frame the art' : 'Pick a card for your profile picture'}</div>
        {card ? (
          <CropStage card={card} onBack={() => setCard(null)} onSave={onSave} onCancel={onClose} />
        ) : (
          <CardSearch onPick={setCard} onCancel={onClose} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function CardSearch({ onPick, onCancel }: { onPick: (card: Priced<OracleCard>) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Priced<OracleCard>[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    void searchCards(q, {}, 24).then((res) => {
      if (!cancelled) setResults(res.cards);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <>
      <input
        className="search-input"
        placeholder="Search any card…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      {results.length > 0 && (
        <ul className="menu-list avatar-results">
          {results.map((c) => (
            <li key={c.oracleId}>
              <button className="menu-item menu-item-btn" onClick={() => onPick(c)}>
                {artCropUrl(c.imageNormal) ? (
                  <img className="avatar-result-thumb" src={artCropUrl(c.imageNormal)!} alt="" loading="lazy" />
                ) : (
                  <span className="avatar-result-thumb" />
                )}
                <span className="deck-line">
                  <span className="deck-name">{c.name}</span>
                  <span className="deck-meta">{c.typeLine}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sheet-actions">
        <button onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

function CropStage({
  card,
  onBack,
  onSave,
  onCancel,
}: {
  card: Priced<OracleCard>;
  onBack: () => void;
  onSave: (avatar: ProfileAvatar) => void;
  onCancel: () => void;
}) {
  const [printings, setPrintings] = useState<Priced<Printing>[]>([]);
  const [scryfallId, setScryfallId] = useState(card.defaultScryfallId);
  const [crop, setCrop] = useState({ x: 0.5, y: 0.5, zoom: 1 });
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Active pointers, for one-finger pan and two-finger pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  useEffect(() => {
    let cancelled = false;
    void getPrintingsForOracle(card.oracleId).then((list) => {
      if (!cancelled) setPrintings(list.filter((p) => artCropUrl(p.imageNormal)));
    });
    return () => {
      cancelled = true;
    };
  }, [card.oracleId]);

  const printing = printings.find((p) => p.scryfallId === scryfallId);
  const src = artCropUrl(printing?.imageNormal ?? card.imageNormal);

  function applyZoom(zoom: number) {
    setCrop((c) => {
      const z = Math.min(AVATAR_MAX_ZOOM, Math.max(1, zoom));
      return dims ? { zoom: z, ...clampCropCenter(dims.w, dims.h, z, c.x, c.y) } : { ...c, zoom: z };
    });
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !dims) return;
    const pts = pointers.current;
    if (pts.size === 2) {
      // Pinch: zoom by the change in distance between the two pointers.
      const [a, b] = [...pts.values()];
      const before = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a2, b2] = [...pts.values()];
      const after = Math.hypot(a2!.x - b2!.x, a2!.y - b2!.y);
      if (before > 0) applyZoom(crop.zoom * (after / before));
      return;
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const scale = (STAGE * crop.zoom) / Math.min(dims.w, dims.h);
    setCrop((c) => ({
      ...c,
      ...clampCropCenter(
        dims.w,
        dims.h,
        c.zoom,
        c.x - (e.clientX - prev.x) / (dims.w * scale),
        c.y - (e.clientY - prev.y) / (dims.h * scale),
      ),
    }));
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
  }

  const layout = dims ? cropLayout(dims.w, dims.h, crop, STAGE) : null;

  return (
    <>
      <div className="avatar-stage-wrap">
        <div
          className="avatar-stage"
          style={{ width: STAGE, height: STAGE }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => applyZoom(crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
        >
          {src && (
            <img
              key={src}
              src={src}
              alt={card.name}
              draggable={false}
              style={layout ? { position: 'absolute', maxWidth: 'none', ...layout } : { visibility: 'hidden' }}
              onLoad={(e) => {
                setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
                setCrop({ x: 0.5, y: 0.5, zoom: 1 });
              }}
            />
          )}
        </div>
      </div>
      <label className="avatar-zoom">
        Zoom
        <input
          type="range"
          min={1}
          max={AVATAR_MAX_ZOOM}
          step={0.01}
          value={crop.zoom}
          onChange={(e) => applyZoom(Number(e.target.value))}
          aria-label="Zoom"
        />
      </label>
      <p className="fine-print">Drag to reposition, pinch or scroll to zoom.</p>

      {printings.length > 1 && (
        <div className="avatar-editions" role="listbox" aria-label="Edition">
          {printings.map((p) => (
            <button
              key={p.scryfallId}
              className={p.scryfallId === scryfallId ? 'avatar-edition avatar-edition-selected' : 'avatar-edition'}
              onClick={() => setScryfallId(p.scryfallId)}
              title={`${p.setName} · #${p.collectorNumber}`}
              role="option"
              aria-selected={p.scryfallId === scryfallId}
            >
              <img src={artCropUrl(p.imageNormal)!} alt={p.setName} loading="lazy" />
            </button>
          ))}
        </div>
      )}

      <div className="sheet-actions">
        <button onClick={onBack}>‹ Different card</button>
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={!dims}
          onClick={() => onSave({ scryfallId: printing?.scryfallId ?? card.defaultScryfallId, ...crop })}
        >
          Save picture
        </button>
      </div>
    </>
  );
}
