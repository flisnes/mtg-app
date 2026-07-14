// Generator: extract the set-code -> font-codepoint map from Keyrune's (GPL-3.0)
// CSS as functional data and emit a clean, self-authored stylesheet that bundles
// ONLY the OFL-1.1 woff2 font. We deliberately do NOT redistribute Keyrune's CSS.
// Run `node scripts/gen-keyrune.mjs` after updating the `keyrune` dependency to
// pick up newly-released sets. Output: src/vendor/keyrune/{keyrune.css,keyrune.woff2}.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');
const pkgDir = join(clientRoot, '..', 'node_modules', 'keyrune');

const src = readFileSync(join(pkgDir, 'css', 'keyrune.css'), 'utf8');

// Match `.ss-<code>:before { content: "\eXXX"; }` (single or double colon).
const re = /\.ss-([a-z0-9]+)::?before\s*\{\s*content:\s*"\\([0-9a-fA-F]+)"/g;
const map = new Map();
let m;
while ((m = re.exec(src))) {
  const [, code, cp] = m;
  if (!map.has(code)) map.set(code, cp.toLowerCase());
}

const outDir = join(clientRoot, 'src', 'vendor', 'keyrune');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(pkgDir, 'fonts', 'keyrune.woff2'), join(outDir, 'keyrune.woff2'));

const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
const rules = [...map.entries()]
  .map(([code, cp]) => `.ss-${code}::before{content:"\\${cp}"}`)
  .join('\n');

const css = `/* Magic set symbols — the Keyrune icon font (v${version}).
 *
 * Bundled font: keyrune.woff2, licensed SIL OFL-1.1 (Copyright Andrew Gioia),
 * which "controls all uses and applications" of the prepared font files.
 * The set-code -> glyph-codepoint table below is functional data mechanically
 * extracted from the project; Keyrune's own (GPL-3.0) CSS is NOT redistributed.
 * Regenerate with client/scripts/gen-keyrune.mjs after updating the dependency.
 * Project: https://keyrune.andrewgioia.com */
@font-face {
  font-family: 'Keyrune';
  src: url('./keyrune.woff2') format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
.ss {
  display: inline-block;
  font: normal normal normal 1em/1 Keyrune;
  line-height: 1em;
  vertical-align: -0.06em;
  text-rendering: auto;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
/* Fallback glyph (generic set icon) for codes not in the bundled font. */
.ss::before { content: "\\e684"; }
${rules}
`;
writeFileSync(join(outDir, 'keyrune.css'), css);
console.log(`gen-keyrune: ${map.size} set symbols -> src/vendor/keyrune/keyrune.css (font v${version})`);
