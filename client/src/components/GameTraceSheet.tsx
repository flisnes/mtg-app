import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from './Sheet.js';
import { Icon } from './icons.js';
import { traceGame, type SimOptions } from '../analysis/simulate.js';
import type { SimCard, SimDeck } from '../analysis/simDeck.js';
import type { BoardPile, BoardState, GameTrace, TraceKind } from '../analysis/trace.js';

// One game, read start to finish.
//
// Everything else in the deck stats sheet is an average over twenty thousand
// games, and an average is either right or subtly wrong with no way to tell
// which from the number alone. This is the way to tell: the same sequencer,
// one game, every land drop and every tapped permanent written down.
//
// It exists to be argued with. If the policy plays a land you would not have
// played, that is worth knowing about the percentages upstairs — they were all
// produced by this.
//
// Two halves that answer each other. The text is the *story* of a turn, and a
// story is the one thing a list of card names cannot tell. The board pinned
// above it is the *position*, which is the thing you can check against your
// own table without reading a word — and the reason it is pinned rather than
// repeated under each turn is that scrolling the story is then the only
// control the sheet needs. Scroll down, the board plays forward.

/** A marker per line kind, so the shape of a turn reads before the words do. */
const MARK: Record<TraceKind, string> = {
  draw: '+',
  land: '▲',
  mana: '◆',
  cast: '▸',
  effect: '↳',
  note: '·',
};

/** The off-battlefield zones, which are a button each rather than a third row. */
type ZoneId = 'hand' | 'graveyard' | 'exile';
const ZONES: { id: ZoneId; label: string }[] = [
  { id: 'hand', label: 'Hand' },
  { id: 'graveyard', label: 'Graveyard' },
  { id: 'exile', label: 'Exile' },
];

/** How many deals to try for a game the focused card shows up in. One game is cheap. */
const FOCUS_TRIES = 40;

const randomSeed = () => (Math.random() * 0x7fffffff) | 0;

/** The names a trace line calls a card by: the full name, and a split card's front. */
function namesOf(card: SimCard | undefined): string[] {
  if (!card) return [];
  const front = card.name.split(' // ')[0]!;
  return front === card.name ? [card.name] : [card.name, front];
}

const mentions = (text: string, names: readonly string[]) => names.some((n) => text.includes(n));

/** Does the card do anything in this game, beyond sitting in the opener. */
function appearsIn(trace: GameTrace, names: readonly string[]): boolean {
  return trace.turns.some((t) => t.lines.some((l) => mentions(l.text, names)));
}

/**
 * A seed whose game has the card in it (rebuild plan C3). A one-of in a
 * ninety-nine is missing from most games, and watching eight turns of
 * somebody else's deck to find out the rule never fired is the wait this skips.
 * Gives up after a few dozen deals and shows the last one, which says so.
 */
function dealWith(deck: SimDeck, opts: SimOptions, names: readonly string[]): number {
  let seed = randomSeed();
  if (names.length === 0) return seed;
  for (let i = 0; i < FOCUS_TRIES; i++) {
    if (appearsIn(traceGame(deck, opts, seed), names)) return seed;
    seed = randomSeed();
  }
  return seed;
}

export function GameTraceSheet({
  deck,
  opts,
  focus = null,
  onClose,
}: {
  deck: SimDeck;
  opts: SimOptions;
  /** A card to pick out: its lines marked, the rest foldable, the deal chosen to include it. */
  focus?: string | null;
  onClose: () => void;
}) {
  const focusCard = focus ? deck.cards.find((c) => c.oracleId === focus) : undefined;
  const names = useMemo(() => namesOf(focusCard), [focusCard]);
  const [only, setOnly] = useState(true);
  // A fresh seed per deal. Not the simulation's own seed: that one is fixed so
  // the charts do not shuffle themselves every render, and a trace you cannot
  // re-deal is a trace that shows you one hand forever.
  const [seed, setSeed] = useState(() => dealWith(deck, opts, names));
  const trace = useMemo(() => traceGame(deck, opts, seed), [deck, opts, seed]);
  const filtering = names.length > 0 && only;
  const found = names.length === 0 || appearsIn(trace, names);
  // Which turn the board is showing: whichever one your reading has reached.
  const [at, setAt] = useState(1);
  const [zone, setZone] = useState<ZoneId | null>(null);
  const turnsRef = useRef<HTMLDivElement>(null);

  // A new deal is a new game, so the board goes back to turn one rather than
  // staying wherever the last game's scroll left it.
  useEffect(() => {
    setAt(1);
  }, [seed]);

  /**
   * The turn under the board, worked out from the scroll position of the sheet
   * itself rather than from an IntersectionObserver.
   *
   * The question is not "which turn is visible" — three of them are — it is
   * "which turn have you read down to", and that is one comparison against the
   * bottom edge of the pinned board. An observer answers the first question
   * and would have to be talked into answering the second with a rootMargin
   * nobody could later explain.
   */
  const follow = useCallback(() => {
    const wrap = turnsRef.current;
    const scroller = wrap?.closest('.sheet');
    if (!wrap || !scroller) return;
    const sections = wrap.querySelectorAll<HTMLElement>('.trace-turn');
    // At the bottom there is nothing left to scroll, so the last turn's header
    // may never climb past the board — and the last turn is the one nobody
    // would forgive the board for never showing. The end of the scroll is the
    // end of the game, and it says so.
    if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) {
      const last = sections[sections.length - 1];
      if (last) {
        setAt(Number(last.dataset.turn ?? 1));
        return;
      }
    }
    const board = scroller.querySelector('.trace-board');
    const line = (board?.getBoundingClientRect().bottom ?? scroller.getBoundingClientRect().top) + 4;
    let turn = 1;
    for (const section of sections) {
      if (section.getBoundingClientRect().top > line) break;
      turn = Number(section.dataset.turn ?? 1);
    }
    setAt(turn);
  }, []);

  useEffect(() => {
    const scroller = turnsRef.current?.closest('.sheet');
    if (!scroller) return;
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        follow();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    follow();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [follow, trace]);

  const shown = trace.turns.find((t) => t.turn === at) ?? trace.turns[0];
  const damage = trace.turns.reduce((sum, t) => (t.turn <= at ? sum + t.damage : sum), 0);

  return (
    <Sheet onClose={onClose} title="One game, played out" className="trace-sheet">
      <p className="fine-print">
        The same simulator behind every number on the analysis page, dealt once and written down. {opts.onPlay ? 'On the play' : 'On the draw'},
        seed {trace.seed}. Scroll the turns and the board plays forward with you.
      </p>

      {focusCard && (
        <div className="trace-focus">
          {found ? (
            <label className="trace-focus-toggle">
              <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} />
              <span>Only lines about {focusCard.name}</span>
            </label>
          ) : (
            <p className="fine-print">
              {focusCard.name} did nothing in {FOCUS_TRIES} deals in a row. It may be rarely drawn, or its rule may never get the
              chance to fire.
            </p>
          )}
        </div>
      )}

      {shown && (
        <div className="trace-board">
          <div className="trace-board-head">
            <span>Turn {at}</span>
            <span className="trace-board-numbers">
              {shown.spent} of {shown.available} mana{damage > 0 ? ` · ${damage} damage dealt` : ''}
            </span>
          </div>
          <BoardRow cards={deck.cards} piles={shown.board.permanents} empty="No permanents out" />
          <BoardRow cards={deck.cards} piles={shown.board.lands} treasures={shown.board.treasures} empty="No lands out" />
          <div className="seg-row trace-zone-tabs" role="group" aria-label="Other zones">
            {ZONES.map((z) => {
              const piles = shown.board[z.id];
              const n = piles.reduce((sum, p) => sum + p.count, 0);
              return (
                <button
                  key={z.id}
                  type="button"
                  className={`seg${zone === z.id ? ' seg-active' : ''}`}
                  aria-pressed={zone === z.id}
                  onClick={() => setZone(zone === z.id ? null : z.id)}
                >
                  {z.label} {n}
                </button>
              );
            })}
          </div>
          {zone && <BoardRow cards={deck.cards} piles={shown.board[zone]} empty={`Nothing in ${zone}`} />}
        </div>
      )}

      <div className="trace-opener">
        <div className="trace-opener-head">
          Opening hand{trace.mulligans > 0 ? ` after ${trace.mulligans} mulligan${trace.mulligans === 1 ? '' : 's'}` : ''}
        </div>
        <div className="trace-cards">{trace.opener.join(', ')}</div>
        {trace.bottomed.length > 0 && <div className="trace-bottomed">Bottomed: {trace.bottomed.join(', ')}</div>}
      </div>

      <div ref={turnsRef}>
        {trace.turns.map((turn) => (
          <section className="trace-turn" key={turn.turn} data-turn={turn.turn}>
            <h4 className="trace-turn-head">
              <span>Turn {turn.turn}</span>
              <span className="trace-turn-mana">
                {turn.spent} of {turn.available} mana spent
                {turn.damage > 0 ? ` · ${turn.damage} damage` : ''}
              </span>
            </h4>
            <ol className="trace-lines">
              {turn.lines.map((line, i) => {
                const hit = names.length > 0 && mentions(line.text, names);
                if (filtering && found && !hit) return null;
                return (
                <li key={i} className={`trace-line trace-${line.kind}${hit ? ' trace-hit' : ''}`}>
                  <span className="trace-mark" aria-hidden="true">
                    {MARK[line.kind]}
                  </span>
                  <span>
                    {line.text}
                    {line.taps && (
                      <span className="trace-taps">
                        {line.taps.map((tap, t) => (
                          <span key={t} className="trace-tap">
                            {tap}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </li>
                );
              })}
            </ol>
            {!(filtering && found) && <p className="trace-hand">{handLine(deck.cards, turn.board)}</p>}
          </section>
        ))}
      </div>

      <button type="button" className="trace-again" onClick={() => setSeed(dealWith(deck, opts, names))}>
        <Icon name="refresh" />
        Deal another game
      </button>

      <p className="fine-print">
        A goldfish: nobody is across the table, nothing is countered and nothing dies. What a card does when it resolves is whatever
        the card database could read off its rules text, so a spell that does nothing here is either a spell that does nothing to your
        hand or one this model could not read. The coverage line under the charts says how many of each you have.
      </p>
    </Sheet>
  );
}

/** "Hand: Island, Ponder" — the text the board is there to be checked against. */
function handLine(cards: readonly SimCard[], board: BoardState): string {
  const names: string[] = [];
  for (const pile of board.hand) for (let i = 0; i < pile.count; i++) names.push(cards[pile.card]?.name ?? '?');
  return `Hand: ${names.length > 0 ? names.join(', ') : 'empty'}`;
}

/**
 * One row of the board: permanents above, lands below, or whichever zone the
 * buttons have open.
 *
 * It scrolls sideways rather than wrapping. A turn-eight battlefield is twenty
 * piles wide and wrapping it would push the story off the screen entirely,
 * which is the one thing the pinned board must not do.
 */
function BoardRow({
  cards,
  piles,
  treasures = 0,
  empty,
}: {
  cards: readonly SimCard[];
  piles: readonly BoardPile[];
  /** Treasure tokens, which belong on the land row and are nobody's card. */
  treasures?: number;
  empty: string;
}) {
  if (piles.length === 0 && treasures === 0) return <div className="trace-row trace-row-empty">{empty}</div>;
  return (
    <div className="trace-row">
      {piles.map((pile) => {
        const card = cards[pile.card];
        return <Pile key={pile.card} name={card?.name ?? 'Unknown card'} image={card?.image ?? null} count={pile.count} />;
      })}
      {treasures > 0 && <Pile name="Treasure" image={null} count={treasures} token />}
    </div>
  );
}

/** One stack of one card. Four Islands are this with a 4 on it. */
function Pile({ name, image, count, token }: { name: string; image: string | null; count: number; token?: boolean }) {
  return (
    <div className={`trace-pile${count > 1 ? ' trace-pile-many' : ''}${token ? ' trace-pile-token' : ''}`} title={name}>
      {image ? (
        <img src={image} alt={name} loading="lazy" decoding="async" />
      ) : (
        <span className="trace-pile-name">{name}</span>
      )}
      {count > 1 && <span className="trace-pile-count">{count}</span>}
    </div>
  );
}
