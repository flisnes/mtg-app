# scanjob — card-scan hash generation (Phase S1)

Batch job for the Oracle VM. Produces `cardhashes2.bin` (64-bit horizontal +
vertical dHash of a fixed rectangle of every printing's card image) plus a
`manifest2.json` version beacon, served by Caddy at `https://<host>/scan/`. The
PWA downloads the blob and identifies cards on-device (Phase S2+).

Files:

- `hashgen.py` — the job: bulk download → card-image cache → crop → dHash → blob.
- `verify.py` — reference blob reader + the S1 self-match acceptance test.
- `systemd/` — service + timer units for the nightly run.

## Blob format v2 (2026-07-29)

v1 hashed Scryfall's `art_crop`, which sits in a different place on the card
for every layout, while the client can only ever hash one fixed box of the
flattened card. Sagas, split cards, Classes and Cases were unmatchable by
construction (distance floors of 57-69 against a lock threshold of 24), and
old frames and extended art were marginal at 19-22. v2 hashes `ART_BOX` of
Scryfall's `normal` image, which is 488×680 — exactly the client's
`CANONICAL_CARD` — so both sides crop the same region of the same geometry and
the floor is ~0 for every layout. See the `hashgen.py` docstring for the full
rationale and the known non-English caveat.

The two published pairs coexist so a client on an older build keeps working
during a rollout. Once everyone has updated, delete `cardhashes.bin`,
`manifest.json`, `data/artcache/`, `data/hashcache.json` and
`data/artindex.jsonl`.

**Do not delete `data/cardcache/`.** Those are the full card images, and they
are the input to every future run: nightly deltas, any change to `ART_BOX`, and
the planned secondary index over text-heavy layouts (which crops *different*
regions out of these same images). Deleting it costs another 3.4-hour refetch.
`data/artcache/` is the one that becomes dead weight, because an art crop does
not contain the card's frame or columns at all.

## Local smoke test

```sh
python3 -m venv venv && venv/bin/pip install -r requirements.txt
# small bulk file (a JSON array of Scryfall card objects) instead of the real 500MB one:
venv/bin/python3 hashgen.py --bulk-file test-bulk.json --data-dir ./data --out-dir ./out
venv/bin/python3 verify.py --out-dir ./out --data-dir ./data --self-match 30
```

## VM deploy

```sh
# 1. Copy the job to the VM
scp -r scanjob ubuntu@79.76.41.163:~/scanjob

# 2. On the VM: venv + deps
ssh ubuntu@79.76.41.163
cd ~/scanjob && python3 -m venv venv && venv/bin/pip install -r requirements.txt

# 3. Output dir served by Caddy
sudo mkdir -p /srv/binder-scan && sudo chown ubuntu:ubuntu /srv/binder-scan

# 4. Caddyfile: add inside the existing site block (before the reverse_proxy lines)
#    handle_path /scan/* {
#        root * /srv/binder-scan
#        file_server
#        header Access-Control-Allow-Origin "https://flisnes.github.io"
#        header Cache-Control "no-cache"
#    }
sudo systemctl reload caddy

# 5. First run (several hours: ~90k images at <10 req/s — run in tmux/screen)
venv/bin/python3 hashgen.py --data-dir ~/scanjob/data --out-dir /srv/binder-scan
#    v2 note: this refetches every image into data/cardcache/ (~11.5 GB, ~3.4 h
#    at 9 req/s) because the v1 artcache holds art crops, which v2 cannot use.
#    Check free space first: df -h ~. The 8.4 GB artcache can be deleted after
#    the rollout, but keep it until the new blob is live.

# 6. Acceptance test, then enable the nightly timer
venv/bin/python3 verify.py --out-dir /srv/binder-scan --data-dir ~/scanjob/data --self-match 1000
sudo cp systemd/binder-scanhash.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now binder-scanhash.timer
```

Check: `curl https://79-76-41-163.sslip.io/scan/manifest2.json`

## OCR assets (Phase S4)

The client's OCR stage (edition/language disambiguation) loads Tesseract's
worker, WASM core, and the English traineddata from `/scan/ocr/` when a scan
endpoint is configured — self-hosted so the PWA never depends on a third-party
CDN. Copy the files pinned by the repo's `tesseract.js` npm version:

```sh
# From the repo root (after npm install):
ssh ubuntu@79.76.41.163 mkdir -p /srv/binder-scan/ocr
scp node_modules/tesseract.js/dist/worker.min.js \
    node_modules/tesseract.js-core/tesseract-core*.wasm.js \
    node_modules/tesseract.js-core/tesseract-core*.wasm \
    ubuntu@79.76.41.163:/srv/binder-scan/ocr/

# On the VM: English traineddata (~2 MB, gzipped)
curl -Lo /srv/binder-scan/ocr/eng.traineddata.gz \
  https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz
```

Re-copy whenever the `tesseract.js` npm dependency is upgraded. Without these
files OCR init fails and the app quietly falls back to art-match + manual
picker (by design).

## Notes

- The card-image cache (`data/cardcache/`, ~11.5 GB for all printings) is
  permanent: the image for an existing printing never changes, so nightly runs
  only fetch new printings. Hashes are cached too (`data/hashcache-v2.json`),
  so unchanged images aren't re-decoded — a new-set run costs one bulk
  download, a few hundred image fetches, and finishes in minutes.
- The beacon is the standalone `manifest2.json` next to the blob (`version`
  increments only when blob content changes). The client polls it directly —
  unlike `latestAppVersion` it can't live in the card-DB manifest, which is
  built by CI on Pages, not on the VM.
- Playtest cards (`promo_types: ["playtest"]`) are excluded from the blob: they
  are mostly white with a few lines of text and kept winning matches against
  bare tables. `client/src/scan/exclusions.ts` does the same for blobs already
  on a device.
- `state.json` records the bulk `updated_at`; unchanged bulk → the job exits
  without doing any work.
- Blob format and the dHash bit layout are documented in `hashgen.py` and must
  stay in sync with `client/src/scan/` (blob.ts / hash.ts).
