import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContainerEmblem, ContainerKind, OracleCard, Priced } from '@mtg/shared';
import { getSetList, type CardSetInfo } from '../db/queries.js';
import { CardSearch, CropStage } from './AvatarEditorSheet.js';
import { Emblem } from './Emblem.js';
import { EMBLEM_MANA_PIPS, EMBLEM_SYMBOL_GROUPS } from './emblemSymbols.js';
import { SetSymbol } from './SetSymbol.js';
import { useDismiss } from './useDismiss.js';
import { useTapGuard } from './useTapGuard.js';

// Pick what a deck, binder or box wears in the list. Three ways in, one per tab:
//  - Art: search any card, then frame it — the profile-picture flow, reused
//    wholesale (CardSearch + CropStage).
//  - Symbol: the curated Mana font slice (emblemSymbols.ts).
//  - Set: every set the installed card DB knows, as its Keyrune symbol.
// Symbols and sets commit on tap; the art path needs its crop confirmed.

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

  function commit(next: ContainerEmblem | undefined) {
    onSave(next);
    onClose();
  }

  return createPortal(
    <div className="sheet-backdrop" onClick={onClose} {...tapGuard}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Emblem for ${name}`}>
        <div className="sheet-name emblem-sheet-name">
          <Emblem emblem={emblem} kind={kind} size={28} />
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
              actions={emblem ? <button onClick={() => commit(undefined)}>Remove emblem</button> : undefined}
            />
          ))}

        {tab === 'symbol' && (
          <SymbolPicker
            selected={emblem?.type === 'symbol' ? emblem.symbol : undefined}
            onPick={(symbol) => commit({ type: 'symbol', symbol })}
            onClear={emblem ? () => commit(undefined) : undefined}
            onCancel={onClose}
          />
        )}

        {tab === 'set' && (
          <SetPicker
            selected={emblem?.type === 'set' ? emblem.set : undefined}
            onPick={(set) => commit({ type: 'set', set })}
            onClear={emblem ? () => commit(undefined) : undefined}
            onCancel={onClose}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function SymbolPicker({
  selected,
  onPick,
  onClear,
  onCancel,
}: {
  selected?: string;
  onPick: (symbol: string) => void;
  onClear?: () => void;
  onCancel: () => void;
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
      <div className="emblem-scroll">
        {groups.length === 0 && <p className="search-meta">No symbol by that name.</p>}
        {groups.map((g) => (
          <div key={g.title} className="emblem-group">
            <h3 className="emblem-group-title">{g.title}</h3>
            <div className="emblem-grid" role="listbox" aria-label={g.title}>
              {g.symbols.map((s) => {
                const pip = EMBLEM_MANA_PIPS.has(s.sym);
                return (
                  <button
                    key={s.sym}
                    className={s.sym === selected ? 'emblem-choice emblem-choice-selected' : 'emblem-choice'}
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
        <button onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}

function SetPicker({
  selected,
  onPick,
  onClear,
  onCancel,
}: {
  selected?: string;
  onPick: (set: string) => void;
  onClear?: () => void;
  onCancel: () => void;
}) {
  const [sets, setSets] = useState<CardSetInfo[] | null>(null);
  const [query, setQuery] = useState('');

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
                  <span className="menu-icon emblem-set-icon" aria-hidden>
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
        <button onClick={onCancel}>Cancel</button>
      </div>
    </>
  );
}
