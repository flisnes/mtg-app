// Generator: extract the symbol -> font-codepoint map from the Mana font's CSS
// as functional data and emit a clean, self-authored stylesheet that bundles
// ONLY the woff2 font. The Mana font (by Andrew Gioia) is MIT-licensed, so we
// could ship its CSS verbatim; we regenerate a trimmed sheet anyway to mirror
// the Keyrune setup, drop unused icons/formats, and control the pip styling.
// Run `node scripts/gen-mana.mjs` after updating the `mana-font` dependency.
// Output: src/vendor/mana/{mana.css,mana.woff2}.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');
const pkgDir = join(clientRoot, '..', 'node_modules', 'mana-font');

const src = readFileSync(join(pkgDir, 'css', 'mana.css'), 'utf8');
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;

// Extract every glyph-mapping rule: a selector list whose block is nothing but
// a single `content: "\xxxx"` (hex codepoint). This grabs the mono/generic/X
// symbols AND the composite ::before/::after halves that build hybrid pips,
// while skipping structural rules (which carry extra declarations) and the
// loyalty text rules (whose content is a literal number, not a codepoint).
const re = /([^{}]+)\{\s*content:\s*"\\([0-9a-fA-F]+)"\s*;?\s*\}/g;
const contentRules = [];
let m;
while ((m = re.exec(src))) {
  const selector = m[1].trim().replace(/\s*,\s*/g, ',');
  contentRules.push(`${selector}{content:"\\${m[2].toLowerCase()}"}`);
}

const outDir = join(clientRoot, 'src', 'vendor', 'mana');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(pkgDir, 'fonts', 'mana.woff2'), join(outDir, 'mana.woff2'));

// Hand-authored styling wrapper. The colour values and hybrid split geometry
// are lifted from the Mana font's own stylesheet (MIT, Copyright Andrew Gioia).
const SPLIT = [
  ['wu', 'w', 'u'], ['wb', 'w', 'b'], ['ub', 'u', 'b'], ['ur', 'u', 'r'],
  ['br', 'b', 'r'], ['bg', 'b', 'g'], ['rw', 'r', 'w'], ['rg', 'r', 'g'],
  ['gw', 'g', 'w'], ['gu', 'g', 'u'],
  ['2w', 'c', 'w'], ['2u', 'c', 'u'], ['2b', 'c', 'b'], ['2r', 'c', 'r'], ['2g', 'c', 'g'],
  ['cw', 'c', 'w'], ['cu', 'c', 'u'], ['cb', 'c', 'b'], ['cr', 'c', 'r'], ['cg', 'c', 'g'],
  ['wup', 'w', 'u'], ['wbp', 'w', 'b'], ['ubp', 'u', 'b'], ['urp', 'u', 'r'],
  ['brp', 'b', 'r'], ['bgp', 'b', 'g'], ['rwp', 'r', 'w'], ['rgp', 'r', 'g'],
  ['gwp', 'g', 'w'], ['gup', 'g', 'u'],
];
const splitSel = SPLIT.map((s) => `.ms-cost.ms-${s[0]}`).join(',');
const splitBefore = SPLIT.map((s) => `.ms-cost.ms-${s[0]}::before`).join(',');
const splitAfter = SPLIT.map((s) => `.ms-cost.ms-${s[0]}::after`).join(',');
const splitBoth = SPLIT.flatMap((s) => [`.ms-cost.ms-${s[0]}::before`, `.ms-cost.ms-${s[0]}::after`]).join(',');
const splitVars = SPLIT
  .map((s) => `.ms-cost.ms-${s[0]}{--ms-split-top:var(--ms-mana-${s[1]});--ms-split-bottom:var(--ms-mana-${s[2]})}`)
  .join('\n');
// Phyrexian pips (mono + hybrid) nudge their small "Φ" glyph.
const phyrexianSel = ['wp', 'up', 'bp', 'rp', 'gp', ...SPLIT.filter((s) => s[0].endsWith('p')).map((s) => s[0])]
  .map((c) => `.ms-cost.ms-${c}::before`)
  .join(',');

const css = `/* Magic mana & ability symbols — the Mana icon font (v${version}).
 *
 * Bundled font: mana.woff2, by Andrew Gioia, MIT-licensed. The symbol ->
 * glyph-codepoint table below is functional data mechanically extracted from
 * the project; the pip styling is authored here rather than shipping the
 * font's full CSS (unused icons, legacy font formats, the MPlantin text face).
 * Regenerate with client/scripts/gen-mana.mjs after updating the dependency.
 * Project: https://mana.andrewgioia.com */
@font-face {
  font-family: 'Mana';
  src: url('./mana.woff2') format('woff2');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
.ms {
  display: inline-block;
  font: normal normal normal 1em/1 Mana;
  font-size: inherit;
  line-height: 1em;
  text-rendering: auto;
  vertical-align: middle;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  --ms-mana-b: #a7999e;
  --ms-mana-c: #d0c6bb;
  --ms-mana-g: #9fcba6;
  --ms-mana-r: #f19b79;
  --ms-mana-u: #bcdaf7;
  --ms-mana-w: #fdfbce;
}

/* --- glyph codepoint map (extracted) --- */
${contentRules.join('\n')}

/* --- round "cost" pips (authored) --- */
.ms-cost {
  background-color: #beb9b2;
  border-radius: 1em;
  color: #111;
  font-size: 0.95em;
  width: 1.3em;
  height: 1.3em;
  line-height: 1.35em;
  text-align: center;
}
.ms-cost.ms-w, .ms-cost.ms-wp { background-color: #f0f2c0; }
.ms-cost.ms-u, .ms-cost.ms-up { background-color: #b5cde3; }
.ms-cost.ms-b, .ms-cost.ms-bp { background-color: #aca29a; }
.ms-cost.ms-r, .ms-cost.ms-rp { background-color: #db8664; }
.ms-cost.ms-g, .ms-cost.ms-gp { background-color: #93b483; }

/* two-tone (hybrid, twobrid, colorless-hybrid, phyrexian-hybrid) pips */
${splitSel} {
  position: relative;
  width: 1.3em;
  height: 1.3em;
  background: linear-gradient(135deg, var(--ms-split-top) 0%, var(--ms-split-top) 50%, var(--ms-split-bottom) 50%, var(--ms-split-bottom) 100%);
}
${splitBoth} { font-size: 0.55em !important; position: absolute; }
${splitBefore} { top: -0.38em; left: 0.28em; }
${splitAfter} { top: 0.5em; left: 1em; }
${splitVars}

/* phyrexian mark scaling */
.ms-cost.ms-p::before { display: inline-block; transform: scale(1.2, 1.2); }
${phyrexianSel} { display: inline-block; transform: scale(1.2) translateX(0.01rem) translateY(-0.03rem); }

/* snow, untap */
.ms-cost.ms-untap { background-color: #111; color: #fff; }
`;
writeFileSync(join(outDir, 'mana.css'), css);
console.log(`gen-mana: ${contentRules.length} glyph rules -> src/vendor/mana/mana.css (font v${version})`);
