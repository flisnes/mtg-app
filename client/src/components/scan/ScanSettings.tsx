import { useEffect, useMemo, useState } from 'react';
import type { Finish, Printing, Priced } from '@mtg/shared';
import { FINISHES } from '@mtg/shared';
import { getPrintingForSet, getPrintingsForOracle } from '../../db/queries.js';
import { getPreferredCameraId, listCameras, type CameraOption } from '../../scan/camera.js';
import { loadLocks, type ScanLocks } from '../../scan/session.js';
import type { Candidate } from '../../scan/tray.js';
import { writeJson } from '../../util/localStore.js';
import { FINISH_LABELS, LANGS } from '../copyTraits.js';
import { EditionPicker } from '../EditionPicker.js';

/** The pile pins, persisted as they change (they outlive the scan, see loadLocks). */
export function useScanLocks() {
  const [locks, setLocks] = useState<ScanLocks>(loadLocks);
  useEffect(() => {
    writeJson('scan-locks', locks);
  }, [locks]);
  return [locks, setLocks] as const;
}

/**
 * The scan settings popover over the camera. Mounted only while it is open, so
 * the camera list and the set pin's options are read when it opens.
 */
export function ScanSettings({
  locks,
  candidates,
  autoAdd,
  onAutoAdd,
  onPinFinish,
  onPinLang,
  onPinSet,
  onPickCamera,
}: {
  locks: ScanLocks;
  /** The card in frame's tray (null before the first lock). */
  candidates: Candidate[] | null;
  autoAdd: boolean;
  onAutoAdd: (on: boolean) => void;
  /** '' = pin off. */
  onPinFinish: (v: string) => void;
  onPinLang: (v: string) => void;
  onPinSet: (set: string | null) => void;
  onPickCamera: (deviceId: string) => void;
}) {
  // The lenses this device offers, and which one is pinned ('' = let the OS
  // choose). Labels stay blank until camera permission has been granted.
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState(() => getPreferredCameraId() ?? '');

  // Re-read the pin on open: a pinned lens that has since disappeared is dropped
  // by the camera on start, and the picker must show that rather than a device
  // it isn't using.
  useEffect(() => {
    void listCameras().then((list) => {
      setCameras(list);
      setCameraId(getPreferredCameraId() ?? '');
    });
  }, []);

  // The sets the "set pile" pin can be pinned to: one printing per set of the
  // card in frame, the sets this scan actually matched first. Picking the set
  // from a list of the card's own editions is the whole point — arming the pin
  // from the top candidate pinned the wrong reprint half the time.
  const matched = useMemo(() => {
    const out = new Map<string, Priced<Printing>>();
    for (const c of candidates ?? []) if (c.printing && !out.has(c.printing.set)) out.set(c.printing.set, c.printing);
    return out;
  }, [candidates]);
  // Every printing of the card(s) in frame. Keyed on the oracle ids, not the
  // tray: an OCR result or a reorder lands a new tray of the same card, and that
  // must not re-read the editions.
  const oracleIds = [...new Set((candidates ?? []).map((c) => c.printing?.oracleId).filter((id): id is string => !!id))];
  const oracleKey = oracleIds.join();
  const [editions, setEditions] = useState<Priced<Printing>[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all: Priced<Printing>[] = [];
      for (const oracleId of oracleIds) all.push(...(await getPrintingsForOracle(oracleId)));
      // A pin held over from another card, or from last night's binder, isn't
      // among this card's editions, so one printing of that set is fetched just
      // to give the closed picker its name.
      if (locks.set && !all.some((p) => p.set === locks.set)) {
        const sample = await getPrintingForSet(locks.set);
        if (sample) all.push(sample);
      }
      if (!cancelled) setEditions(all);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oracleKey, locks.set]);
  const others = useMemo(() => {
    const out = new Map<string, Priced<Printing>>();
    for (const p of editions) if (!matched.has(p.set) && !out.has(p.set)) out.set(p.set, p);
    return [...out.values()];
  }, [editions, matched]);
  const options = [...matched.values(), ...others];

  /** Which row of the set picker the pin is sitting on ('' = the "off" row). */
  const pinnedSetPrinting = locks.set ? (options.find((p) => p.set === locks.set)?.scryfallId ?? '') : '';

  return (
    <div className="scan-settings" role="group" aria-label="Scan settings">
      {cameras.length > 1 && (
        <label className="scan-setting scan-setting-stacked">
          <span>
            <strong>Camera</strong>
            <small>Phones with several rear lenses like to swap mid-pile. Pin the one that focuses best up close.</small>
          </span>
          <select
            className="scan-lock-select scan-camera-select"
            value={cameraId}
            onChange={(e) => {
              setCameraId(e.target.value);
              onPickCamera(e.target.value);
            }}
          >
            <option value="">Automatic</option>
            {cameras.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="scan-setting">
        <span>
          <strong>Auto-add pinpointed edition</strong>
          <small>
            When the edition is confirmed (green check), add +1 on its own. Adding a copy yourself first stops it for
            that card.
          </small>
        </span>
        <input type="checkbox" checked={autoAdd} onChange={(e) => onAutoAdd(e.target.checked)} />
      </label>
      <label className="scan-setting">
        <span>
          <strong>Finish pile</strong>
          <small>A stack of foils (or etched)? Pin it and every card you add gets that finish</small>
        </span>
        <select className="scan-lock-select" value={locks.finish ?? ''} onChange={(e) => onPinFinish(e.target.value)}>
          <option value="">Off</option>
          {FINISHES.map((f: Finish) => (
            <option key={f} value={f}>
              {FINISH_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      <label className="scan-setting">
        <span>
          <strong>Language pile</strong>
          <small>Pin the pile&rsquo;s language; the reader can&rsquo;t overrule it (it misreads non-English cards)</small>
        </span>
        <select className="scan-lock-select" value={locks.lang ?? ''} onChange={(e) => onPinLang(e.target.value)}>
          <option value="">Off</option>
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {/* Not a <label>: the picker is a button until it's opened, and a
          label wrapping a button turns its own text into a second trigger. */}
      <div className="scan-setting scan-setting-stacked">
        <span>
          <strong>Set pile</strong>
          <small>
            {locks.set
              ? `Only ${locks.set.toUpperCase()} printings are suggested (they still show if the scan matches none), and the reader has less to tell apart`
              : candidates
                ? 'One set only. Pick it from the editions of the card in frame'
                : 'One set only. Scan a card from the pile, then pick its set here'}
          </small>
        </span>
        <EditionPicker
          printings={others}
          highlighted={[...matched.values()]}
          highlightLabel="Matched this scan"
          restLabel="Other sets of this card"
          selected={pinnedSetPrinting}
          anyLabel="Off: suggest every set"
          placeholder="Pick the pile’s set…"
          hideCollector
          onSelect={(scryfallId) => onPinSet(options.find((x) => x.scryfallId === scryfallId)?.set ?? null)}
        />
      </div>
    </div>
  );
}
