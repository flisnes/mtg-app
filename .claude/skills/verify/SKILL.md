---
name: verify
description: Build, launch, and drive the MTG PWA end-to-end to verify a change against the real app (card-DB sync, search, collection flows).
---

# Verifying changes in this repo

The user-facing surface is the PWA (`client/`). Drive it in a real browser; there is no test suite.

## Launch

1. **Card-DB fixture** (needed for anything touching cardDb/sync/prices — the app gates on it):
   ```powershell
   $env:MAX_CARDS='5000'; $env:OUT_DIR="$env:TEMP\claude\pipeline-out"; npm run pipeline
   ```
   Streams Scryfall's real bulk file but stops after N cards (~30 s). NOTE: `default_cards` is sorted by scryfallId, so a capped run only covers ids starting with `0` — printings chunk skew in the output is an artifact of the cap, not a bug.
2. **Serve the fixture** with CORS + `Cache-Control: no-store` on some port (a 15-line `http.createServer` is fine; log request paths — the request log is how you verify which artifacts the client downloads).
3. **Dev server**:
   ```powershell
   $env:VITE_CARD_DB_URL='http://127.0.0.1:8787/'; npm run dev --workspace client -- --host 127.0.0.1 --port 5173 --strictPort
   ```
4. **Browser**: Playwright (not a repo dep — install in scratchpad) with `channel: 'chrome'`, headless is fine.

## Driving gotchas

- **Two gates before the real UI, and both must be clicked through in order** (this bites every time). On a fresh IndexedDB:
  1. **"Download"** — the card-DB download gate (`CardDbGate`). One-time ~1 MB fetch.
  2. **"Get started"** — the onboarding/welcome screen. Only appears after the download completes.

  Only then does the app proper render. Any Playwright script that jumps straight to app selectors will hang on these — click both first. Prefer in-app hash navigation (`window.location.hash = '#/…'`) over `page.goto` for subsequent steps so you don't re-trigger onboarding.
- Ready = `.search-input` visible. The card-DB gate can take a while on first import; use a generous timeout.
- Search result rows are `.result-row`, price is `.result-price`.
- Card DB state lives in IndexedDB database `mtg` (stores: `oracleCards`, `printings`, `priceShards`, `settings`). Read counts/settings via `page.evaluate` with raw `indexedDB.open('mtg')`.
- The app fetches `manifest.json` ~3× per load (sync + update beacon) — ignore duplicates when asserting the request log.
- Simulate "prices-only day" / "data changed" by generating variant fixture dirs (different `MAX_CARDS`, or hand-patch the prices file + manifest v2 block, gzip + sha256 must match) and switching the static server's root between page reloads — IndexedDB persists across reloads in one browser context, so update paths are exercised realistically.

## Clean up after yourself

Always terminate the dev/static/relay servers and any Playwright processes you started once verification is done (and definitely after pushing) — don't leave them holding ports (5173 Vite, 8787 fixture static, the trade relay).

Shell job control (`kill %1`) does NOT stop these background tool processes. Kill the actual PID tree and confirm the ports are clear:

```bash
netstat -ano | grep -E ':5173|:8787'
taskkill //PID <pid> //T //F
```
