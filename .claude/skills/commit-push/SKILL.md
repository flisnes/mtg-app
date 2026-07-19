---
name: commit-push
description: Commit the working changes and push to main so the automatic Pages/server deploy picks them up — for quick testing when the user is remote. Runs the git work on a cheap model to save Opus/Fable tokens.
---

# Commit & push to main

Purpose: after a long Opus/Fable session the user (often away from the machine) just wants the current changes committed and pushed to `main` so the automatic deploy lets them test. The point of this skill is to **spend as few main-context tokens as possible** — so hand the whole job to a Haiku subagent instead of doing the git work inline.

## Do this

Launch **one** `Agent` call with `model: haiku`, `subagent_type: general-purpose`, `run_in_background: false`, and the prompt below. Do not read diffs, edit files, or run git yourself — that defeats the token-saving purpose. When the subagent returns, relay its one-line summary (commit subject + pushed/skipped) to the user and stop.

If the subagent reports the build failed, surface the error to the user and do **not** retry inline — they may want to fix it in a fresh session.

## Subagent prompt

> Commit the current working changes in this repo and push to `main`. This repo deploys automatically on push to main, so a broken build wastes a deploy — be careful.
>
> Steps:
> 1. `git status` and `git diff` to see what changed. If there is nothing to commit, say so and stop.
> 2. Decide if this is a **user-facing** change (anything that alters the PWA's behavior/UI in `client/`) or **internal** (docs, tooling, server-only refactor, comments).
> 3. If user-facing: bump `client/package.json` `version` (patch for small fixes, minor for features — match the scale of the change), and add a newest-first entry to `CHANGELOG.md` under a new `## <version>` heading, written in the existing tester-facing voice (what changed for the user, not the implementation). Keep the MtG-flavored, no-em-dash, concise house style.
> 4. If any file under `client/` changed, run `npm run build:client` and confirm it passes before committing. If it fails, STOP, do not commit, and report the error.
> 5. Stage everything (`git add -A`), commit, and push to `main`. If user-facing, tag the version in the commit subject, e.g. `Short summary (v0.34.1)`. End the commit message body with:
>    `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`
> 6. Report back ONE line: the commit subject and whether the push succeeded (include the pushed SHA).
>
> Conventions: no em-dashes or florid language, be concise, MtG humor welcome. We intentionally push straight to `main` here — do NOT create a branch.
