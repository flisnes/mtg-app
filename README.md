# MTG PWA — Minimal Beta

A local-first Magic: The Gathering **collection & trading** app for a small local-community beta.
All user data lives on-device (IndexedDB); the server is a stateless trade relay.

See the plans:

- **[`mtg-pwa-beta-plan.md`](./mtg-pwa-beta-plan.md)** — the authoritative build plan for this beta. Where it conflicts with the ultraplan, this wins.
- **[`mtg-app-ultraplan.md`](./mtg-app-ultraplan.md)** — long-term architecture reference.

## Repo layout

| Dir | What | Stack |
|---|---|---|
| `client/` | Installable PWA (search, collection, wishlist, tradelist, decks, trading). | Vite + React + TS, `vite-plugin-pwa`, Dexie (IndexedDB), hash routing |
| `server/` | Trade-session relay + `/healthz`. In-memory only, no DB. | Fastify + `ws`, TypeScript |
| `shared/` | Types shared by client and server (card DB, user data, trade protocol). | TypeScript |
| `pipeline/` | Nightly cron: download Scryfall bulk data, slim it, emit `oracle-slim` / `printings-slim` + `manifest.json`. | TypeScript (Node) |

This is a **single repo with npm workspaces**, deliberately not a monorepo tool (see beta plan §2).

## Getting started

```bash
npm install            # installs all workspaces

npm run dev:client     # Vite dev server for the PWA
npm run dev:server     # trade relay on :8080 (dev)

npm run typecheck      # typecheck every workspace
```

## Card database

The client loads a slimmed Scryfall dataset into IndexedDB on first launch, then
works offline. Generate the artifacts and point the client at them:

```bash
# 1. Build the artifacts (downloads Scryfall default_cards, ~556MB, streamed).
npm run pipeline                       # writes pipeline/out/{oracle-slim,printings-slim}.json.gz + manifest.json
BULK_TYPE=oracle_cards npm run pipeline # faster dry run (smaller bulk file)
MAX_CARDS=3000 npm run pipeline         # tiny smoke test (stops the stream early)

# 2. Serve pipeline/out over HTTP with CORS (in prod this is Caddy on the VM),
#    then tell the client where it lives:
VITE_CARD_DB_URL=https://cards.example.com/ npm run dev:client
```

Config env vars:

| Var | Used by | Meaning |
|---|---|---|
| `VITE_CARD_DB_URL` | client build/dev | Base URL serving `manifest.json` + the `.gz` artifacts. Unset → Scryfall fallback. |
| `VITE_BASE` | client build | Base path for GitHub Pages (`/<repo>/`). Defaults to `/`. |
| `BULK_TYPE` / `MAX_CARDS` / `APP_VERSION` / `OUT_DIR` | pipeline | See `pipeline/src/slim.ts`. |

If the configured URL is unreachable and there's no local DB, the client falls
back to fetching Scryfall's `oracle_cards` bulk directly (degraded: one printing
per card). Artifacts are gzipped and decompressed client-side via
`DecompressionStream`, so the static host must serve raw bytes (no
`Content-Encoding: gzip`).

## Deploy targets (Phase 5)

- **Client** → GitHub Pages via GitHub Actions. Requires Vite `base: '/<repo>/'`, PWA scope on the subpath, hash routing.
- **Server** → Oracle Cloud VM: Caddy (auto-TLS on a real domain) reverse-proxying the Node relay on `/ws` and serving the card-DB artifacts + `manifest.json`.

## Build order

Phase 0 skeleton → 1 card DB + search → 2 collection/wishlist/tradelist/import → 3 decks → 4 trading → 5 deploy + hardening. Each phase ends in something runnable.

## Legal

Card data & imagery via [Scryfall](https://scryfall.com/) (bulk data + image CDN). Unofficial Fan Content permitted under the [Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not affiliated with or endorsed by Wizards of the Coast. Attribution is shown in-app on the About screen.
