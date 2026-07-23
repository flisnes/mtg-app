import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router-dom';
import { DECK_FORMATS, type Color, type DeckFormat } from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { createDeck } from '../db/dataAccess.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { formatLabel } from '../deck/legality.js';
import { Icon } from '../components/icons.js';
import { ManaCost } from '../components/ManaCost.js';
import { HeaderValue, headerValue, useDecksValue } from '../components/ValueSummary.js';

// Canonical WUBRG order for pip display.
const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];

export function Decks() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [format, setFormat] = useState<DeckFormat>('casual');

  const decks = useLiveQuery(async () => {
    const list = await db.decks.orderBy('updatedAt').reverse().toArray();
    return Promise.all(
      list.map(async (deck) => {
        const cards = await db.deckCards.where('deckId').equals(deck.id).toArray();
        // Commander sits in the 100-card deck, so count it toward the mainboard.
        const main = cards.filter((c) => c.board !== 'side').reduce((s, c) => s + c.quantity, 0);
        const side = cards.filter((c) => c.board === 'side').reduce((s, c) => s + c.quantity, 0);
        // Deck colors = union of every card's colour identity (for a legal
        // commander deck this collapses to the commander's identity).
        const oracles = await getOracleCardsByIds(cards.map((c) => c.oracleId));
        const present = new Set<Color>();
        for (const card of oracles.values()) for (const c of card.colorIdentity) present.add(c);
        const colors = COLOR_ORDER.filter((c) => present.has(c));
        return { deck, main, side, colors };
      }),
    );
  }, []);

  const value = useDecksValue();

  async function create() {
    const id = await createDeck(name || 'Untitled deck', format);
    setName('');
    navigate(`/decks/${id}`);
  }

  return (
    <Page
      title="Decks"
      subtitle="Brew decks; owned cards get a green check."
      aside={<HeaderValue value={headerValue(value)} />}
    >
      <div className="list-toolbar">
        <input
          className="search-input grow"
          placeholder="New deck name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          aria-label="New deck name"
        />
        <select value={format} onChange={(e) => setFormat(e.target.value as DeckFormat)} aria-label="Format">
          {DECK_FORMATS.map((f) => (
            <option key={f} value={f}>
              {formatLabel(f)}
            </option>
          ))}
        </select>
        <button className="primary" onClick={create}>
          Create
        </button>
      </div>

      {decks === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : decks.length === 0 ? (
        <div className="empty-state">
          <p>No decks yet.</p>
          <p className="empty-phase">Name one above and hit Create.</p>
        </div>
      ) : (
        <ul className="menu-list">
          {decks.map(({ deck, main, side, colors }) => (
            <li key={deck.id}>
              <Link className="menu-item" to={`/decks/${deck.id}`}>
                <span className="menu-icon" aria-hidden>
                  <Icon name="decks" />
                </span>
                <span className="deck-line">
                  <span className="deck-name">{deck.name}</span>
                  <span className="deck-meta">
                    <span className="deck-format">{formatLabel(deck.format ?? 'casual')}</span>
                    <ManaCost
                      cost={colors.length > 0 ? colors.map((c) => `{${c}}`).join('') : '{C}'}
                      className="deck-colors"
                    />
                    <span className="badge" title={`${main} mainboard · ${side} sideboard`}>
                      {main} / {side}
                    </span>
                  </span>
                </span>
                <span className="menu-chevron" aria-hidden>
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
