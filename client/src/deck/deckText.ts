// Deck text export (beta plan §5). Deck *import* now shares the collection
// importer's parse → resolve → review pipeline (see client/src/import/); this
// file only builds the plain-text/MTGA representation for export.

export function buildDeckText(
  main: Array<{ name: string; quantity: number }>,
  side: Array<{ name: string; quantity: number }>,
  commander: Array<{ name: string; quantity: number }> = [],
): string {
  const lines: string[] = [];
  if (commander.length) {
    lines.push('Commander', ...commander.map((c) => `${c.quantity} ${c.name}`), '');
  }
  lines.push('Deck', ...main.map((c) => `${c.quantity} ${c.name}`));
  if (side.length) {
    lines.push('', 'Sideboard', ...side.map((c) => `${c.quantity} ${c.name}`));
  }
  return lines.join('\n') + '\n';
}
