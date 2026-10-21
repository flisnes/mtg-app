// The two snapshot formats: a game as text, a result as stable JSON.
import type { SimDeck } from '../../src/simDeck.js';
import type { BoardPile, GameTrace } from '../../src/trace.js';

/** Piles by name, "2 Forest, 1 Sol Ring", or "-" for an empty zone. */
const piles = (deck: SimDeck, zone: readonly BoardPile[]): string =>
  zone.length === 0 ? '-' : zone.map((p) => `${p.count} ${deck.cards[p.card]?.name ?? `#${p.card}`}`).join(', ');

/**
 * One traced game as text, every line and every tap, the board after each
 * turn. Written so a diff reads as a story: the turn a restructure changed
 * is the first line that differs.
 */
export function renderTrace(deck: SimDeck, g: GameTrace): string {
  const out: string[] = [];
  out.push(`=== seed ${g.seed} | mulligans ${g.mulligans} ===`);
  out.push(`opener: ${g.opener.join(', ') || '-'}`);
  if (g.bottomed.length) out.push(`bottomed: ${g.bottomed.join(', ')}`);
  for (const t of g.turns) {
    out.push(`--- turn ${t.turn} | available ${t.available} | spent ${t.spent} | damage ${t.damage}`);
    for (const l of t.lines) {
      out.push(`  ${l.kind.padEnd(6)} ${l.text}`);
      for (const tap of l.taps ?? []) out.push(`         > ${tap}`);
    }
    const b = t.board;
    out.push(`  board  lands: ${piles(deck, b.lands)}`);
    out.push(`         permanents: ${piles(deck, b.permanents)}${b.treasures ? ` | treasures: ${b.treasures}` : ''}`);
    out.push(`         hand: ${piles(deck, b.hand)}`);
    out.push(`         graveyard: ${piles(deck, b.graveyard)} | exile: ${piles(deck, b.exile)}`);
    if (b.opponents.length) out.push(`         opponents: ${b.opponents.join(' / ')}`);
  }
  return out.join('\n');
}

/**
 * JSON with one key per line and every list of numbers on one line, so a
 * result file is a few hundred readable lines rather than a few thousand of
 * one number each. Full double precision: byte-identical is the gate.
 */
export function stableJson(value: unknown, indent = ''): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => typeof v !== 'object' || v === null)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    const inner = indent + '  ';
    return `[\n${value.map((v) => inner + stableJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const inner = indent + '  ';
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stableJson(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
