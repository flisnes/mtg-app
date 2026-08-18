import type { DeckBoard, OracleCard } from '@mtg/shared';
import { canJoinCommandZone, isNonDeckCard } from './legality.js';

// A deck's zones, and the one set of rules for moving a slot between them.
// Both the card sheet's zone picker and the multi-select "Move to…" read this,
// so a card that can't be your commander is refused the same way, with the same
// wording, wherever you try it from.

/** Zone names for headings, buttons and pickers. */
export const BOARD_LABEL: Record<DeckBoard, string> = {
  main: 'Mainboard',
  side: 'Sideboard',
  commander: 'Command zone',
  token: 'Tokens',
};

/** Every zone a deck has, in the order they're shown. */
export const BOARD_ORDER: readonly DeckBoard[] = ['main', 'side', 'commander', 'token'];

/** One zone as a picker offers it: named, and either open or refused out loud. */
export interface BoardOption {
  board: DeckBoard;
  label: string;
  /** Why it can't be picked, for the disabled title. Absent = it can. */
  refusal?: string;
}

/**
 * The zones a selection of cards may move to, minus the zone they're already
 * in. Cards are passed with the oracle rows so legality can be checked; a card
 * whose oracle row is missing (card DB skew) is treated as an ordinary card.
 *
 * The rules are the ones the add flow already enforces:
 *  - Tokens, emblems and art cards only ever belong in the token zone, and
 *    nothing else does (see isNonDeckCard).
 *  - The command zone exists only in a commander deck, holds two cards at most,
 *    and only cards that may legally sit there together (canJoinCommandZone).
 */
export function boardOptions({
  cards,
  commanderDeck,
  commandZone,
  from,
}: {
  /** The slots being moved: their oracle rows, one per slot. */
  cards: readonly (OracleCard | undefined)[];
  commanderDeck: boolean;
  /** Who is in the command zone already (excluding the slots being moved). */
  commandZone: readonly OracleCard[];
  /** The zone every slot is currently in, when they share one. */
  from?: DeckBoard;
}): BoardOption[] {
  const known = cards.filter((c): c is OracleCard => !!c);
  const tokens = known.filter(isNonDeckCard).length;
  const allTokens = known.length > 0 && tokens === known.length;
  const anyToken = tokens > 0;
  const one = cards.length === 1 ? known[0] : undefined;

  const out: BoardOption[] = [];
  for (const board of BOARD_ORDER) {
    if (board === 'commander' && !commanderDeck && from !== 'commander') continue;
    // The token zone stays hidden for a deck of ordinary cards: it's not a
    // zone you brew into, it's where the tokens the deck makes are kept.
    if (board === 'token' && !anyToken && from !== 'token') continue;
    let refusal: string | undefined;
    if (board === 'token' && !allTokens) {
      refusal = anyToken ? 'Only the tokens in the selection belong here' : 'Only tokens belong in the token zone';
    } else if (board !== 'token' && anyToken) {
      refusal = allTokens ? 'Tokens belong in the token zone' : 'The selection has tokens in it, which only belong in the token zone';
    } else if (board === 'commander') {
      if (cards.length > 1) refusal = 'The command zone holds one card at a time (two if they pair)';
      else if (!one || !canJoinCommandZone(one, commandZone)) {
        refusal = commandZone.length >= 2 ? 'The command zone is full' : 'This card can’t be a commander here';
      }
    }
    out.push({ board, label: BOARD_LABEL[board], ...(refusal ? { refusal } : {}) });
  }
  return out;
}
