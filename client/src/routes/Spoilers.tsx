import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { OracleCard, Priced, Printing } from '@mtg/shared';
import { Page, EmptyState } from './Page.js';
import { db } from '../db/schema.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { CardItems, useViewMode, ViewToggle, type CardItem } from '../components/CardViews.js';
import { CardSheet } from '../components/CardSheet.js';
import { SetSymbol } from '../components/SetSymbol.js';

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
  const [pickedCode, setPickedCode] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('all');
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId: string } | null>(null);

  const data = useLiveQuery(loadSpoilerData, []);
  const selected = pickedCode ?? data?.summaries[0]?.code ?? null;
  const summary = data?.summaries.find((s) => s.code === selected);
  const cards = selected ? data?.bySet.get(selected) : undefined;

  // Names live on the oracle card, not the printing, and CardSheet needs the
  // priced oracle card — join only the selected set's cards.
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
      ) : data.summaries.length === 0 || !summary ? (
        <EmptyState hint="Card data downloads on first launch and refreshes daily.">
          No set data yet.
        </EmptyState>
      ) : (
        <>
          <div className="filter-row">
            <select
              value={selected ?? ''}
              onChange={(e) => {
                setPickedCode(e.target.value);
                setKind('all');
              }}
              aria-label="Set"
            >
              {data.summaries.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                  {s.upcoming ? ' · upcoming' : ` · ${s.releasedAt.slice(0, 4)}`}
                </option>
              ))}
            </select>
            <ViewToggle mode={view} onChange={setView} />
          </div>

          <div className="spoiler-set-head">
            <SetSymbol set={summary.code} className="sub-set-symbol" title={summary.name} />
            <span>{summary.name}</span>
            {summary.upcoming ? (
              <span className="chip">Upcoming</span>
            ) : (
              <span className="fine-print">Released {summary.releasedAt}</span>
            )}
          </div>

          <div className="seg-row" role="group" aria-label="Card kind">
            <button className={`seg${kind === 'all' ? ' seg-active' : ''}`} onClick={() => setKind('all')} aria-pressed={kind === 'all'}>
              All ({summary.newCount + summary.reprintCount})
            </button>
            <button className={`seg${kind === 'new' ? ' seg-active' : ''}`} onClick={() => setKind('new')} aria-pressed={kind === 'new'}>
              New ({summary.newCount})
            </button>
            <button
              className={`seg${kind === 'reprints' ? ' seg-active' : ''}`}
              onClick={() => setKind('reprints')}
              aria-pressed={kind === 'reprints'}
            >
              Reprints ({summary.reprintCount})
            </button>
          </div>

          {oracleMap === undefined ? (
            <p className="search-meta">Loading cards…</p>
          ) : items.length === 0 ? (
            <p className="search-meta">
              {kind === 'new' ? 'No new cards in this set.' : kind === 'reprints' ? 'No reprints in this set.' : 'No cards in this set.'}
            </p>
          ) : (
            <CardItems items={items} view={view} />
          )}
        </>
      )}

      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}
