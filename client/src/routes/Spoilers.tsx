import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { CardItems, useViewMode, ViewToggle, type CardItem } from '../components/CardViews.js';
import { CardSheet } from '../components/CardSheet.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { Icon } from '../components/icons.js';

// Spoilers & reprints: browse the newest sets and see, per set, which cards are
// brand new (their first printing) and which are reprints of older cards. All
// derived from the local card DB (which resyncs daily), so freshness tracks the
// nightly Scryfall pull — spoiled-but-unreleased sets carry a future releasedAt
// and sort to the top, tagged "upcoming".

// How many recent sets to offer in the picker. The card DB has no set-type
// field, so token/promo "sets" ride along; newest-first ordering keeps the real
// releases up top where they matter.
const RECENT_SET_LIMIT = 30;

type Kind = 'all' | 'new' | 'reprints';

interface SetSummary {
  code: string;
  name: string;
  releasedAt: string;
  upcoming: boolean;
  newCount: number;
  reprintCount: number;
}

interface SpoilerCard {
  scryfallId: string;
  oracleId: string;
  image: string | null;
  isReprint: boolean;
  /** Where the card first appeared (for the reprint sub-line). */
  firstSet: string;
  firstSetName: string;
  firstYear: string;
}

/** Prefer an English printing that has an image, then a stable id tiebreak. */
function better(a: Printing, b: Printing): boolean {
  const aEn = a.lang === 'en' ? 1 : 0;
  const bEn = b.lang === 'en' ? 1 : 0;
  if (aEn !== bEn) return aEn > bEn;
  const aImg = a.imageNormal || a.imageSmall ? 1 : 0;
  const bImg = b.imageNormal || b.imageSmall ? 1 : 0;
  if (aImg !== bImg) return aImg > bImg;
  return a.scryfallId <= b.scryfallId;
}

// One full scan of the printings table. It's the whole card DB (~100k rows), but
// we need every printing to know each card's earliest release (its debut), and
// the table only changes on a card-DB update, so useLiveQuery re-runs rarely.
async function loadSpoilerData(): Promise<{ summaries: SetSummary[]; bySet: Map<string, SpoilerCard[]> }> {
  const printings = await db.printings.toArray();

  // Each card's debut = its earliest printing across all sets.
  const debut = new Map<string, Printing>();
  // Group printings by set, tracking the set's release date (its earliest card).
  const sets = new Map<string, { code: string; name: string; releasedAt: string; rows: Printing[] }>();
  for (const p of printings) {
    const d = debut.get(p.oracleId);
    if (!d || p.releasedAt < d.releasedAt) debut.set(p.oracleId, p);
    let s = sets.get(p.set);
    if (!s) {
      s = { code: p.set, name: p.setName, releasedAt: p.releasedAt, rows: [] };
      sets.set(p.set, s);
    }
    if (p.releasedAt < s.releasedAt) s.releasedAt = p.releasedAt;
    s.rows.push(p);
  }

  const recent = [...sets.values()]
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || a.name.localeCompare(b.name))
    .slice(0, RECENT_SET_LIMIT);

  const today = new Date().toISOString().slice(0, 10);
  const summaries: SetSummary[] = [];
  const bySet = new Map<string, SpoilerCard[]>();
  for (const s of recent) {
    // Collapse variants (showcase, foil, collector-number siblings) to one entry
    // per card, keeping the nicest printing to show.
    const rep = new Map<string, Printing>();
    for (const p of s.rows) {
      const cur = rep.get(p.oracleId);
      if (!cur || better(p, cur)) rep.set(p.oracleId, p);
    }
    const cards: SpoilerCard[] = [];
    let newCount = 0;
    let reprintCount = 0;
    for (const p of rep.values()) {
      const d = debut.get(p.oracleId)!;
      const isReprint = d.releasedAt < s.releasedAt; // debuted before this set → a reprint
      if (isReprint) reprintCount++;
      else newCount++;
      cards.push({
        scryfallId: p.scryfallId,
        oracleId: p.oracleId,
        image: p.imageNormal ?? p.imageSmall,
        isReprint,
        firstSet: d.set,
        firstSetName: d.setName,
        firstYear: d.releasedAt.slice(0, 4),
      });
    }
    summaries.push({
      code: s.code,
      name: s.name,
      releasedAt: s.releasedAt,
      upcoming: s.releasedAt > today,
      newCount,
      reprintCount,
    });
    bySet.set(s.code, cards);
  }
  return { summaries, bySet };
}

export function Spoilers() {
  const [view, setView] = useViewMode();
  // null = "not yet chosen", so we default to the newest set. Once the user
  // touches the picker this becomes an explicit list (possibly empty).
  const [pickedCodes, setPickedCodes] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('all');
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId: string } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const data = useLiveQuery(loadSpoilerData, []);
  const defaultCode = data?.summaries[0]?.code;

  // Which sets are checked. Membership only — display order follows summaries.
  const selectedSet = useMemo(
    () => new Set(pickedCodes ?? (defaultCode ? [defaultCode] : [])),
    [pickedCodes, defaultCode],
  );
  const selectedSummaries = useMemo(
    () => (data?.summaries ?? []).filter((s) => selectedSet.has(s.code)),
    [data, selectedSet],
  );

  // Merge every checked set into one list, deduped by card (a staple reprinted
  // across two chosen sets shows once). A card new in any chosen set counts as
  // new, so we keep the "new" printing when the same card appears both ways.
  const cards = useMemo<SpoilerCard[] | undefined>(() => {
    if (!data) return undefined;
    const byOracle = new Map<string, SpoilerCard>();
    for (const s of data.summaries) {
      if (!selectedSet.has(s.code)) continue;
      for (const c of data.bySet.get(s.code) ?? []) {
        const cur = byOracle.get(c.oracleId);
        if (!cur || (!c.isReprint && cur.isReprint)) byOracle.set(c.oracleId, c);
      }
    }
    return [...byOracle.values()];
  }, [data, selectedSet]);

  const newCount = cards?.filter((c) => !c.isReprint).length ?? 0;
  const reprintCount = (cards?.length ?? 0) - newCount;
  // The lone chosen set gets the richer header (released date / upcoming chip).
  const single = selectedSummaries.length === 1 ? selectedSummaries[0] : null;

  // Close the picker on outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  function toggleSet(code: string) {
    setPickedCodes((prev) => {
      const next = new Set(prev ?? (defaultCode ? [defaultCode] : []));
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return [...next];
    });
    setKind('all');
  }

  // Names live on the oracle card, not the printing, and CardSheet needs the
  // priced oracle card — join only the selected sets' cards.
  const oracleMap = useLiveQuery(
    async () => (cards ? getOracleCardsByIds(cards.map((c) => c.oracleId)) : undefined),
    [cards],
  );

  const items = useMemo<CardItem[]>(() => {
    if (!cards || !oracleMap) return [];
    return cards
      .filter((c) => (kind === 'all' ? true : kind === 'new' ? !c.isReprint : c.isReprint))
      .map((c) => ({ c, oracle: oracleMap.get(c.oracleId) }))
      .filter((x): x is { c: SpoilerCard; oracle: Priced<OracleCard> } => !!x.oracle)
      // New cards first, then reprints; alphabetical within each.
      .sort((a, b) => (a.c.isReprint === b.c.isReprint ? a.oracle.name.localeCompare(b.oracle.name) : a.c.isReprint ? 1 : -1))
      .map(
        ({ c, oracle }): CardItem => ({
          key: c.scryfallId,
          name: oracle.name,
          image: c.image,
          badge: c.isReprint ? 'Reprint' : 'New',
          badgeClass: c.isReprint ? 'badge-reprint' : 'badge-new',
          badgeTitle: c.isReprint ? `Reprint · first printed in ${c.firstSetName} (${c.firstYear})` : 'New card',
          sub: c.isReprint ? (
            <span className="mover-sub">
              <SetSymbol set={c.firstSet} className="sub-set-symbol" title={c.firstSetName} />
              Reprint · first in {c.firstSetName} ({c.firstYear})
            </span>
          ) : (
            <span className="mover-sub">New card</span>
          ),
          onClick: () => setInfo({ oracle, scryfallId: c.scryfallId }),
        }),
      );
  }, [cards, oracleMap, kind]);

  return (
    <Page
      title="Spoilers & reprints"
      subtitle="New cards and reprints from the latest sets. Refreshes with the daily card-data update."
    >
      {data === undefined ? (
        <p className="search-meta">Shuffling up…</p>
      ) : data.summaries.length === 0 ? (
        <EmptyState hint="Card data downloads on first launch and refreshes daily.">
          No set data yet.
        </EmptyState>
      ) : (
        <>
          <div className="filter-row">
            <div className="set-picker" ref={pickerRef}>
              <button
                type="button"
                className="set-picker-trigger"
                onClick={() => setPickerOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={pickerOpen}
              >
                <span className="set-picker-label">
                  {selectedSummaries.length === 0
                    ? 'Choose sets…'
                    : single
                      ? single.name
                      : `${selectedSummaries.length} sets`}
                </span>
                <Icon name="chevronDown" size={16} />
              </button>
              {pickerOpen && (
                <div className="set-picker-panel" role="listbox" aria-multiselectable="true" aria-label="Sets">
                  {data.summaries.map((s) => {
                    const checked = selectedSet.has(s.code);
                    return (
                      <label key={s.code} className="set-picker-row" role="option" aria-selected={checked}>
                        <input type="checkbox" checked={checked} onChange={() => toggleSet(s.code)} />
                        <SetSymbol set={s.code} className="sub-set-symbol" title={s.name} />
                        <span className="set-picker-name">{s.name}</span>
                        <span className="set-picker-year">{s.upcoming ? 'upcoming' : s.releasedAt.slice(0, 4)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <ViewToggle mode={view} onChange={setView} />
          </div>

          {selectedSummaries.length === 0 ? (
            <p className="search-meta">Pick one or more sets to see their spoilers and reprints.</p>
          ) : (
            <>
              <div className="spoiler-set-head">
                {single ? (
                  <>
                    <SetSymbol set={single.code} className="sub-set-symbol" title={single.name} />
                    <span>{single.name}</span>
                    {single.upcoming ? (
                      <span className="chip">Upcoming</span>
                    ) : (
                      <span className="fine-print">Released {single.releasedAt}</span>
                    )}
                  </>
                ) : (
                  selectedSummaries.map((s) => (
                    <span key={s.code} className="spoiler-set-tag">
                      <SetSymbol set={s.code} className="sub-set-symbol" title={s.name} />
                      {s.name}
                    </span>
                  ))
                )}
              </div>

              <div className="seg-row" role="group" aria-label="Card kind">
                <button className={`seg${kind === 'all' ? ' seg-active' : ''}`} onClick={() => setKind('all')} aria-pressed={kind === 'all'}>
                  All ({newCount + reprintCount})
                </button>
                <button className={`seg${kind === 'new' ? ' seg-active' : ''}`} onClick={() => setKind('new')} aria-pressed={kind === 'new'}>
                  New ({newCount})
                </button>
                <button
                  className={`seg${kind === 'reprints' ? ' seg-active' : ''}`}
                  onClick={() => setKind('reprints')}
                  aria-pressed={kind === 'reprints'}
                >
                  Reprints ({reprintCount})
                </button>
              </div>

              {oracleMap === undefined ? (
                <p className="search-meta">Loading cards…</p>
              ) : items.length === 0 ? (
                <p className="search-meta">
                  {kind === 'new'
                    ? 'No new cards in the chosen sets.'
                    : kind === 'reprints'
                      ? 'No reprints in the chosen sets.'
                      : 'No cards in the chosen sets.'}
                </p>
              ) : (
                <CardItems items={items} view={view} />
              )}
            </>
          )}
        </>
      )}

      {info && (
        <CardSheet
          oracleCard={info.oracle}
          initialScryfallId={info.scryfallId}
          addTarget={{ kind: 'wishlist' }}
          onClose={() => setInfo(null)}
        />
      )}
    </Page>
  );
}
