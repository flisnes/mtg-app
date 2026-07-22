import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  sanitizeDeckLines,
  type DeckFormat,
  type OracleCard,
  type Priced,
  type PublicDeckLine,
} from '@mtg/shared';
import { ApiError, getUserDeck } from '../account/api.js';
import { useAccount } from '../account/useAccount.js';
import { getOracleCardsByIds, getPrintingsByIds } from '../db/queries.js';
import { formatLabel } from '../deck/legality.js';
import { CardSheet } from '../components/CardSheet.js';
import { CardItems, ViewToggle, useViewMode, type CardItem } from '../components/CardViews.js';
import { SetSymbol } from '../components/SetSymbol.js';
import { EmptyState, Page } from './Page.js';

// Read-only view of someone's favorited deck (/profile/:username/deck/:deckId).
// The server reads the list live from the owner's synced rows, so this is
// always their current build; images resolve from the viewer's own card DB.

interface LoadedDeck {
  name: string;
  format: string;
  description?: string;
  updatedAt: number;
  lines: PublicDeckLine[];
}

const BOARD_ORDER = [
  { board: 'commander', title: 'Commander' },
  { board: 'main', title: 'Mainboard' },
  { board: 'side', title: 'Sideboard' },
] as const;

export function ProfileDeck() {
  const { username = '', deckId = '' } = useParams<{ username: string; deckId: string }>();
  const account = useAccount();

  if (!account.enabled || account.session === null) {
    return (
      <Page title="Deck">
        <EmptyState hint={<Link to="/settings">Go to Settings</Link>}>
          {account.enabled ? 'Sign in to view decks.' : 'Accounts aren’t configured for this build yet.'}
        </EmptyState>
      </Page>
    );
  }
  if (account.session === undefined) return <Page title="Deck">{null}</Page>;

  return <ProfileDeckView token={account.session.token} username={username} deckId={deckId} />;
}

function ProfileDeckView({ token, username, deckId }: { token: string; username: string; deckId: string }) {
  const navigate = useNavigate();
  const [deck, setDeck] = useState<LoadedDeck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useViewMode();
  const [info, setInfo] = useState<{ oracle: Priced<OracleCard>; scryfallId?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getUserDeck(token, username, deckId)
      .then((res) => {
        if (cancelled) return;
        // Another user's deck is untrusted input, same as their profile.
        setDeck({
          name: typeof res.name === 'string' ? res.name.slice(0, 80) : '(unnamed deck)',
          format: typeof res.format === 'string' ? res.format.slice(0, 20) : 'casual',
          description: typeof res.description === 'string' ? res.description.slice(0, 1000) : undefined,
          updatedAt: Number(res.updatedAt) || 0,
          lines: sanitizeDeckLines(res.lines),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This deck isn’t shared (or isn’t synced to the server yet).'
            : err instanceof ApiError
              ? err.friendlyMessage
              : 'Could not load the deck.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token, username, deckId]);

  // Resolve names/images from the viewer's own card DB by id.
  const cards = useLiveQuery(async () => {
    const lines = deck?.lines ?? [];
    const [oracles, printings] = await Promise.all([
      getOracleCardsByIds(lines.map((l) => l.oracleId)),
      getPrintingsByIds(lines.map((l) => l.scryfallId).filter((id): id is string => !!id)),
    ]);
    return { oracles, printings };
  }, [deck]);

  const boards = useMemo(() => {
    if (!deck) return [];
    return BOARD_ORDER.map(({ board, title }) => {
      const lines = deck.lines.filter((l) => l.board === board);
      const items: CardItem[] = lines
        .map((line, i) => {
          const oracle = cards?.oracles.get(line.oracleId);
          const printing = line.scryfallId ? cards?.printings.get(line.scryfallId) : undefined;
          return {
            key: `${line.oracleId}-${line.scryfallId ?? ''}-${i}`,
            name: oracle?.name ?? '(unknown card)',
            image: printing?.imageSmall ?? oracle?.imageSmall ?? null,
            count: line.quantity,
            sub: printing ? (
              <>
                <SetSymbol set={printing.set} className="sub-set-symbol" title={printing.setName} />
                {`${printing.setName} · #${printing.collectorNumber}`}
              </>
            ) : (
              oracle?.typeLine ?? ''
            ),
            onClick: oracle ? () => setInfo({ oracle, scryfallId: line.scryfallId }) : undefined,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { board, title, items, count: lines.reduce((s, l) => s + l.quantity, 0) };
    }).filter((b) => b.items.length > 0);
  }, [deck, cards]);

  const total = deck ? deck.lines.filter((l) => l.board !== 'side').reduce((s, l) => s + l.quantity, 0) : 0;

  return (
    <Page
      title={deck?.name ?? 'Deck'}
      subtitle={deck ? `${formatLabel(deck.format as DeckFormat)} · ${total} cards · ${username}’s deck` : undefined}
      menu={
        <button className="ghost" onClick={() => navigate(`/profile/${encodeURIComponent(username)}`)}>
          ‹ {username}’s profile
        </button>
      }
    >
      {error ? (
        <EmptyState>{error}</EmptyState>
      ) : !deck ? (
        <p className="fine-print">Loading…</p>
      ) : (
        <>
          {deck.description && <p className="fine-print">{deck.description}</p>}
          <div className="meta-row">
            <span />
            <div className="meta-actions">
              <ViewToggle mode={view} onChange={setView} />
            </div>
          </div>
          {boards.length === 0 ? (
            <EmptyState>This deck is empty.</EmptyState>
          ) : (
            boards.map(({ board, title, items, count }) => (
              <section key={board} className="about-section">
                <h2>
                  {title} ({count})
                </h2>
                <CardItems view={view} items={items} />
              </section>
            ))
          )}
        </>
      )}

      {info && (
        <CardSheet oracleCard={info.oracle} initialScryfallId={info.scryfallId} readOnly onClose={() => setInfo(null)} />
      )}
    </Page>
  );
}
