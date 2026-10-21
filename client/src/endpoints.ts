import { readJson, writeJson } from './util/localStore.js';

// Where the server lives, decided at run time.
//
// The trade relay, the accounts API and the scan data all sit behind one
// Caddy on the Oracle VM, whose address is a raw IP wrapped in an sslip.io
// name. Baking that into the bundle (VITE_TRADE_WS_URL, until v0.201.5) meant
// a change of IP broke trade, sync, scan and OCR for every installed PWA at
// once, and recovery needed a Pages deploy plus every device accepting an app
// update. Now the Pages site serves endpoints.json next to the app (copied
// from client/endpoints.prod.json by deploy-pages.yml), the app reads it at
// boot and remembers the answer in localStorage. Moving the server is a
// one-line edit to that file and a Pages deploy: no app update for anyone.
//
// Precedence, highest first:
//   1. endpoints.json fetched this boot, or the copy remembered from the last
//   2. VITE_TRADE_WS_URL baked at build time (local rigs with their own relay)
//   3. the dev relay on localhost:8080 under `vite dev`
//   4. none: trade, accounts and scanning show their "not configured" states
//
// Dev builds skip step 1 unless VITE_RUNTIME_ENDPOINTS is set, so a local
// session never quietly talks to production. Call sites read the address
// through the functions in trade/config.ts, account/config.ts and
// scan/config.ts each time they need it, so a refreshed answer applies to the
// next socket or request without a reload.

/** The shape of endpoints.json. Only `server` is read; other keys are ignored. */
export interface RuntimeEndpoints {
  /** The server's origin, e.g. "https://host". No path, no trailing slash. */
  server: string;
}

const STORAGE_KEY = 'endpoints';
const FILE = 'endpoints.json';
const FETCH_TIMEOUT_MS = 4000;

/** Validate a parsed endpoints.json (or the localStorage copy). Null when unusable. */
export function parseEndpoints(raw: unknown): RuntimeEndpoints | null {
  if (!raw || typeof raw !== 'object') return null;
  const server = (raw as { server?: unknown }).server;
  if (typeof server !== 'string') return null;
  const trimmed = server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s?#]+$/.test(trimmed)) return null;
  return { server: trimmed };
}

/**
 * The server base ("http(s)://host") from the sources above, or null when no
 * server is configured at all. Pure, so the precedence is testable.
 */
export function resolveServerBase(input: {
  runtime: RuntimeEndpoints | null;
  bakedWsUrl: string | undefined;
  dev: boolean;
}): string | null {
  if (input.runtime) return input.runtime.server;
  if (input.bakedWsUrl) return input.bakedWsUrl.replace(/^ws/, 'http').replace(/\/ws\/?$/, '');
  if (input.dev) return 'http://localhost:8080';
  return null;
}

/** The three services behind the server base, as the client addresses them. */
export function serverUrls(base: string): { ws: string; api: string; scan: string } {
  return {
    ws: `${base.replace(/^http/, 'ws')}/ws`,
    api: `${base}/api`,
    scan: `${base}/scan/`,
  };
}

let runtime: RuntimeEndpoints | null = parseEndpoints(readJson(STORAGE_KEY));

// Optional chains: import.meta.env only exists under Vite, and the scan
// modules pull this file into Node for the offline regression scripts.
const env = import.meta.env as Record<string, string | boolean | undefined> | undefined;

/** The server base in effect right now, or null when none is configured. */
export function serverBase(): string | null {
  return resolveServerBase({
    runtime,
    bakedWsUrl: env?.VITE_TRADE_WS_URL as string | undefined,
    dev: !!env?.DEV,
  });
}

/** Whether any server address is known yet (see loadEndpoints for why boot asks). */
export function serverKnown(): boolean {
  return serverBase() !== null;
}

/**
 * Fetch endpoints.json from the site the app was served from and remember it.
 * Resolves on success and on every failure alike (offline, 404 on a local
 * build, a bad body, the timeout): the remembered or baked address stays in
 * effect. main.tsx waits for this only when no address is known at all, which
 * is a device's very first boot of a production build.
 */
export async function loadEndpoints(): Promise<void> {
  if (!env || typeof fetch !== 'function') return;
  if (env.DEV && !env.VITE_RUNTIME_ENDPOINTS) return;
  const base = typeof env.BASE_URL === 'string' ? env.BASE_URL : '/';
  const url = `${base.replace(/\/?$/, '/')}${FILE}`;
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return;
    const next = parseEndpoints(await res.json());
    if (!next || next.server === runtime?.server) return;
    runtime = next;
    writeJson(STORAGE_KEY, next);
  } catch {
    /* unreachable or malformed: keep what we have */
  }
}
