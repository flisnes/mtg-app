import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { EMBLEM_COLORS, type ContainerEmblem, type ContainerKind, type EmblemColor, type OracleCard, type Priced } from '@mtg/shared';
import { getSetList, type CardSetInfo } from '../db/queries.js';
import { CardSearch, CropStage } from './AvatarEditorSheet.js';
import { Emblem } from './Emblem.js';
import { EMBLEM_COLOR_CSS, EMBLEM_MANA_PIPS, EMBLEM_SYMBOL_GROUPS, emblemColorLabel } from './emblemSymbols.js';
import { SetSymbol } from './SetSymbol.js';
import { useDismiss } from './useDismiss.js';
import { useTapGuard } from './useTapGuard.js';

// Pick what a deck, binder or box wears in the list. Three ways in, one per tab:
//  - Art: search any card, then frame it — the profile-picture flow, reused
//    wholesale (CardSearch + CropStage).
//  - Symbol: the curated Mana font slice (emblemSymbols.ts).
//  - Set: every set the installed card DB knows, as its Keyrune symbol.
//
// Symbols and sets commit on tap; the art path needs its crop confirmed. A
// colour swatch applies straight away and leaves the sheet open, so you can try
// a few against the row behind it — hence "Done" rather than "Cancel" once
// anything has been written.

type Tab = 'art' | 'symbol' | 'set';

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'art', label: 'Card art' },
  { tab: 'symbol', label: 'Symbols' },
  { tab: 'set', label: 'Sets' },
];

export function EmblemPickerSheet({
  emblem,
  kind,
  name,
  onSave,
  onClose,
}: {
  /** What it wears today, so the picker can mark it and offer to clear it. */
  emblem?: ContainerEmblem;
  kind: ContainerKind;
  name: string;
  /** undefined = back to the plain kind icon. */
  onSave: (emblem: ContainerEmblem | undefined) => void;
  onClose: () => void;
}) {
  useDismiss(onClose);
  // Opened from a row's options menu, whose items sit where this sheet's own
  // buttons land — swallow the tail of the tap that opened it.
  const tapGuard = useTapGuard();
  const [tab, setTab] = useState<Tab>(emblem?.type === 'set' ? 'set' : emblem?.type === 'symbol' ? 'symbol' : 'art');
  const [card, setCard] = useState<Priced<OracleCard> | null>(null);
  // The emblem as it now stands, so the preview and the ticked swatch/symbol
  // follow what has been written without waiting on the parent's query.
  const [current, setCurrent] = useState<ContainerEmblem | undefined>(emblem);
  const [color, setColor] = useState<EmblemColor | undefined>(
    emblem && emblem.type !== 'art' ? emblem.color : undefined,
  );
  const [saved, setSaved] = useState(false);

  function apply(next: ContainerEmblem | undefined) {
    setCurrent(next);
    setSaved(true);
    onSave(next);
  }

  function commit(next: ContainerEmblem | undefined) {
    apply(next);
    onClose();
  }

  /** Recolour on the spot when there is already a symbol or set to recolour. */
  function pickColor(next: EmblemColor | undefined) {
    setColor(next);
    if (!current || current.type === 'art') return;
    apply(next ? { ...current, color: next } : { ...current, color: undefined });
  }

  const closeLabel = saved ? 'Done' : 'Cancel';

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose} {...tapGuard}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Emblem for ${name}`}>
        <div className="sheet-name emblem-sheet-name">
          <Emblem emblem={current} kind={kind} size={28} />
          <span>{card ? 'Frame the art' : `Emblem for “${name}”`}</span>
        </div>

        {!card && (
          <div className="seg-row sheet-tabs" role="tablist" aria-label="Emblem source">
            {TABS.map((t) => (
              <button
                key={t.tab}
                role="tab"
                aria-selected={t.tab === tab}
                className={t.tab === tab ? 'seg seg-active' : 'seg'}
                onClick={() => setTab(t.tab)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {tab === 'art' &&
          (card ? (
            <CropStage
              card={card}
              onBack={() => setCard(null)}
              onSave={(art) => commit({ type: 'art', art })}
              onCancel={onClose}
              saveLabel="Use this art"
            />
          ) : (
            <CardSearch
              onPick={setCard}
              onCancel={onClose}
              actions={current ? <button onClick={() => commit(undefined)}>Remove emblem</button> : undefined}
            />
          ))}

        {tab === 'symbol' && (
          <SymbolPicker
            selected={current?.type === 'symbol' ? current.symbol : undefined}
            color={color}
            onPickColor={pickColor}
            onPick={(symbol) => commit({ type: 'symbol', symbol, ...(color ? { color } : {}) })}
            onClear={current ? () => commit(undefined) : undefined}
            onCancel={onClose}
            closeLabel={closeLabel}
          />
        )}

        {tab === 'set' && (
          <SetPicker
            selected={current?.type === 'set' ? current.set : undefined}
            color={color}
            onPickColor={pickColor}
            onPick={(set) => commit({ type: 'set', set, ...(color ? { color } : {}) })}
            onClear={current ? () => commit(undefined) : undefined}
            onCancel={onClose}
            closeLabel={closeLabel}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Swatch row shared by the symbol and set tabs; the first one clears the tint. */
function ColorRow({
  color,
  onPick,
}: {
  color: EmblemColor | undefined;
  onPick: (color: EmblemColor | undefined) => void;
}) {
  return (
    <div className="emblem-colors" role="radiogroup" aria-label="Emblem color">
      <button
        className={color === undefined ? 'emblem-swatch emblem-swatch-selected' : 'emblem-swatch'}
        onClick={() => onPick(undefined)}
        title="Default color"
        aria-label="Default color"
        role="radio"
        aria-checked={color === undefined}
      >
        <span className="emblem-swatch-dot emblem-swatch-default" />
      </button>
      {EMBLEM_COLORS.map((c) => (
        <button
          key={c}
          className={c === color ? 'emblem-swatch emblem-swatch-selected' : 'emblem-swatch'}
          onClick={() => onPick(c)}
          title={emblemColorLabel(c)}
          aria-label={emblemColorLabel(c)}
          role="radio"
          aria-checked={c === color}
        >
          <span className="emblem-swatch-dot" style={{ background: EMBLEM_COLOR_CSS[c] }} />
        </button>
      ))}
    </div>
  );
}

function SymbolPicker({
  selected,
  color,
  onPick,
  onPickColor,
  onClear,
  onCancel,
  closeLabel,
}: {
  selected?: string;
  color: EmblemColor | undefined;
  onPick: (symbol: string) => void;
  onPickColor: (color: EmblemColor | undefined) => void;
  onClear?: () => void;
  onCancel: () => void;
  closeLabel: string;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EMBLEM_SYMBOL_GROUPS;
    return EMBLEM_SYMBOL_GROUPS.map((g) => ({
      title: g.title,
      symbols: g.symbols.filter((s) => s.label.toLowerCase().includes(q) || s.sym.includes(q)),
    })).filter((g) => g.symbols.length > 0);
  }, [query]);
  const tint = color ? EMBLEM_COLOR_CSS[color] : undefined;

  return (
    <>
      <input
        className="search-input"
        type="search"
        placeholder="Search symbols…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search symbols"
      />
      <ColorRow color={color} onPick={onPickColor} />
      <div className="emblem-scroll">
        {groups.length === 0 && <p className="search-meta">No symbol by that name.</p>}
        {groups.map((g) => (
          <div key={g.title} className="emblem-group">
            <h3 className="emblem-group-title">{g.title}</h3>
            <div className="emblem-grid" role="listbox" aria-label={g.title}>
              {g.symbols.map((s) => {
                // A tinted mana symbol drops the pip, exactly as it will render
                // in the list — see Emblem.tsx.
                const pip = EMBLEM_MANA_PIPS.has(s.sym) && !tint;
                return (
                  <button
                    key={s.sym}
                    className={s.sym === selected ? 'emblem-choice emblem-choice-selected' : 'emblem-choice'}
                    style={{ color: tint }}
                    onClick={() => onPick(s.sym)}
                    title={s.label}
                    role="option"
                    aria-selected={s.sym === selected}
                    aria-label={s.label}
                  >
                    <i className={pip ? `ms ms-${s.sym} ms-cost` : `ms ms-${s.sym}`} aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="sheet-actions">
        {onClear && <button onClick={onClear}>Remove emblem</button>}
        <button onClick={onCancel}>{closeLabel}</button>
      </div>
    </>
  );
}

function SetPicker({
  selected,
  color,
  onPick,
  onPickColor,
  onClear,
  onCancel,
  closeLabel,
}: {
  selected?: string;
  color: EmblemColor | undefined;
  onPick: (set: string) => void;
  onPickColor: (color: EmblemColor | undefined) => void;
  onClear?: () => void;
  onCancel: () => void;
  closeLabel: string;
}) {
  const [sets, setSets] = useState<CardSetInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const tint = color ? EMBLEM_COLOR_CSS[color] : undefined;

  useEffect(() => {
    let cancelled = false;
    void getSetList().then((list) => {
      if (!cancelled) setSets(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sets ?? [];
    // Newest first is the useful default; a full set list is thousands of rows
    // on a desktop, so cap what's rendered until the search narrows it.
    return (q ? list.filter((s) => s.setName.toLowerCase().includes(q) || s.set.includes(q)) : list).slice(0, 120);
  }, [sets, query]);

  return (
    <>
      <input
        className="search-input"
        type="search"
        placeholder="Search sets…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search sets"
      />
      <ColorRow color={color} onPick={onPickColor} />
      <div className="emblem-scroll">
        {sets === null ? (
          <p className="search-meta">Loading sets…</p>
        ) : shown.length === 0 ? (
          <p className="search-meta">No set by that name.</p>
        ) : (
          <ul className="menu-list">
            {shown.map((s) => (
              <li key={s.set}>
                <button
                  className={
                    s.set === selected ? 'menu-item menu-item-btn emblem-set-selected' : 'menu-item menu-item-btn'
                  }
                  onClick={() => onPick(s.set)}
                >
                  <span className="menu-icon emblem-set-icon" style={{ color: tint }} aria-hidden>
                    <SetSymbol set={s.set} />
                  </span>
                  <span className="deck-line">
                    <span className="deck-name">{s.setName}</span>
                    <span className="deck-meta">
                      {s.set.toUpperCase()} · {s.releasedAt.slice(0, 4)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sheet-actions">
        {onClear && <button onClick={onClear}>Remove emblem</button>}
        <button onClick={onCancel}>{closeLabel}</button>
      </div>
    </>
  );
}
