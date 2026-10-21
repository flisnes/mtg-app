// The named cards the ported rigs play with, read off a committed slice of a
// real pipeline build (rigCards.json) instead of a full card DB, so the suites
// run anywhere `npm test` does. Images, tags and legalities are stripped;
// everything the simulator reads (mana, effect and fetch profiles, produced
// colors, power and toughness, oracle text, layout) is as the pipeline wrote it.
//
// To add a card: put its name in the NAMES list of extractRigCards.mjs beside
// this file and rerun it against a fresh full build.
import { readFileSync } from 'node:fs';
import type { OracleCard } from '../../../shared/src/card.js';
import { namedTokenIds, sanitizeCardBehavior, type CardBehavior } from '../../../shared/src/behavior.js';
import { buildSimDeck, type DeckRow, type SimDeck } from '../../src/simDeck.js';
import { defaultSimOptions, traceGame, type SimOptions } from '../../src/simulate.js';

const data = JSON.parse(readFileSync(new URL('./rigCards.json', import.meta.url), 'utf8')) as { cards: OracleCard[]; tokens: OracleCard[] };
const byName = new Map(data.cards.map((c) => [c.name, c]));
const tokenById = new Map(data.tokens.map((c) => [c.oracleId, c]));

export const card = (name: string): OracleCard => {
  const c = byName.get(name);
  if (!c) throw new Error(`rigCards.json has no ${name}; add it to the extraction list`);
  return c;
};
export const rows = (...xs: [number, string][]): DeckRow[] => xs.map(([quantity, name]) => ({ quantity, board: 'main', oracle: card(name) }));
export const cmd = (name: string): DeckRow => ({ quantity: 1, board: 'commander', oracle: card(name) });

/** A rule as the app would save it, and the proof that saving it twice is the same bytes. */
export const b = (x: unknown): CardBehavior => {
  const s = sanitizeCardBehavior(x);
  if (!s) throw new Error(`behavior did not survive: ${JSON.stringify(x)}`);
  if (JSON.stringify(sanitizeCardBehavior(s)) !== JSON.stringify(s)) throw new Error(`not stable: ${JSON.stringify(s)}`);
  return s;
};

/**
 * A deck with rules by card name. `withTokens` does what DeckAnalysis does:
 * every token card a rule names is loaded beside the deck, so an Overlord can
 * make its Everywhere.
 */
export const deckWith = (r: DeckRow[], m: Record<string, CardBehavior>, withTokens = true): SimDeck => {
  const map = new Map<string, CardBehavior>();
  for (const [name, beh] of Object.entries(m)) map.set(card(name).oracleId, beh);
  const tokens = new Map<string, OracleCard>();
  if (withTokens) for (const id of namedTokenIds(map.values())) if (tokenById.has(id)) tokens.set(id, tokenById.get(id)!);
  return buildSimDeck(r, map, undefined, undefined, tokens);
};

/** The rigs' shared options: 4,000 games, no mulligans, on the play, no table. */
export const rigOpts = (): SimOptions => ({ ...defaultSimOptions('commander', true), games: 4000, mulligan: false, opponents: 0 });

/** Every trace line of `games` seeded games, "T3 cast: Casts ...", one list per game. */
export const gamesLines = (deck: SimDeck, opts: SimOptions, games: number): string[][] => {
  const out: string[][] = [];
  for (let seed = 1; seed <= games; seed++) {
    const g = traceGame(deck, opts, seed);
    out.push(g.turns.flatMap((t) => t.lines.map((l) => `T${t.turn} ${l.kind}: ${l.text}`)));
  }
  return out;
};
export const count = (games: string[][], re: RegExp) => games.reduce((n, g) => n + g.filter((l) => re.test(l)).length, 0);
