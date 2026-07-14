// Renders a Magic mana-cost / symbol string (e.g. "{2}{W}{U}", "{T}", "{W/P}")
// as pip icons from the bundled Mana icon font (see src/vendor/mana). Scryfall
// wraps every symbol in braces; we map the inside of each brace to a Mana font
// class and draw it as a round "cost" pip. Unrecognised tokens fall back to
// their literal braced text so nothing silently disappears.

// A few Scryfall tokens don't match their Mana font class name directly.
const ALIAS: Record<string, string> = {
  t: 'tap',
  q: 'untap',
  '∞': 'infinity',
};

// Map a braced token's contents (e.g. "W", "2", "W/U", "2/W", "G/U/P") to a
// Mana font symbol class, or null when we don't recognise it.
function symbolClass(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (ALIAS[key]) return ALIAS[key];
  // Hybrid/phyrexian tokens drop their slashes: "w/u" -> "wu", "g/u/p" -> "gup".
  const cls = key.replace(/\//g, '');
  return /^[0-9wubrgcpxyzse]+$/.test(cls) ? cls : null;
}

/** Split a string into its brace tokens and the plain text between them. */
function tokenize(text: string): Array<{ sym: string | null; raw: string }> {
  const out: Array<{ sym: string | null; raw: string }> = [];
  const re = /\{([^}]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ sym: null, raw: text.slice(last, m.index) });
    out.push({ sym: symbolClass(m[1] ?? ''), raw: m[0] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ sym: null, raw: text.slice(last) });
  return out;
}

export function ManaCost({ cost, className }: { cost: string; className?: string }) {
  const parts = tokenize(cost);
  return (
    <span className={`mana-cost${className ? ` ${className}` : ''}`} role="img" aria-label={cost}>
      {parts.map((p, i) =>
        p.sym ? (
          <i key={i} className={`ms ms-${p.sym} ms-cost`} aria-hidden />
        ) : (
          <span key={i}>{p.raw}</span>
        ),
      )}
    </span>
  );
}
