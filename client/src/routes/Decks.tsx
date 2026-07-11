import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router-dom';
import { DECK_FORMATS, type DeckFormat } from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { createDeck } from '../db/dataAccess.js';
import { formatLabel } from '../deck/legality.js';
import { Icon } from '../components/icons.js';

export function Decks() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [format, setFormat] = useState<DeckFormat>('casual');

  const decks = useLiveQuery(async () => {
    const list = await db.decks.orderBy('updatedAt').reverse().toArray();
    return Promise.all(
      list.map(async (deck) => ({
        deck,
        count: (await db.deckCards.where('deckId').equals(deck.id).toArray()).reduce((s, c) => s + c.quantity, 0),
      })),
    );
  }, []);

  async function create() {
    const id = await createDeck(name || 'Untitled deck', format);
    setName('');
    navigate(`/decks/${id}`);
  }

  return (
    <Page title="Decks" subtitle="Brew decks; owned cards get a green check.">
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
          {decks.map(({ deck, count }) => (
            <li key={deck.id}>
              <Link className="menu-item" to={`/decks/${deck.id}`}>
                <span className="menu-icon" aria-hidden>
                  <Icon name="decks" />
                </span>
                <span>
                  {deck.name}
                  <span className="badge">{count} cards</span>
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
