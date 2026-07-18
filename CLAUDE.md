# CLAUDE.md

MTG (Magic: The Gathering) collection & trading PWA. Local-first: all user data lives in IndexedDB on the device; an optional account syncs it. In-person trading runs over a WebSocket relay with a QR or 6-character join code.

## Layout (npm workspaces — use npm, not pnpm)

- `client/` — the PWA. Vite + React + TypeScript, Dexie (IndexedDB), `vite-plugin-pwa`. **HashRouter** (GitHub Pages has no SPA rewrite, so routes live under `#/…`).
- `server/` — Fastify + `@fastify/websocket` relay. Trade sessions, accounts/sync API (`/api/*`), price archive. Persists to SQLite via `node:sqlite` → **needs Node 22+**.
- `shared/` — protocol types shared by client and server (`@mtg/shared`).
- `pipeline/` — builds the slimmed Scryfall card DB served to the client.

## Commands

```bash
npm run dev:client        # Vite dev server
npm run dev:server        # relay (tsx watch)
npm run build:client      # tsc --noEmit && vite build  (run before committing client changes)
npm run typecheck         # all workspaces
npm run pipeline          # build the card DB (env: MAX_CARDS caps it for fixtures)
```

## Verifying a change

There is **no unit-test suite** — the user-facing surface is the PWA, driven in a real browser. Use the `/verify` skill, which builds a capped card-DB fixture, serves it, and runs Playwright against the app.

**Boot gotcha (this bites every time):** on a fresh IndexedDB the app shows *two* gates before the real UI, and both must be clicked through in order:

1. **"Download"** — the card-DB download gate (`CardDbGate`). One-time ~1 MB fetch.
2. **"Get started"** — the onboarding/welcome screen. Only appears after the download completes.

Only then does the app proper render (readiness signal = `.search-input` is visible). Any Playwright/puppeteer script that jumps straight to looking for app selectors will hang on these. Click both first. Prefer in-app hash navigation (`window.location.hash = '#/…'`) over `page.goto` for subsequent steps so you don't re-trigger onboarding.

## Deploy

- **Client → GitHub Pages, automatic on every push to `main`** (`.github/workflows/deploy-pages.yml`, also a nightly card-DB rebuild). The workflow sets the build env vars, including `VITE_TRADE_WS_URL` — so trade is live in production; the "not configured" empty state only shows in local dev when that var is unset. Live at https://flisnes.github.io/mtg-app/. As this is still early in development, we keep pushing to main for now as deployment is our main way of testing the application.
- **Server → Oracle Cloud VM, automatic on push to `main` when `server/` or `shared/` change** (`.github/workflows/deploy-server.yml`). A Pages deploy does NOT touch the server — this is a separate workflow. It builds the bundle, scps it flat to `~/mtg-server/index.js`, regenerates the VM's slim runtime `package.json` from `server/package.json` (drops `@mtg/shared`, which is bundled), `npm install`s, restarts `mtg-server`, health-checks `https://79-76-41-163.sslip.io/healthz`, and rolls back to `index.js.prev` if unhealthy. Auth via repo secrets `DEPLOY_SSH_KEY` + `DEPLOY_KNOWN_HOSTS`. Manual fallback if Actions is down:
  ```bash
  npm run build:server
  scp server/dist/index.js ubuntu@79.76.41.163:~/mtg-server/index.js   # note: flat, not dist/
  ssh ubuntu@79.76.41.163 'sudo systemctl restart mtg-server'
  curl https://79-76-41-163.sslip.io/healthz
  ```
  Caddy on the VM terminates TLS and reverse-proxies `/ws`, `/healthz`, `/api/*` → `localhost:8080`.

## Conventions

- Icons: add to the `IconName` union + `PATHS` in `client/src/components/icons.tsx` (24×24 Feather-style, `currentColor`). Avoid new inline emoji for affordances.
- Each user-facing release bumps `client/package.json` `version` and tags it in the commit subject, e.g. `... (v0.24.0)`.
- Commit/push only when asked; branch off `main` first if asked to commit while on it.
