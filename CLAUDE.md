# CLAUDE.md

MTG (Magic: The Gathering) collection & trading PWA. Local-first: all user data lives in IndexedDB on the device; an optional account syncs it. In-person trading runs over a WebSocket relay with a QR or 6-character join code.

## Layout (npm workspaces — use npm, not pnpm)

- `client/` — the PWA. **HashRouter** (GitHub Pages has no SPA rewrite, so routes live under `#/…`).
- `server/` — the relay. Trade sessions, accounts/sync API (`/api/*`), price archive. Persists to SQLite via `node:sqlite`.
- `shared/` — protocol types shared by client and server (`@mtg/shared`).
- `pipeline/` — builds the slimmed Scryfall card DB served to the client.

## Commands

```bash
npm run build:client      # run this before committing client changes
npm run pipeline          # build the card DB (env: MAX_CARDS caps it for fixtures)
```

Other scripts (`dev:client`, `dev:server`, `typecheck`) are in the root `package.json`.

## Verifying a change

There is **no unit-test suite** — the user-facing surface is the PWA, driven in a real browser. Use the `/verify` skill; it covers the fixture build, the boot gates that trip every naive Playwright script, and the selectors.

**Clean up after yourself:** kill any dev/static/relay servers and Playwright processes you start (5173 Vite, 8787 fixture static, the trade relay) before you finish. `kill %1` does NOT stop them — taskkill the PID tree and confirm the ports are clear.

## Deploy

- **Client → GitHub Pages, automatic on every push to `main`.** As this is still early in development, we keep pushing to main for now as deployment is our main way of testing the application.
- **Server → Oracle Cloud VM, automatic on push to `main` only when `server/` or `shared/` change.** A Pages deploy does NOT touch the server — separate workflow.
- Details (env vars, secrets, health check, manual scp fallback): the `/deploy` skill.

## Conventions

- Do not use em-dashes, florid language or other AI-generated text typicalities. Be concise instead! MtG references and humor, however, is welcome!
- Icons: add to the `IconName` union + `PATHS` in `client/src/components/icons.tsx` (24×24 Feather-style, `currentColor`). Avoid new inline emoji for affordances.
- Each user-facing release bumps `client/package.json` `version` and tags it in the commit subject, e.g. `... (v0.24.0)`.
- Each version bump also adds an entry to `CHANGELOG.md` (repo root), newest-first, in the existing user/tester-facing voice (what changed for the user, not the implementation).
- Each version bump also adds an entry to `client/src/changelog.ts`, newest-first — this feeds the in-app "What's changed" popup shown after an update. Keep it short (a sentence or two, shorter than the `CHANGELOG.md` entry), tag it `added`/`changed`/`fixed`/`removed`, and follow the same language rules (no em-dashes, concise). Skip it only for changes with nothing user-visible to say (pure refactors, internal fixes).
- Commit/push only when asked; branch off `main` first if asked to commit while on it.
