import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Priced, Printing } from '@mtg/shared';
import { Icon } from './icons.js';
import { SetSymbol } from './SetSymbol.js';

// One-line edition picker. Closed, it is a single row showing the printing
// you're looking at (set symbol + set name). Tap it and that row becomes the
// search box while the list unfolds beneath it, the current edition first. The
// old two-row shape — a filter box stacked on a native <select> — spent a line
// on a field that was empty most of the time, and a native select can't show a
// set symbol per option, which is the fastest way to recognise an edition.
//
// The list expands in flow rather than floating: the card sheet's body is a
// scroll container, so an absolutely positioned panel would be clipped by it.

/** Sentinel value for the "any printing" row (mirrors CardSheet's ANY_PRINTING). */
const ANY = '';

type Row =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'any'; key: string; label: string }
  | { kind: 'printing'; key: string; p: Priced<Printing>; note?: string };

export function EditionPicker({
  printings,
  highlighted,
  highlightLabel,
  notes,
  selected,
  anyLabel,
  restLabel = 'Other printings',
  placeholder = 'Choose an edition…',
  hideCollector = false,
  disabled = false,
  onSelect,
}: {
  /** Editions in display order (the caller sorts owned ones first). */
  printings: Priced<Printing>[];
  /** Editions the caller flagged; they group first, under `highlightLabel`. */
  highlighted?: Priced<Printing>[];
  highlightLabel?: string;
  /** Short annotations per printing, e.g. "×2, 1 for trade". */
  notes?: Map<string, string>;
  /** Selected scryfallId, or '' for "any printing". */
  selected: string;
  /** Label for the "any printing" row; omit when this card can't have one. */
  anyLabel?: string;
  /** Header over the un-highlighted rows (only shown when `highlighted` is used). */
  restLabel?: string;
  /** Trigger text while nothing is selected. */
  placeholder?: string;
  /** Drop the collector number: the scanner picks a *set*, and #123 is noise there. */
  hideCollector?: boolean;
  disabled?: boolean;
  onSelect: (scryfallId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const uid = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const current = useMemo(
    () => [...(highlighted ?? []), ...printings].find((p) => p.scryfallId === selected),
    [highlighted, printings, selected],
  );

  const q = query.trim().toLowerCase();
  const rows = useMemo<Row[]>(() => {
    const match = (p: Priced<Printing>) =>
      !q || p.setName.toLowerCase().includes(q) || p.set.toLowerCase().includes(q);
    const row = (p: Priced<Printing>, key = p.scryfallId): Row => ({
      kind: 'printing',
      key,
      p,
      note: notes?.get(p.scryfallId),
    });

    const out: Row[] = [];
    // Opening the picker puts what you're already looking at on the first line.
    // Once you type, the list is all results — pinning a set that doesn't match
    // what you typed only gets in the way.
    const pinned = !q;
    if (pinned) {
      if (current) out.push(row(current, `pin-${current.scryfallId}`));
      else if (anyLabel !== undefined && selected === ANY) out.push({ kind: 'any', key: 'pin-any', label: anyLabel });
      // "Any printing" has no set name to search, so it only shows unfiltered.
      if (anyLabel !== undefined && selected !== ANY) out.push({ kind: 'any', key: 'any', label: anyLabel });
    }
    const drop = (p: Priced<Printing>) => pinned && p.scryfallId === selected;

    const hi = (highlighted ?? []).filter((p) => match(p) && !drop(p));
    const rest = printings.filter((p) => match(p) && !drop(p));
    if (highlightLabel && (highlighted?.length ?? 0) > 0) {
      if (hi.length > 0) {
        out.push({ kind: 'header', key: 'h-hi', label: highlightLabel });
        out.push(...hi.map((p) => row(p)));
      }
      if (rest.length > 0) {
        out.push({ kind: 'header', key: 'h-rest', label: restLabel });
        out.push(...rest.map((p) => row(p)));
      }
    } else {
      out.push(...rest.map((p) => row(p)));
    }
    return out;
  }, [q, current, selected, anyLabel, highlighted, highlightLabel, restLabel, printings, notes]);

  const firstPickable = rows.findIndex((r) => r.kind !== 'header');

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (id: string) => {
    onSelect(id);
    close();
  };

  // Focus the search box as it appears, and make sure the list it just pushed
  // open is actually on screen (the sheet body may be scrolled elsewhere).
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    rootRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  useEffect(() => setActive(firstPickable), [firstPickable, q]);

  // Close on a tap outside. Escape is caught on `window` in the capture phase so
  // it lands before the sheet's own document-level handler: one Escape closes
  // the picker, the next closes the sheet.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const step = (dir: 1 | -1) => {
    setActive((i) => {
      for (let n = i + dir; n >= 0 && n < rows.length; n += dir) {
        if (rows[n]!.kind !== 'header') return n;
      }
      return i;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r && r.kind !== 'header') choose(r.kind === 'any' ? ANY : r.p.scryfallId);
    }
  };

  const triggerLabel = current
    ? [current.setName, hideCollector ? null : `#${current.collectorNumber}`, current.releasedAt.slice(0, 4)]
        .filter(Boolean)
        .join(' · ')
    : selected === ANY && anyLabel !== undefined
      ? anyLabel
      : placeholder;

  return (
    <div className={open ? 'edition-picker open' : 'edition-picker'} ref={rootRef}>
      {open ? (
        <input
          ref={inputRef}
          type="text"
          className="edition-picker-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search by set name or code (e.g. MH2)"
          aria-label="Search editions"
          role="combobox"
          aria-expanded
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${uid}-r${active}` : undefined}
        />
      ) : (
        <button
          type="button"
          className="edition-picker-trigger"
          disabled={disabled}
          onClick={() => setOpen(true)}
          aria-haspopup="listbox"
          aria-expanded={false}
        >
          {current ? (
            <SetSymbol set={current.set} className="edition-picker-symbol" title={current.setName} />
          ) : (
            <span className="edition-picker-symbol" aria-hidden />
          )}
          <span className="edition-picker-name">{triggerLabel}</span>
          <Icon name="chevronDown" size={16} />
        </button>
      )}

      {open && (
        <div className="edition-picker-list" id={`${uid}-list`} role="listbox" aria-label="Edition">
          {rows.length === 0 ? (
            <p className="edition-picker-empty">No set matches that.</p>
          ) : (
            rows.map((r, i) =>
              r.kind === 'header' ? (
                <div key={r.key} className="edition-picker-group" role="presentation">
                  {r.label}
                </div>
              ) : (
                <EditionRow
                  key={r.key}
                  id={`${uid}-r${i}`}
                  row={r}
                  selected={(r.kind === 'any' ? ANY : r.p.scryfallId) === selected}
                  active={i === active}
                  hideCollector={hideCollector}
                  onHover={() => setActive(i)}
                  onPick={() => choose(r.kind === 'any' ? ANY : r.p.scryfallId)}
                />
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}

function EditionRow({
  id,
  row,
  selected,
  active,
  hideCollector,
  onHover,
  onPick,
}: {
  id: string;
  row: Extract<Row, { kind: 'any' | 'printing' }>;
  selected: boolean;
  active: boolean;
  hideCollector: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
      className={`edition-picker-row${selected ? ' selected' : ''}${active ? ' active' : ''}`}
      onClick={onPick}
      onMouseEnter={onHover}
    >
      {row.kind === 'any' ? (
        <span className="edition-picker-symbol" aria-hidden />
      ) : (
        <SetSymbol set={row.p.set} className="edition-picker-symbol" title={row.p.setName} />
      )}
      <span className="edition-picker-name">{row.kind === 'any' ? row.label : row.p.setName}</span>
      {row.kind === 'printing' && (
        <span className="edition-picker-meta">
          {hideCollector ? '' : `#${row.p.collectorNumber} · `}
          {row.p.releasedAt.slice(0, 4)}
          {row.note ? ` · ${row.note}` : ''}
        </span>
      )}
      {selected && <Icon name="check" size={14} className="edition-picker-check" />}
    </button>
  );
}
