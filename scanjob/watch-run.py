#!/usr/bin/env python3
"""Publish a machine-readable verdict for a hashgen run.

hashgen.py publishes atomically at the very end, so from the outside a crashed
run and an in-progress run look identical: no manifest2.json either way. That
is fine on a desktop with the log in front of you and useless from a phone.

This watcher waits for a running hashgen to exit, runs verify.py against
whatever it published, and writes status.json next to the blob. Caddy already
serves that directory, so the answer to "did it land, and is it any good?" is
one URL with no shell and no Claude session:

    https://<host>/scan/status.json

state is one of:
  running  - hashgen is still going (written immediately, so the URL is never 404)
  failed   - hashgen exited without publishing a blob
  poor     - blob published but verify.py rejected it (do NOT delete v1 data)
  ok       - blob published and verify.py passed

Usage (detach it, it outlives the ssh session):
    tmux new-session -d -s scanwatch \
      "venv/bin/python3 watch-run.py --pid $(pgrep -f 'hashgen.py --data-dir') \
       --data-dir ~/scanjob/data --out-dir /srv/binder-scan"
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

POLL_SECONDS = 30
STATUS_NAME = "status.json"
MANIFEST_NAME = "manifest2.json"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_status(out_dir: str, payload: dict) -> None:
    """Atomic write so a reader never sees a half-written file."""
    path = os.path.join(out_dir, STATUS_NAME)
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def alive(pid: int) -> bool:
    return os.path.exists(f"/proc/{pid}")


def tail(path: str, n: int = 25) -> list[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return [ln.rstrip("\n") for ln in f.readlines()[-n:]]
    except OSError:
        return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True,
                    help="pid of the running hashgen.py")
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--log", default=os.path.expanduser(
        "~/scanjob/hashgen-v2-run.log"))
    ap.add_argument("--self-match", type=int, default=1000)
    ap.add_argument("--verify", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "verify.py"))
    args = ap.parse_args()

    manifest_path = os.path.join(args.out_dir, MANIFEST_NAME)
    started = now()

    # The blob is published atomically at the end of the run, so "did this file
    # appear" is an honest published/not-published signal rather than a guess.
    published_before = os.path.exists(manifest_path)

    write_status(args.out_dir, {
        "state": "running",
        "pid": args.pid,
        "watchStartedAt": started,
        "checkedAt": now(),
        "note": "hashgen in progress; this file is rewritten when it exits",
    })

    while alive(args.pid):
        time.sleep(POLL_SECONDS)

    published = os.path.exists(manifest_path) and not published_before

    if not published:
        write_status(args.out_dir, {
            "state": "failed",
            "pid": args.pid,
            "watchStartedAt": started,
            "checkedAt": now(),
            "note": "hashgen exited without publishing a blob; v1 still served. "
                    "Keep artcache/hashcache.json/artindex.jsonl.",
            "logTail": tail(args.log),
        })
        return 1

    with open(manifest_path, encoding="utf-8") as f:
        manifest = json.load(f)

    proc = subprocess.run(
        [sys.executable, args.verify,
         "--out-dir", args.out_dir,
         "--data-dir", args.data_dir,
         "--self-match", str(args.self_match)],
        capture_output=True, text=True)
    output = (proc.stdout + proc.stderr).strip().splitlines()
    self_match = next(
        (ln for ln in reversed(output) if ln.startswith("self-match")), None)

    ok = proc.returncode == 0
    write_status(args.out_dir, {
        "state": "ok" if ok else "poor",
        "pid": args.pid,
        "watchStartedAt": started,
        "checkedAt": now(),
        "manifest": manifest,
        "verifyExit": proc.returncode,
        "selfMatch": self_match,
        "note": ("blob published and verified; safe to retire the v1 files once "
                 "clients have rolled over"
                 if ok else
                 "blob published but FAILED verification - do not delete "
                 "artcache/hashcache.json/artindex.jsonl or the v1 blob"),
        "verifyTail": output[-15:],
    })
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
