// One game, written down.
//
// §11.3's last point, and the one that decides whether anybody believes the
// rest of this sheet: *"users will accept a stated policy they can watch. They
// will not accept a number from a policy they cannot inspect, and they should
// not."* Twenty thousand games average into a percentage that is either right
// or subtly, invisibly wrong, and there is no way to tell which from the
// number. One game you can read start to finish is how you tell.
//
// It runs the real `simulate()`, with `games: 1` and a trace sink attached, so
// what you read is the sequencer that produced the charts and not a second
// implementation that agrees with it until it doesn't. That is the whole design
// constraint here: no separate code path, ever.

/** What a line is about, which is all the UI needs to style it. */
export type TraceKind = 'draw' | 'land' | 'mana' | 'cast' | 'effect' | 'note';

export interface TraceLine {
  kind: TraceKind;
  text: string;
  /**
   * For a cast: one entry per permanent tapped, already written out as
   * "Island taps for {U}". Absent when the payment solver could not be asked
   * for an assignment, which the text says rather than hides.
   */
  taps?: string[];
}

export interface TraceTurn {
  turn: number;
  lines: TraceLine[];
  /** Mana on the battlefield this turn, Treasures made this turn included. */
  available: number;
  spent: number;
  /** Cards in hand at end of turn, by name, commander included. */
  hand: string[];
}

export interface GameTrace {
  /** The opener that was kept, after any bottoming. */
  opener: string[];
  /** How many hands were shipped before this one. */
  mulligans: number;
  /** Cards put on the bottom by the London mulligan. */
  bottomed: string[];
  turns: TraceTurn[];
  /** The seed this game was dealt from, so a surprising game can be dealt again. */
  seed: number;
}

/**
 * The sink `simulate()` writes into. Kept as a mutable object rather than a
 * callback so the hot loop's guard is one null check on a field it already
 * holds, instead of a closure call per event.
 */
export interface TraceSink {
  game: GameTrace;
  /** The turn being written, or null before turn one. */
  turn: TraceTurn | null;
}

export function newTraceSink(seed: number): TraceSink {
  return { game: { opener: [], mulligans: 0, bottomed: [], turns: [], seed }, turn: null };
}

export function say(sink: TraceSink, kind: TraceKind, text: string, taps?: string[]): void {
  const line: TraceLine = taps ? { kind, text, taps } : { kind, text };
  if (sink.turn) sink.turn.lines.push(line);
  // Before turn one there is nowhere to put a line but the opener, which has
  // its own fields. Anything else that early is a bug, and dropping it beats
  // inventing a turn zero to hold it.
}

/** `{U}{U}` from a pip's options, for a tap line to read the way a card does. */
export function pipText(options: readonly string[]): string {
  return options.length === 0 ? '{C}' : `{${options.join('/')}}`;
}
