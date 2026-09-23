import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { usePlacementIndex } from '../db/usePlacements.js';
import { useFiling } from '../deck/useFiling.js';
import type { FilingCopy } from '../deck/filing.js';
import type { ManaFix } from '../deck/manaFixes.js';
import { deckManaStats } from '../deck/manaStats.js';
import { useToast } from '../components/Toast.js';
import { Icon } from '../components/icons.js';
import { ANALYSIS_TABS, DeckAnalysis, type AnalysisTab } from '../components/DeckAnalysis.js';
import { Page } from './Page.js';

// #/decks/:id/analysis — the deck analysis as its own page (rebuild plan A4).
// It was a sheet over the deck page until v0.162; a sheet is the wrong shape for
// something with tabs, a context bar and a card editor inside it.

const isTab = (t: string | null): t is AnalysisTab => ANALYSIS_TABS.some((x) => x.id === t);

export function DeckAnalysisPage() {
  const { id = '' } = useParams();
  // The tab lives in the URL so the back button and a reload both land where
  // you were, which matters once the Model tab is where you spend your time.
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: AnalysisTab = isTab(raw) ? raw : 'overview';
  const setTab = (next: AnalysisTab) => setParams({ tab: next }, { replace: true });

  const placements = usePlacementIndex();
  const { file, sheet: filingSheet } = useFiling();
  const toast = useToast();

  const data = useLiveQuery(async () => {
    const deck = await db.decks.get(id);
    if (!deck) return { deck: null, rows: [] };
    const cards = await db.deckCards.where('deckId').equals(id).toArray();
    const oracles = await getOracleCardsByIds(cards.map((c) => c.oracleId));
    return { deck, rows: cards.map((c) => ({ quantity: c.quantity, board: c.board, oracle: oracles.get(c.oracleId) })) };
  }, [id]);

  const stats = useMemo(() => deckManaStats(data?.rows ?? [], data?.deck?.format), [data]);

  /**
   * Take the fix panel's suggestion: file that many copies of a card you own
   * into the mainboard. The ordinary filing path, so what moves is real
   * cardboard out of the binder or box it was sitting in.
   */
  async function addManaFix(fix: ManaFix) {
    const copies: FilingCopy[] = [];
    let left = fix.copies;
    for (const c of fix.candidate.copies) {
      if (left <= 0) break;
      const take = Math.min(left, c.quantity);
      left -= take;
      copies.push({
        oracleId: fix.candidate.oracleId,
        quantity: take,
        board: 'main',
        scryfallId: c.scryfallId,
        wants: { condition: c.condition, finish: c.finish, lang: c.lang },
        label: fix.candidate.name,
      });
    }
    if (copies.length === 0) return;
    const filing = await file(id, copies);
    if (filing === null) return;
    toast(filing.filed === 0 ? 'Already in this deck' : `Added ${filing.filed}× ${fix.candidate.name} to the deck`);
  }

  if (data === undefined) return <div className="page">Loading…</div>;
  if (!data.deck) {
    return (
      <Page title="Deck analysis">
        <p className="fine-print">This deck doesn't exist any more.</p>
      </Page>
    );
  }

  return (
    <Page title={data.deck.name} meta="Deck analysis">
      <Link to={`/decks/${id}`} className="behavior-back">
        <Icon name="chevronLeft" />
        <span>Back to the deck</span>
      </Link>
      <DeckAnalysis
        key={id}
        stats={stats}
        rows={data.rows}
        deckId={id}
        format={data.deck.format}
        placements={placements}
        onAddFix={(fix) => void addManaFix(fix)}
        tab={tab}
        onTab={setTab}
      />
      {filingSheet}
    </Page>
  );
}
