---
name: deploy
description: Deploy or debug deploys of this repo — GitHub Pages (client) and the Oracle Cloud VM (server), including the manual scp fallback when Actions is down.
---

# Deploying this repo

Both halves deploy automatically on push to `main`. This skill is for the details: which workflow touches what, and how to deploy by hand when Actions is unavailable.

## Client → GitHub Pages

Automatic on every push to `main` (`.github/workflows/deploy-pages.yml`, which also runs a nightly card-DB rebuild). The workflow sets the build env vars, including `VITE_TRADE_WS_URL` — so trade is live in production; the "not configured" empty state only shows in local dev when that var is unset. Live at https://flisnes.github.io/mtg-app/.

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

Caddy on the VM terminates TLS and reverse-proxies `/ws`, `/healthz`, `/api/*` → `localhost:8080`.
