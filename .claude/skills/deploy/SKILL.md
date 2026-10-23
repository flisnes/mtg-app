---
name: deploy
description: Deploy or debug deploys of this repo — GitHub Pages (client) and the Oracle Cloud VM (server), including the manual scp fallback when Actions is down.
---

# Deploying this repo

Both halves deploy automatically on push to `main`. This skill is for the details: which workflow touches what, and how to deploy by hand when Actions is unavailable.

## Client → GitHub Pages

Automatic on every push to `main` (`.github/workflows/deploy-pages.yml`, which also runs a nightly card-DB rebuild). Live at https://flisnes.github.io/mtg-app/.

**The server address is not baked into the bundle.** The workflow copies `client/endpoints.prod.json` to the site as `endpoints.json`, and the app reads it at boot (`client/src/endpoints.ts`), remembers it in localStorage and refreshes it on every start. To move the server: edit `server` in that file and push. Pages redeploys and every installed app follows on its next start, no app update needed. Local builds get no `endpoints.json`, so trade shows its "not configured" state there unless `VITE_TRADE_WS_URL` is set (dev mode defaults to the local relay). The nightly run also re-enables its own schedule through the API, which resets GitHub's 60-day auto-disable for scheduled workflows in quiet public repos.

## Server → Oracle Cloud VM

Automatic on push to `main` **only when `server/` or `shared/` change** (`.github/workflows/deploy-server.yml`). A Pages deploy does NOT touch the server — separate workflow.

It builds the bundle, scps it flat to `~/mtg-server/index.js`, regenerates the VM's slim runtime `package.json` from `server/package.json` (drops `@mtg/shared`, which is bundled), `npm install`s, restarts `mtg-server`, health-checks `https://79-76-41-163.sslip.io/healthz`, and rolls back to `index.js.prev` if unhealthy. Auth via repo secrets `DEPLOY_SSH_KEY` + `DEPLOY_KNOWN_HOSTS`.

Manual fallback if Actions is down:

```bash
npm run build:server
scp server/dist/index.js ubuntu@79.76.41.163:~/mtg-server/index.js   # note: flat, not dist/
ssh ubuntu@79.76.41.163 'sudo systemctl restart mtg-server'
curl https://79-76-41-163.sslip.io/healthz
```

Caddy on the VM terminates TLS and reverse-proxies `/ws`, `/healthz`, `/api/*` → `localhost:8080`. The admin panel (Settings → Server admin, v0.202.0) lives under `/api/admin/*` for that reason; `ADMIN_USERNAMES` (comma-separated, default `flisnes`) names the account(s) that may open it. `/metrics` is not proxied and is only reachable from the VM itself.

The IP still appears in the ssh/scp steps of `deploy-server.yml`, `monthly-prices.yml` and this file. Those are operator paths, not shipped code: if the VM moves, update them alongside `client/endpoints.prod.json`.
