// Nightly card-DB pipeline (beta plan §3). Runs on the VM via cron.
//
// Phase 0: stub that documents the contract and the exact Scryfall fields to
// keep. The full implementation (Phase 1) will:
//   1. GET https://api.scryfall.com/bulk-data, find the `default_cards` entry,
//      download its `download_uri`.
//   2. Stream-parse the (hundreds of MB) JSON array, slimming each card to the
//      fields below. Be tolerant of unknown/added fields.
//   3. Emit two gzipped artifacts + a manifest.json into ./out:
//        - oracle-slim.json.gz     (one entry per oracle_id)
//        - printings-slim.json.gz  (all printings, grouped by oracle_id)
//        - manifest.json           (versions, sizes, sha256, latestAppVersion)
//   4. Caddy serves ./out as static files with strong caching + CORS for the
//      github.io origin.
//
// Fields kept per card (from ~80 Scryfall fields down to ~18):
//   scryfall_id (id), oracle_id, name, set, set_name, collector_number, lang,
//   released_at, mana_cost, cmc, type_line, oracle_text, colors, color_identity,
//   rarity, finishes, image_uris.small/normal (or card_faces[].image_uris),
//   prices.eur, prices.usd
//
// latestAppVersion source (beta plan §3.1): read from a repo/VM file that the
// GitHub Actions deploy updates. Decided in Phase 5; documented in README.

const SCRYFALL_BULK_INDEX = 'https://api.scryfall.com/bulk-data';

async function main(): Promise<void> {
  console.log('[pipeline] stub — not yet implemented (Phase 1).');
  console.log(`[pipeline] will fetch bulk index from ${SCRYFALL_BULK_INDEX}`);
  console.log('[pipeline] see pipeline/src/slim.ts header for the full contract.');
}

void main();
