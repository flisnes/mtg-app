# scanjob — card-scan hash generation (Phase S1)

Batch job for the Oracle VM. Produces `cardhashes.bin` (64-bit horizontal +
vertical dHash of every printing's art crop) plus a `manifest.json` version
beacon, served by Caddy at `https://<host>/scan/`. The PWA downloads the blob
and identifies card art on-device (Phase S2+).

Files:

- `hashgen.py` — the job: bulk download → art-crop cache → dHash → blob.
- `verify.py` — reference blob reader + the S1 self-match acceptance test.
- `systemd/` — service + timer units for the nightly run.

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

# 6. Acceptance test, then enable the nightly timer
venv/bin/python3 verify.py --out-dir /srv/binder-scan --data-dir ~/scanjob/data --self-match 1000
sudo cp systemd/binder-scanhash.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now binder-scanhash.timer
```

Check: `curl https://79-76-41-163.sslip.io/scan/manifest.json`

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

- The art-crop cache (`data/artcache/`, ~5 GB for all printings) is permanent:
  art for an existing printing never changes, so nightly runs only fetch new
  printings. Hashes are cached too (`data/hashcache.json`), so unchanged images
  aren't re-decoded — a new-set run costs one bulk download, a few hundred
  image fetches, and finishes in minutes.
- The beacon is the standalone `manifest.json` next to the blob (`version`
  increments only when blob content changes). The client polls it directly —
  unlike `latestAppVersion` it can't live in the card-DB manifest, which is
  built by CI on Pages, not on the VM.
- `state.json` records the bulk `updated_at`; unchanged bulk → the job exits
  without doing any work.
- Blob format and the dHash bit layout are documented in `hashgen.py` and must
  stay in sync with `client/src/scan/` (blob.ts / hash.ts).
