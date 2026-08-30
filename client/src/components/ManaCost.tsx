// Renders Magic mana / ability symbols from the bundled Mana icon font (see
// src/vendor/mana). Scryfall wraps every symbol in braces ("{2}{W}", "{T}",
// "{W/P}"); we map the inside of each brace to a Mana font class and draw it as
// a round "cost" pip. Unrecognised tokens fall back to their literal braced
// text so nothing silently disappears.
//
// `ManaCost` renders a single mana-cost line (announced as a whole); `SymbolText`
// renders multi-line rules text with pips flowing inline among the words.

// A few Scryfall tokens don't match their Mana font class name directly.
// A bare {P} is Bloomburrow's paw print (the "Season of ..." modes), not
// Phyrexian mana -- Phyrexian is always coloured on real cards ({W/P}, {G/P}).
const ALIAS: Record<string, string> = {
  t: 'tap',
  q: 'untap',
  p: 'paw',
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

// `at` is the part's start offset in the string handed to tokenize. Text parts
// carry it into the DOM (data-oracle-off) so a selection can be mapped back to
// the raw rules text -- see oracleSelection.ts.
type Part = { sym: string; label: string } | { text: string; at: number };

/** Split a string into brace tokens (mapped to pips) and the plain text between them. */
function tokenize(text: string): Part[] {
  const out: Part[] = [];
  const re = /\{([^}]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), at: last });
    const inner = m[1] ?? '';
    const cls = symbolClass(inner);
    out.push(cls ? { sym: cls, label: inner } : { text: m[0], at: m.index });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), at: last });
  return out;
}

export function ManaCost({ cost, className }: { cost: string; className?: string }) {
  const parts = tokenize(cost);
  return (
    <span className={`mana-cost${className ? ` ${className}` : ''}`} role="img" aria-label={cost}>
      {parts.map((p, i) =>
        'sym' in p ? (
          <i key={i} className={`ms ms-${p.sym} ms-cost`} aria-hidden />
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}

export function SymbolText({ text, className }: { text: string; className?: string }) {
  // Oracle text separates abilities with newlines; render each as its own line.
  // Each line remembers where it began in `text`, so every text span can stamp
  // its absolute offset: pips render as empty <i> elements, and a selection read
  // back as a string would silently drop them ("{T}: Add {G}" -> ": Add "). With
  // the offsets, a reader slices the original string instead. See
  // oracleSelection.ts.
  let lineStart = 0;
  return (
    <div className={`symbol-text${className ? ` ${className}` : ''}`} data-oracle-root="">
      {text.split('\n').map((line, li) => {
        const start = lineStart;
        lineStart += line.length + 1; // + the newline split() ate
        return (
          <p key={li}>
            {tokenize(line).map((p, i) =>
              'sym' in p ? (
                <i key={i} className={`ms ms-${p.sym} ms-cost`} role="img" aria-label={p.label} />
              ) : (
                <span key={i} data-oracle-off={start + p.at}>
                  {p.text}
                </span>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}
