import { useSyncExternalStore } from 'react';
import { DEFAULT_TUNING, type MoverTuning } from './movers.js';

// The user's own thresholds for the Price movers page. Device-local (same
// reasoning as prefs.ts: this is "how loud do I want this phone to be about
// price news", not collection data), so localStorage rather than the synced
// settings table.

/** One dial: what it is, what it means, and the range the slider allows. */
export interface TuningField {
  key: keyof MoverTuning;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** How the current value reads next to the label. 'fraction' shows as a percent. */
  unit: 'money' | 'percent' | 'fraction' | 'days' | 'readings' | 'r';
}

export interface TuningGroup {
  title: string;
  blurb: string;
  fields: TuningField[];
}

export const TUNING_GROUPS: TuningGroup[] = [
  {
    title: 'Risers and fallers',
    blurb:
      'A move counts when its size, as a share of these two thresholds, adds up to 1. Either one alone qualifies, and half of each together does too.',
    fields: [
      {
        key: 'absRef',
        label: 'Cash move that counts alone',
        hint: 'Lower it to hear about smaller swings on expensive cards.',
        min: 0.5,
        max: 25,
        step: 0.5,
        unit: 'money',
      },
      {
        key: 'pctRef',
        label: 'Percent move that counts alone',
        hint: 'Lower it to hear about smaller swings on cheap cards.',
        min: 5,
        max: 100,
        step: 1,
        unit: 'percent',
      },
      {
        key: 'noiseFloor',
        label: 'Ignore moves under',
        hint: 'Keeps a bulk common doubling from ten to twenty cents out of the list.',
        min: 0,
        max: 5,
        step: 0.05,
        unit: 'money',
      },
    ],
  },
  {
    title: 'Steady trends',
    blurb: 'A drift is steady when the daily readings line up against time instead of zigzagging.',
    fields: [
      {
        key: 'trendMinR',
        label: 'How straight the line must be',
        hint: '1.00 is a perfect line. Below about 0.6 a jagged history starts counting as a trend.',
        min: 0.3,
        max: 0.99,
        step: 0.01,
        unit: 'r',
      },
      {
        key: 'trendMinPct',
        label: 'Minimum total move',
        hint: 'A dead flat card technically trends. This drops those.',
        min: 0,
        max: 50,
        step: 1,
        unit: 'percent',
      },
      {
        key: 'trendMinPoints',
        label: 'Readings needed',
        hint: 'One reading is recorded per day you open the app.',
        min: 3,
        max: 30,
        step: 1,
        unit: 'readings',
      },
      {
        key: 'trendMinSpanDays',
        label: 'Days of history needed',
        hint: 'Measured from the first reading to the latest.',
        min: 2,
        max: 60,
        step: 1,
        unit: 'days',
      },
    ],
  },
  {
    title: 'Dips and spikes',
    blurb: 'A card qualifies when its history bounces within a range and the latest price sits near an end of it.',
    fields: [
      {
        key: 'swingEdgeBand',
        label: 'How close to the end counts',
        hint: 'Share of the range height from the low or the high.',
        min: 0.05,
        max: 0.45,
        step: 0.01,
        unit: 'fraction',
      },
      {
        key: 'swingMinPoints',
        label: 'Readings needed',
        hint: 'A swing needs enough points to show it actually bounced.',
        min: 4,
        max: 40,
        step: 1,
        unit: 'readings',
      },
      {
        key: 'swingMinSpanDays',
        label: 'Days of history needed',
        hint: 'Shorter spans call every wobble a dip.',
        min: 3,
        max: 90,
        step: 1,
        unit: 'days',
      },
    ],
  },
];

const FIELDS: TuningField[] = TUNING_GROUPS.flatMap((g) => g.fields);

const STORAGE_KEY = 'moverTuning';

let cache: MoverTuning | null = null;
const listeners = new Set<() => void>();

/** Keep a hand-edited or stale stored value inside the slider's own range. */
function clamp(field: TuningField, v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_TUNING[field.key];
  return Math.min(field.max, Math.max(field.min, v));
}

function sanitize(patch: Partial<MoverTuning>): MoverTuning {
  const out = { ...DEFAULT_TUNING };
  for (const f of FIELDS) {
    const v = patch[f.key];
    if (typeof v === 'number') out[f.key] = clamp(f, v);
  }
  return out;
}

function read(): MoverTuning {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw) as Partial<MoverTuning>);
  } catch {
    /* unparseable or unavailable storage — defaults are fine */
  }
  return DEFAULT_TUNING;
}

export function getMoverTuning(): MoverTuning {
  return (cache ??= read());
}

export function setMoverTuning(patch: Partial<MoverTuning>): void {
  cache = sanitize({ ...getMoverTuning(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* quota/private mode — the in-memory value still applies for this session */
  }
  for (const l of listeners) l();
}

/** Back to the shipped formula. */
export function resetMoverTuning(): void {
  cache = DEFAULT_TUNING;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
  for (const l of listeners) l();
}

/** True when the user has moved at least one dial off its default. */
export function isTuned(t: MoverTuning): boolean {
  return FIELDS.some((f) => t[f.key] !== DEFAULT_TUNING[f.key]);
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Reactive tuning. Same store, re-rendering on every setMoverTuning. */
export function useMoverTuning(): MoverTuning {
  return useSyncExternalStore(subscribe, getMoverTuning);
}
