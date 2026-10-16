import { useState } from 'react';
import { isMarkerCard, type OracleCard, type Priced } from '@mtg/shared';
import { addDeckCard } from '../../db/dataAccess.js';
import { useOwnershipIndex } from '../../db/useOwnership.js';
import { CardItems, type CardItem, type ViewMode } from '../../components/CardViews.js';
import { tokenLabel } from '../../components/ContainerBoard.js';
import { ownedBadge } from '../../components/OwnedBadge.js';
import { Icon } from '../../components/icons.js';
import { useAsyncAction } from '../../components/useAsyncAction.js';

/**
 * Extra cardboard the deck's own cards call for (Scryfall's `all_parts`) that
 * isn't in the token board yet: tokens they make — The Necrobloom suggesting its
 * Plant and Zombie — plus the marker cards they reference, so a Skithiryx deck
 * gets its Poison Counter and a Sefris deck the three dungeons it can venture
 * into. One tap files it into the token board at quantity 1; the badge shows
 * whether a copy is already sitting in the collection, same as any other card.
 */
export function TokenSuggestions({ deckId, view, tokens }: { deckId: string; view: ViewMode; tokens: Priced<OracleCard>[] }) {
  const action = useAsyncAction();
  const ownership = useOwnershipIndex();
  const [adding, setAdding] = useState<Set<string>>(new Set());

  async function add(oracleId: string) {
    setAdding((s) => new Set(s).add(oracleId));
    await addDeckCard({ deckId, oracleId, board: 'token', quantity: 1 });
  }

  const items: CardItem[] = tokens.map((o) => {
    const marker = isMarkerCard(o.name, o.typeLine);
    const noun = marker ? 'card' : 'token';
    const own = ownedBadge(ownership?.lookup(o.oracleId), 13, {
      yes: `you own a copy of this ${noun}`,
      no: `you don't own this ${noun} yet`,
    });
    return {
      key: o.oracleId,
      name: tokenLabel(o),
      image: o.imageSmall,
      badge: own?.icon,
      badgeClass: own?.cls,
      badgeTitle: own?.title,
      sub: marker ? 'needed by a card in this deck' : 'made by a card in this deck',
      actions: (
        <button
          className="ghost icon-only"
          disabled={adding.has(o.oracleId)}
          onClick={() => action.run('add the card', () => add(o.oracleId))}
          aria-label={`Add ${tokenLabel(o)} to tokens`}
          title="Add to tokens"
        >
          <Icon name="plus" size={16} />
        </button>
      ),
    };
  });

  return (
    <div className="about-section">
      <h2>
        Suggested tokens <span className="badge">{tokens.length}</span>
      </h2>
      <p className="fine-print">Made or needed by cards in this deck. Doesn’t count toward your deck size.</p>
      <CardItems view={view} items={items} />
    </div>
  );
}
