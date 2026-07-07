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

## Deploy targets (Phase 5)

- **Client** → GitHub Pages via GitHub Actions. Requires Vite `base: '/<repo>/'`, PWA scope on the subpath, hash routing.
- **Server** → Oracle Cloud VM: Caddy (auto-TLS on a real domain) reverse-proxying the Node relay on `/ws` and serving the card-DB artifacts + `manifest.json`.

## Build order

Phase 0 skeleton → 1 card DB + search → 2 collection/wishlist/tradelist/import → 3 decks → 4 trading → 5 deploy + hardening. Each phase ends in something runnable.

## Legal

Card data & imagery via [Scryfall](https://scryfall.com/) (bulk data + image CDN). Unofficial Fan Content permitted under the [Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not affiliated with or endorsed by Wizards of the Coast. Attribution is shown in-app on the About screen.
