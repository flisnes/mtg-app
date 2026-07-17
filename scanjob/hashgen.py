#!/usr/bin/env python3
"""Binder card-scanning hash job (Phase S1).

Downloads the Scryfall `default_cards` bulk file, fetches every printing's
art-crop image into a permanent local cache, computes a 64-bit horizontal +
vertical dHash per printing face, and publishes a versioned binary blob
(`cardhashes.bin`) plus a small `manifest.json` beacon into a directory served
by Caddy. The PWA downloads the blob and matches camera/photo art crops
against it fully on-device.

The card filter mirrors the card-DB pipeline (pipeline/src/slimCard.ts): skip
entries without oracle_id/name, digital-only cards, and non-paper cards — so
every blob record resolves against the client's local printings table.

dHash definition (must stay bit-identical with client/src/scan/hash.ts):
  horizontal: grayscale (ITU-R 601-2 L, Pillow convert("L")) -> bilinear
    resize to 9x8 -> bit = 1 where px[y][x] > px[y][x+1], row-major
  vertical:   same but resize to 8x9, bit = 1 where px[y][x] > px[y+1][x]
  packing:    64 bits MSB-first: bit (63 - (y*8 + x)) holds comparison (y, x)

Blob format (little-endian):
  Header (16 bytes): magic "BNDH", u32 format version (1), u16 algo
    (2 = horizontal + vertical dHash), u16 reserved, u32 record count
  Record (40 bytes): u64 hashH, u64 hashV, 16-byte scryfall UUID,
    u8 faceIndex, 7 pad bytes

Usage:
  hashgen.py --data-dir /var/lib/binder-scan --out-dir /srv/scan
  hashgen.py --bulk-file small.json --limit 50   # local smoke test

State and the image cache live under --data-dir; only cardhashes.bin and
manifest.json are published (atomically) into --out-dir.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import struct
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone

import requests
from PIL import Image

try:
    import ijson  # streaming parse: default_cards is far too big for json.load
except ImportError:  # pragma: no cover - smoke tests may use a small --bulk-file
    ijson = None

SCRYFALL_BULK_INDEX = "https://api.scryfall.com/bulk-data"
USER_AGENT = "BinderScanHashJob/1.0 (github.com/flisnes/mtg-app)"
MIN_REQUEST_INTERVAL = 0.11  # ~9 req/s, under Scryfall's 10/s guideline
BLOB_MAGIC = b"BNDH"
BLOB_FORMAT_VERSION = 1
ALGO = 2  # horizontal + vertical dHash


# --- dHash ------------------------------------------------------------------

def dhash64(img: Image.Image, vertical: bool) -> int:
    """64-bit dHash. Horizontal: 9x8 resize, compare left/right neighbours.
    Vertical: 8x9 resize, compare top/bottom neighbours."""
    size = (8, 9) if vertical else (9, 8)
    small = img.convert("L").resize(size, Image.BILINEAR)
    px = small.load()
    h = 0
    for y in range(8):
        for x in range(8):
            if vertical:
                bit = 1 if px[x, y] > px[x, y + 1] else 0
            else:
                bit = 1 if px[x, y] > px[x + 1, y] else 0
            h = (h << 1) | bit
    return h


# --- Scryfall access ---------------------------------------------------------

class RateLimiter:
    def __init__(self, interval: float):
        self.interval = interval
        self._last = 0.0

    def wait(self) -> None:
        now = time.monotonic()
        delta = now - self._last
        if delta < self.interval:
            time.sleep(self.interval - delta)
        self._last = time.monotonic()


def http_get(session: requests.Session, url: str, limiter: RateLimiter, *,
             stream: bool = False, retries: int = 3) -> requests.Response:
    for attempt in range(retries):
        limiter.wait()
        try:
            res = session.get(url, timeout=120, stream=stream)
            if res.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {res.status_code}")
            res.raise_for_status()
            return res
        except (requests.RequestException, OSError):
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def find_bulk_entry(session: requests.Session, limiter: RateLimiter) -> dict:
    res = http_get(session, SCRYFALL_BULK_INDEX, limiter)
    for entry in res.json()["data"]:
        if entry["type"] == "default_cards":
            return entry
    raise RuntimeError("default_cards bulk entry not found")


def download_bulk(session: requests.Session, limiter: RateLimiter,
                  uri: str, dest: str) -> None:
    res = http_get(session, uri, limiter, stream=True)
    tmp = dest + ".part"
    with open(tmp, "wb") as f:
        for chunk in res.iter_content(chunk_size=1 << 20):
            f.write(chunk)
    os.replace(tmp, dest)


def iter_cards(bulk_path: str):
    """Stream card objects from the bulk JSON array without loading it all."""
    if ijson is not None:
        with open(bulk_path, "rb") as f:
            yield from ijson.items(f, "item")
    else:
        with open(bulk_path, "r", encoding="utf-8") as f:
            yield from json.load(f)


# --- Card selection (mirrors pipeline/src/slimCard.ts) ------------------------

def art_crop_faces(card: dict):
    """Yield (face_index, art_crop_uri) for every hashable face of a card."""
    uris = card.get("image_uris")
    if uris:
        art = uris.get("art_crop")
        if art:
            yield 0, art
        return
    for i, face in enumerate(card.get("card_faces") or []):
        art = (face.get("image_uris") or {}).get("art_crop")
        if art:
            yield i, art


def keep_card(card: dict) -> bool:
    if not card.get("oracle_id") or not card.get("name"):
        return False
    if card.get("digital"):
        return False
    games = card.get("games")
    if games and "paper" not in games:
        return False
    return True


# --- Image cache --------------------------------------------------------------

def cache_path(cache_dir: str, uri: str) -> str:
    return os.path.join(cache_dir, hashlib.sha1(uri.encode()).hexdigest() + ".jpg")


def fetch_art(session: requests.Session, limiter: RateLimiter,
              cache_dir: str, uri: str) -> str | None:
    """Return the cached file path for an art crop, downloading if missing."""
    path = cache_path(cache_dir, uri)
    if os.path.exists(path):
        return path
    try:
        res = http_get(session, uri, limiter)
    except requests.RequestException as e:
        print(f"[scanjob] WARN: fetch failed, skipping this run: {uri} ({e})",
              file=sys.stderr)
        return None
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(res.content)
    os.replace(tmp, path)
    return path


# --- Blob output ---------------------------------------------------------------

def write_blob(path: str, records: list[tuple[int, int, bytes, int]]) -> None:
    """records: (hashH, hashV, uuid_bytes, face_index), pre-sorted."""
    with open(path, "wb") as f:
        f.write(struct.pack("<4sIHHI", BLOB_MAGIC, BLOB_FORMAT_VERSION,
                            ALGO, 0, len(records)))
        for h, v, uid, face in records:
            f.write(struct.pack("<QQ16sB7x", h, v, uid, face))


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- Main ----------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Binder scan-hash generation job")
    ap.add_argument("--data-dir", default="./data",
                    help="state + permanent art-crop cache (never served)")
    ap.add_argument("--out-dir", default="./out",
                    help="published dir (served by Caddy): cardhashes.bin + manifest.json")
    ap.add_argument("--bulk-file", default=None,
                    help="use a local bulk JSON instead of downloading (testing)")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after N hashed printings (testing)")
    ap.add_argument("--force", action="store_true",
                    help="run even if the bulk updated_at is unchanged")
    args = ap.parse_args()

    cache_dir = os.path.join(args.data_dir, "artcache")
    os.makedirs(cache_dir, exist_ok=True)
    os.makedirs(args.out_dir, exist_ok=True)
    state_path = os.path.join(args.data_dir, "state.json")
    state = {}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    limiter = RateLimiter(MIN_REQUEST_INTERVAL)

    # Hash cache: art for an existing printing never changes, so hashes are as
    # permanent as the image cache. Keyed by cache filename, hex-encoded.
    # Without this every run re-decodes ~90k JPEGs for no reason.
    hashcache_path = os.path.join(args.data_dir, "hashcache.json")
    hashcache: dict[str, list[str]] = {}
    if os.path.exists(hashcache_path):
        try:
            with open(hashcache_path) as f:
                hashcache = json.load(f)
        except (OSError, json.JSONDecodeError):
            hashcache = {}

    if args.bulk_file:
        bulk_path = args.bulk_file
        bulk_updated_at = f"local:{os.path.getmtime(bulk_path)}"
    else:
        entry = find_bulk_entry(session, limiter)
        bulk_updated_at = entry["updated_at"]
        blob_published = os.path.exists(os.path.join(args.out_dir, "cardhashes.bin"))
        if (not args.force and blob_published
                and state.get("bulkUpdatedAt") == bulk_updated_at):
            print(f"[scanjob] bulk unchanged ({bulk_updated_at}), nothing to do")
            return 0
        bulk_path = os.path.join(args.data_dir, "bulk-default-cards.json")
        print(f"[scanjob] downloading bulk ({entry['size'] / 1e6:.0f} MB)…")
        download_bulk(session, limiter, entry["download_uri"], bulk_path)

    if ijson is None and os.path.getsize(bulk_path) > 100 * 1024 * 1024:
        print("[scanjob] ERROR: ijson is required for full bulk files "
              "(pip install ijson)", file=sys.stderr)
        return 1

    # Hash every kept printing face. The art index (id/face -> cache file) is
    # rewritten each run for verify.py's self-match test.
    records: list[tuple[int, int, bytes, int]] = []
    art_index_path = os.path.join(args.data_dir, "artindex.jsonl")
    seen = kept = fetched = failed = reused = 0
    started = time.monotonic()

    with open(art_index_path, "w", encoding="utf-8") as art_index:
        for card in iter_cards(bulk_path):
            seen += 1
            if seen % 5000 == 0:
                rate = seen / (time.monotonic() - started)
                print(f"[scanjob] {seen} cards seen, {kept} hashed, "
                      f"{failed} failed ({rate:.0f} cards/s)…")
            if not keep_card(card):
                continue
            for face, uri in art_crop_faces(card):
                was_cached = os.path.exists(cache_path(cache_dir, uri))
                path = fetch_art(session, limiter, cache_dir, uri)
                if path is None:
                    failed += 1
                    continue
                if not was_cached:
                    fetched += 1
                filename = os.path.basename(path)
                cached_hash = hashcache.get(filename) if was_cached else None
                if cached_hash:
                    h, v = int(cached_hash[0], 16), int(cached_hash[1], 16)
                    reused += 1
                else:
                    try:
                        with Image.open(path) as img:
                            h = dhash64(img, vertical=False)
                            v = dhash64(img, vertical=True)
                    except OSError as e:
                        print(f"[scanjob] WARN: unreadable image {path}: {e}",
                              file=sys.stderr)
                        failed += 1
                        continue
                    hashcache[filename] = [f"{h:016x}", f"{v:016x}"]
                records.append((h, v, uuid.UUID(card["id"]).bytes, face))
                art_index.write(json.dumps(
                    {"id": card["id"], "face": face,
                     "file": os.path.basename(path)}) + "\n")
                kept += 1
            if args.limit and kept >= args.limit:
                print(f"[scanjob] --limit {args.limit} reached")
                break

    if not records:
        print("[scanjob] ERROR: no records produced", file=sys.stderr)
        return 1

    hashcache_tmp = hashcache_path + ".tmp"
    with open(hashcache_tmp, "w") as f:
        json.dump(hashcache, f)
    os.replace(hashcache_tmp, hashcache_path)

    # Deterministic record order -> identical blob for identical inputs.
    records.sort(key=lambda r: (r[2], r[3]))

    # Publish atomically: blob first, manifest (the version beacon) last.
    blob_tmp = tempfile.NamedTemporaryFile(dir=args.out_dir, delete=False)
    blob_tmp.close()
    write_blob(blob_tmp.name, records)
    blob_sha = sha256_file(blob_tmp.name)

    if state.get("blobSha256") == blob_sha and not args.bulk_file:
        os.unlink(blob_tmp.name)
        version = state.get("version", 1)
        print(f"[scanjob] blob unchanged (v{version}), beacon not bumped")
    else:
        version = int(state.get("version", 0)) + 1
        blob_path = os.path.join(args.out_dir, "cardhashes.bin")
        os.replace(blob_tmp.name, blob_path)
        os.chmod(blob_path, 0o644)
        manifest = {
            "version": version,
            "algo": ALGO,
            "count": len(records),
            "bytes": os.path.getsize(blob_path),
            "sha256": blob_sha,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "bulkUpdatedAt": bulk_updated_at,
        }
        manifest_tmp = os.path.join(args.out_dir, ".manifest.json.tmp")
        with open(manifest_tmp, "w") as f:
            json.dump(manifest, f, indent=2)
        os.replace(manifest_tmp, os.path.join(args.out_dir, "manifest.json"))
        os.chmod(os.path.join(args.out_dir, "manifest.json"), 0o644)
        print(f"[scanjob] published v{version}: {len(records)} records, "
              f"{manifest['bytes'] / 1e6:.1f} MB, sha256={blob_sha[:8]}")

    state.update({"bulkUpdatedAt": bulk_updated_at, "blobSha256": blob_sha,
                  "version": version})
    state_tmp = state_path + ".tmp"
    with open(state_tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(state_tmp, state_path)

    print(f"[scanjob] done: {seen} cards seen, {kept} faces hashed "
          f"({reused} hashes reused, {fetched} new images fetched, "
          f"{failed} failed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
