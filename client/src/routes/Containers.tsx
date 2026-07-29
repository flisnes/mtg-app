import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router-dom';
import { CONTAINER_KINDS, DECK_FORMATS, type Color, type ContainerKind, type DeckFormat } from '@mtg/shared';
import { Page } from './Page.js';
import { db } from '../db/schema.js';
import { createContainer } from '../db/dataAccess.js';
import { getOracleCardsByIds } from '../db/queries.js';
import { formatLabel } from '../deck/legality.js';
import { CONTAINER_META, containerKind } from '../deck/containers.js';
import { Icon } from '../components/icons.js';
import { ManaCost } from '../components/ManaCost.js';
import { HeaderValue, missingValue, useContainersValue, valueText } from '../components/ValueSummary.js';

// Canonical WUBRG order for pip display.
const COLOR_ORDER: Color[] = ['W', 'U', 'B', 'R', 'G'];

/**
 * Decks, binders and boxes, one screen with three segments. All three are rows
 * of the same table (see deck/containers.ts): a deck is a list you brew, a
 * binder or box is where the cards physically live. The segment only changes
 * which rows show, whether a format is offered, and the wording.
 */
export function Containers({ kind }: { kind: ContainerKind }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [format, setFormat] = useState<DeckFormat>('casual');
  const meta = CONTAINER_META[kind];
  const isDeck = kind === 'deck';

  const rows = useLiveQuery(async () => {
    const list = (await db.decks.orderBy('updatedAt').reverse().toArray()).filter(
      (d) => containerKind(d) === kind,
    );
    return Promise.all(
      list.map(async (deck) => {
        const cards = await db.deckCards.where('deckId').equals(deck.id).toArray();
        // Commander sits in the 100-card deck, so count it toward the mainboard.
        const main = cards.filter((c) => c.board !== 'side').reduce((s, c) => s + c.quantity, 0);
        const side = cards.filter((c) => c.board === 'side').reduce((s, c) => s + c.quantity, 0);
        // Colors = union of every card's colour identity (for a legal commander
        // deck this collapses to the commander's identity; for a box it shows
        // what's in there, which is the point of a "blue box").
        const oracles = await getOracleCardsByIds(cards.map((c) => c.oracleId));
        const present = new Set<Color>();
        for (const card of oracles.values()) for (const c of card.colorIdentity) present.add(c);
        const colors = COLOR_ORDER.filter((c) => present.has(c));
        return { deck, main, side, colors };
      }),
    );
  }, [kind]);

  const value = useContainersValue(kind);
  // Header leads with what the copies you actually hold are worth; the cards on
  // a list you don't own yet aren't money on your shelf.
  const ownedTotal = value ? (valueText(value.total.owned) ?? '—') : undefined;
  const missingTotal = value ? valueText(missingValue(value.total)) : undefined;

  async function create() {
    const id = await createContainer(name, kind, format);
    setName('');
    navigate(`${meta.path}/${id}`);
  }

  return (
    <Page
      title={meta.Plural}
      subtitle={meta.subtitle}
      aside={
        <HeaderValue
          label="Owned value"
          value={ownedTotal}
          note={missingTotal && `+${missingTotal} not owned`}
        />
      }
    >
      <div className="seg-row" role="tablist" aria-label="Decks, binders or boxes">
        {CONTAINER_KINDS.map((k) => (
          <Link
            key={k}
            role="tab"
            aria-selected={k === kind}
            className={k === kind ? 'seg seg-active' : 'seg'}
            to={CONTAINER_META[k].path}
          >
            {CONTAINER_META[k].Plural}
          </Link>
        ))}
      </div>

      <div className="list-toolbar">
        <input
          className="search-input grow"
          placeholder={`New ${meta.noun} name…`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          aria-label={`New ${meta.noun} name`}
        />
        {isDeck && (
          <select value={format} onChange={(e) => setFormat(e.target.value as DeckFormat)} aria-label="Format">
            {DECK_FORMATS.map((f) => (
              <option key={f} value={f}>
                {formatLabel(f)}
              </option>
            ))}
          </select>
        )}
        <button className="primary" onClick={create}>
          Create
        </button>
      </div>

      {rows === undefined ? (
        <p className="search-meta">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p>No {meta.Plural.toLowerCase()} yet.</p>
          <p className="empty-phase">
            {isDeck
              ? 'Name one above and hit Create.'
              : `Name one above and hit Create, then file cards into it from your collection.`}
          </p>
        </div>
      ) : (
        <ul className="menu-list">
          {rows.map(({ deck, main, side, colors }) => {
            const own = value?.byId.get(deck.id);
            const ownText = own && valueText(own.owned);
            const missText = own && valueText(missingValue(own));
            return (
            <li key={deck.id}>
              <Link className="menu-item" to={`${meta.path}/${deck.id}`}>
                <span className="menu-icon" aria-hidden>
                  <Icon name={meta.icon} />
                </span>
                <span className="deck-line">
                  <span className="deck-name">{deck.name}</span>
                  <span className="deck-meta">
                    {isDeck && <span className="deck-format">{formatLabel(deck.format ?? 'casual')}</span>}
                    <ManaCost
                      cost={colors.length > 0 ? colors.map((c) => `{${c}}`).join('') : '{C}'}
                      className="deck-colors"
                    />
                    {isDeck ? (
                      <span className="badge" title={`${main} mainboard · ${side} sideboard`}>
                        {main} / {side}
                      </span>
                    ) : (
                      <span className="badge" title={`${main} card${main === 1 ? '' : 's'} filed here`}>
                        {main} card{main === 1 ? '' : 's'}
                      </span>
                    )}
                    {/* What you own in here, not what the list would cost to build. */}
                    {ownText && (
                      <span
                        className="badge badge-value"
                        title={
                          missText
                            ? `${ownText} owned · ${missText} more in cards you don't own`
                            : `${ownText} owned — everything here is in your collection`
                        }
                      >
                        {ownText}
                      </span>
                    )}
                  </span>
                </span>
                <span className="menu-chevron" aria-hidden>
                  ›
                </span>
              </Link>
            </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
