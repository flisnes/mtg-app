// Generator: build the third-party notices shown at About -> Open source
// licenses. MIT, BSD and Apache-2.0 all require the copyright notice and
// licence text to travel with a distribution, and serving the PWA is a
// distribution, so the app has to carry them. Apache-2.0 section 4(d) also
// requires any dependency NOTICE file be reproduced (Dexie ships one).
//
// Scope is the client's *runtime* dependency closure: the `dependencies` of
// client/package.json, transitively. devDependencies are build tools that
// never reach a user, so they are out. Licence texts are copied verbatim off
// disk from each package, never hand-written.
//
// Run `node scripts/gen-licenses.mjs` after adding or bumping a runtime
// dependency. Output: src/licenses.ts.
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');
const repoRoot = join(clientRoot, '..');

/** Walk up node_modules the way Node resolution does. */
function resolvePkg(name, fromDir) {
  let d = fromDir;
  for (;;) {
    const p = join(d, 'node_modules', name, 'package.json');
    if (existsSync(p)) return { dir: join(d, 'node_modules', name), json: JSON.parse(readFileSync(p, 'utf8')) };
    const up = join(d, '..');
    if (up === d) return null;
    d = up;
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const NOTICE_FILE = /^notice(\.(md|txt))?$/i;

function readMatching(dir, re) {
  const hit = readdirSync(dir).find((f) => re.test(f));
  return hit ? readFileSync(join(dir, hit), 'utf8').trim() : null;
}

// Pull the copyright line out of a licence text so each package can be
// credited even when several share one canonical text.
function copyrightOf(text) {
  if (!text) return null;
  const m = text.match(/^.*\bcopyright\b.*$/im);
  if (!m) return null;
  const line = m[0].trim().replace(/^[*#\s]+/, '');
  // The Apache-2.0 boilerplate has a "Copyright [yyyy] [name]" placeholder in
  // its appendix; that is not an attribution.
  return /\[yyyy\]|\[name of copyright owner\]/i.test(line) ? null : line;
}

const pkgs = new Map();
function walk(name, fromDir) {
  if (pkgs.has(name) || name.startsWith('@mtg/')) return;
  const r = resolvePkg(name, fromDir);
  if (!r) throw new Error(`gen-licenses: cannot resolve ${name} from ${fromDir} (run npm install)`);
  const licenseText = readMatching(r.dir, LICENSE_FILE);
  const spdx = r.json.license ?? (Array.isArray(r.json.licenses) ? r.json.licenses.map((l) => l.type).join(' OR ') : null);
  if (!spdx) throw new Error(`gen-licenses: ${name} declares no license`);
  pkgs.set(name, {
    name,
    version: r.json.version,
    spdx,
    copyright: copyrightOf(licenseText),
    text: licenseText,
    notice: readMatching(r.dir, NOTICE_FILE),
  });
  for (const dep of Object.keys(r.json.dependencies ?? {})) walk(dep, r.dir);
}

const client = JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8'));
for (const dep of Object.keys(client.dependencies)) walk(dep, clientRoot);
// workbox-window reaches the bundle through vite-plugin-pwa's virtual
// `register` module, so it is a runtime dependency in practice while being
// declared under the plugin.
walk('workbox-window', clientRoot);

// The two icon fonts are vendored under src/vendor rather than installed, and
// neither carries licence metadata inside the font file (both are IcoMoon
// builds whose name table holds only the designer). So they are credited from
// here. Their upstream packages are devDependencies used only to regenerate
// the vendored copies; what ships is the font binary plus our own CSS.
const FONTS = [
  {
    name: 'Keyrune (font)',
    version: JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'keyrune', 'package.json'), 'utf8')).version,
    spdx: 'OFL-1.1',
    copyright: 'Copyright (c) 2019 Andrew Gioia',
    url: 'https://keyrune.andrewgioia.com',
    note: 'Set symbol glyphs. Only the prepared font file (OFL-1.1) is redistributed; Keyrune’s GPL-3.0 stylesheet is not.',
  },
  {
    name: 'Mana (font)',
    version: JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'mana-font', 'package.json'), 'utf8')).version,
    spdx: 'OFL-1.1',
    copyright: 'Copyright (c) Andrew Gioia',
    url: 'https://mana.andrewgioia.com',
    note: 'Mana and ability symbol glyphs. The font file is OFL-1.1; the stylesheet that maps symbols to glyphs is our own.',
  },
];

// One canonical text per licence, taken from whichever package carries the
// longest copy (the fullest boilerplate). Packages then reference it by SPDX
// id, which keeps eleven near-identical MIT texts out of the bundle. A local
// file under client/licenses/<spdx>.txt wins, for licences no dependency
// ships a copy of (OFL-1.1).
const texts = new Map();
for (const p of pkgs.values()) {
  if (!p.text) continue;
  const cur = texts.get(p.spdx);
  if (!cur || p.text.length > cur.length) texts.set(p.spdx, p.text);
}
const localDir = join(clientRoot, 'licenses');
if (existsSync(localDir)) {
  for (const f of readdirSync(localDir)) {
    if (f.endsWith('.txt')) texts.set(f.replace(/\.txt$/, ''), readFileSync(join(localDir, f), 'utf8').trim());
  }
}

const entries = [
  ...[...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ...FONTS,
].map((p) => ({
  name: p.name,
  version: p.version,
  spdx: p.spdx,
  copyright: p.copyright ?? null,
  url: p.url ?? null,
  note: p.note ?? null,
  notice: p.notice ?? null,
}));

const missing = [...new Set(entries.map((e) => e.spdx))].filter((s) => !texts.has(s));

const out = `// GENERATED by scripts/gen-licenses.mjs. Do not edit by hand.
// Third-party notices for everything in the client's runtime dependency
// closure, plus the two vendored icon fonts. Regenerate after adding or
// bumping a runtime dependency. Rendered by routes/Licenses.tsx, which the
// About page loads on demand so these texts stay out of the main bundle.

export interface LicenseEntry {
  name: string;
  version: string;
  /** SPDX identifier; keys into LICENSE_TEXTS. */
  spdx: string;
  /** Copyright line lifted from the package's own licence file. */
  copyright: string | null;
  url: string | null;
  note: string | null;
  /** Verbatim NOTICE file contents, which Apache-2.0 4(d) requires we carry. */
  notice: string | null;
}

export const LICENSES: LicenseEntry[] = ${JSON.stringify(entries, null, 2)};

/** Full licence texts, one per SPDX id, copied verbatim from the packages. */
export const LICENSE_TEXTS: Record<string, string> = ${JSON.stringify(Object.fromEntries(texts), null, 2)};
`;

writeFileSync(join(clientRoot, 'src', 'licenses.ts'), out);
console.log(`gen-licenses: ${entries.length} entries, ${texts.size} licence texts -> src/licenses.ts`);
if (missing.length) console.warn(`gen-licenses: WARNING no text on disk for ${missing.join(', ')} (add client/licenses/<spdx>.txt)`);
