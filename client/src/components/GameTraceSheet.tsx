import { useMemo, useState } from 'react';
import { Sheet } from './Sheet.js';
import { Icon } from './icons.js';
import { traceGame, type SimOptions } from '../analysis/simulate.js';
import type { SimDeck } from '../analysis/simDeck.js';
import type { TraceKind } from '../analysis/trace.js';

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

/** A marker per line kind, so the shape of a turn reads before the words do. */
const MARK: Record<TraceKind, string> = {
  draw: '+',
  land: '▲',
  mana: '◆',
  cast: '▸',
  effect: '↳',
  note: '·',
};

export function GameTraceSheet({
  deck,
  opts,
  onClose,
}: {
  deck: SimDeck;
  opts: SimOptions;
  onClose: () => void;
}) {
  // A fresh seed per deal. Not the simulation's own seed: that one is fixed so
  // the charts do not shuffle themselves every render, and a trace you cannot
  // re-deal is a trace that shows you one hand forever.
  const [seed, setSeed] = useState(() => (Math.random() * 0x7fffffff) | 0);
  const trace = useMemo(() => traceGame(deck, opts, seed), [deck, opts, seed]);

  return (
    <Sheet onClose={onClose} title="One game, played out" className="trace-sheet">
      <p className="fine-print">
        The same sequencer behind every number in this sheet, dealt once and written down. {opts.onPlay ? 'On the play' : 'On the draw'},
        seed {trace.seed}.
      </p>

      <div className="trace-opener">
        <div className="trace-opener-head">
          Opening hand{trace.mulligans > 0 ? ` after ${trace.mulligans} mulligan${trace.mulligans === 1 ? '' : 's'}` : ''}
        </div>
        <div className="trace-cards">{trace.opener.join(', ')}</div>
        {trace.bottomed.length > 0 && <div className="trace-bottomed">Bottomed: {trace.bottomed.join(', ')}</div>}
      </div>

      {trace.turns.map((turn) => (
        <section className="trace-turn" key={turn.turn}>
          <h4 className="trace-turn-head">
            <span>Turn {turn.turn}</span>
            <span className="trace-turn-mana">
              {turn.spent} of {turn.available} mana spent
            </span>
          </h4>
          <ol className="trace-lines">
            {turn.lines.map((line, i) => (
              <li key={i} className={`trace-line trace-${line.kind}`}>
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
            ))}
          </ol>
          <p className="trace-hand">Hand: {turn.hand.length > 0 ? turn.hand.join(', ') : 'empty'}</p>
        </section>
      ))}

      <button type="button" className="trace-again" onClick={() => setSeed((Math.random() * 0x7fffffff) | 0)}>
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
