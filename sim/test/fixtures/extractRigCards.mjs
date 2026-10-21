// Refresh rigCards.json from a full pipeline build: the named cards the
// ported rigs play with (e3, grants, dredge, floor, devotion) and the two
// token cards the pre-written rules name by oracle id.
//
//   BULK_TYPE=oracle_cards OUT_DIR=/tmp/pipeline-full npm run pipeline
//   node sim/test/fixtures/extractRigCards.mjs /tmp/pipeline-full
//
// Add a name to NAMES and rerun when a rig needs a card it does not have.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const DB = process.argv[2];
if (!DB) throw new Error('usage: node extractRigCards.mjs <pipeline OUT_DIR>');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'rigCards.json');

const NAMES = [
  // e3-sim
  'Wastes', 'Hill Giant', 'Ornithopter', 'Swamp', 'Blood Artist', 'Viscera Seer', 'Bitterblossom', 'Grizzly Bears', 'Mind Stone',
  'Colossal Dreadmaw', 'Mox Opal', 'War Room', 'Juggernaut', 'Forest', 'Exploration', 'Bala Ged Recovery // Bala Ged Sanctuary',
  // grants-sim
  'Counterspell', 'Overlord of the Hauntwoods', 'Wood Elves', 'Mole Man, Moloid Master', 'Mountain', 'Mulch', 'Lightning Bolt', 'Six', 'Harmonize',
  // dredge-sim
  'Golgari Grave-Troll', 'Life from the Loam', 'Dakmor Salvage', 'Trash Panda', 'The Necrobloom', 'Faithless Looting', 'Plains',
  // floor-sim
  'Erebos, God of the Dead', 'Phyrexian Obliterator', 'Wall of Omens',
  // devotion-sim
  'Gray Merchant of Asphodel', 'Kitchen Finks', 'Watchwolf', 'Birthing Pod', 'Reaper King', 'Field of the Dead', 'Island', 'Command Tower',
  'Exotic Orchard', 'Reliquary Tower', "Rogue's Passage", 'Temple of the False God', 'Path of Ancestry', 'Thornwood Falls', 'Jungle Hollow',
  'Tranquil Thicket', 'Blossoming Sands', 'Scoured Barrens', "Karametra's Acolyte", 'Leatherback Baloth',
];
/** Moloid (Mole Man) and Everywhere (Overlord of the Hauntwoods), as behaviorTemplates.ts names them. */
const TOKEN_IDS = ['26457778-9e7e-4de8-b5a9-78990b1fca13', '77872673-2806-41ee-bc4c-57fbc488a40f'];
/** Nothing the simulator reads. */
const DROP = new Set(['imageSmall', 'imageNormal', 'imageBackSmall', 'imageBackNormal', 'tags', 'legalities', 'tokenOracleIds']);

const read = (f) => JSON.parse(gunzipSync(readFileSync(join(DB, f))).toString('utf8'));
const manifest = JSON.parse(readFileSync(join(DB, 'manifest.json'), 'utf8'));
const byName = new Map();
const byId = new Map();
for (const chunk of manifest.v2.chunks.oracle) {
  for (const c of read(chunk.url)) {
    byId.set(c.oracleId, c);
    if (!/^Token/.test(c.typeLine) && !byName.has(c.name)) byName.set(c.name, c);
  }
}
const slim = (c) => {
  const o = {};
  for (const [k, v] of Object.entries(c)) if (!DROP.has(k)) o[k] = v;
  o.defaultScryfallId = '';
  return o;
};
const out = { cards: [], tokens: [] };
const missing = [];
for (const n of NAMES) (byName.has(n) ? out.cards : missing).push(byName.has(n) ? slim(byName.get(n)) : n);
for (const id of TOKEN_IDS) (byId.has(id) ? out.tokens : missing).push(byId.has(id) ? slim(byId.get(id)) : id);
if (missing.length) throw new Error(`not in this build: ${missing.join(', ')}`);
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${out.cards.length} cards and ${out.tokens.length} tokens to ${OUT}`);
