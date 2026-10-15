import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { COLORS, holdsCopy, normalizeColors, type Color, type Deck, type DeckCard, type OracleCard } from '@mtg/shared';
import { getOracleCardsByIds } from '../db/queries.js';
import { useContainers } from '../db/collectionSnapshot.js';
import { needsColorChoice } from './legality.js';
import { containerKind } from './containers.js';
import { deckSize } from './boards.js';
import { sumQty } from '../util/groupBy.js';

// The one-line summary a deck list shows per row: how big it is, what colours
// it is, how many copies it holds. The Decks page and the profile's favorite
// deck picker both show it, off the snapshot's slots and one oracle lookup for
// every deck in view (not one per deck).

type SummaryOracle = Pick<OracleCard, 'colors' | 'colorIdentity'> & Parameters<typeof needsColorChoice>[0];

/** Sideboard size. */
function sideSize(cards: DeckCard[]): number {
  return sumQty(cards.filter((c) => c.board === 'side'));
}

/**
 * A deck's colours: the union of every card's colour identity (for a legal
 * commander deck that collapses to the commander's identity). Tokens and
 * Considering don't vote: a mono-white deck making a black-and-white cleric is
 * still mono-white. A choose-a-color commander is the color it chose.
 */
export function deckColors(cards: DeckCard[], oracles: Map<string, SummaryOracle>): Color[] {
  const present = new Set<Color>();
  for (const card of cards) {
    if (card.board === 'token' || card.board === 'maybe') continue;
    const o = oracles.get(card.oracleId);
    for (const c of o?.colorIdentity ?? []) present.add(c);
    if (card.board === 'commander' && card.chosenColor && o && needsColorChoice(o)) present.add(card.chosenColor);
  }
  return COLORS.filter((c) => present.has(c));
}

/** Share of a container's coloured cards a colour needs before it earns a pip. */
const DOMINANT_SHARE = 0.1;

/**
 * Colours that actually characterise a binder or box, weighted by copies.
 *
 * Not the colour-identity union a deck gets: identity counts every mana symbol
 * on the card (Ana Battlemage is a green creature with a {U}{B} kicker), so
 * four strays in an 800-card box lit up all five pips and a shelf of sorted
 * boxes all looked the same. Printed colours, and only the ones pulling their
 * weight. Colourless cards and lands abstain rather than voting for nothing:
 * a box with no coloured cards falls back to {C}.
 */
export function dominantColors(
  cards: { oracleId: string; quantity: number }[],
  oracles: Map<string, { colors: Color[] }>,
): Color[] {
  const tally = new Map<Color, number>();
  let colored = 0;
  for (const card of cards) {
    const cardColors = normalizeColors(oracles.get(card.oracleId)?.colors);
    if (cardColors.length === 0) continue;
    colored += card.quantity;
    for (const c of cardColors) tally.set(c, (tally.get(c) ?? 0) + card.quantity);
  }
  // A multicolour card votes in every one of its colours, so the leading colour
  // always clears 1/5 of the pile: this never comes back empty.
  return COLORS.filter((c) => (tally.get(c) ?? 0) >= colored * DOMINANT_SHARE);
}

/** Copies the container is actually holding (fully specified, not unfiled). */
export function filedCount(cards: DeckCard[]): number {
  return sumQty(cards.filter(holdsCopy));
}

export interface DeckSummary {
  deck: Deck;
  main: number;
  side: number;
  colors: Color[];
  filed: number;
}

/**
 * Summaries for these containers, in the order given. `decks` should be
 * memoized: the oracle lookup re-runs when the set of cards in view changes.
 * Decks get identity colours, binders and boxes their dominant printed ones.
 */
export function useDeckSummaries(decks: Deck[] | undefined): DeckSummary[] | undefined {
  const { slots } = useContainers();
  const byDeck = useMemo(() => {
    if (!decks || !slots) return undefined;
    const ids = new Set(decks.map((d) => d.id));
    const map = new Map<string, DeckCard[]>();
    for (const c of slots) {
      if (!ids.has(c.deckId)) continue;
      const list = map.get(c.deckId);
      if (list) list.push(c);
      else map.set(c.deckId, [c]);
    }
    return map;
  }, [decks, slots]);
  // A live query, not a memo, so a card-DB update recolours the pips.
  const oracles = useLiveQuery(
    async () => (byDeck ? getOracleCardsByIds([...byDeck.values()].flat().map((c) => c.oracleId)) : undefined),
    [byDeck],
  );
  return useMemo(() => {
    if (!decks || !byDeck || !oracles) return undefined;
    return decks.map((deck) => {
      const cards = byDeck.get(deck.id) ?? [];
      const isDeck = containerKind(deck) === 'deck';
      return {
        deck,
        main: deckSize(cards),
        side: sideSize(cards),
        colors: isDeck ? deckColors(cards, oracles) : dominantColors(cards, oracles),
        filed: filedCount(cards),
      };
    });
  }, [decks, byDeck, oracles]);
}
