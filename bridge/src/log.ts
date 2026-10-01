// stdout is the MCP transport — anything printed there corrupts the framing.
// Every line of bridge logging goes to stderr, no exceptions.

export function log(...parts: unknown[]): void {
  const line = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  process.stderr.write(`[mtg-bridge] ${line}\n`);
}
