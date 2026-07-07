import { APP_VERSION } from './version.js';

// Lightweight diagnostic log (beta plan §5): a small ring buffer in
// localStorage that the user can copy-paste to the developer. No network, no
// personal data beyond whatever an error message happens to contain.

const KEY = 'errorLog';
const MAX = 25;

export interface LogEntry {
  t: number;
  kind: string;
  message: string;
  stack?: string;
}

function read(): LogEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LogEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: LogEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX)));
  } catch {
    /* storage full / unavailable — diagnostics are best-effort */
  }
}

export function logError(kind: string, message: string, stack?: string): void {
  const entries = read();
  entries.push({ t: Date.now(), kind, message, stack });
  write(entries);
}

export function getErrorLog(): LogEntry[] {
  return read();
}

export function clearErrorLog(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** A copy-paste friendly diagnostic bundle. */
export function formatDiagnostics(): string {
  const header = [`MTG app v${APP_VERSION}`, `UA: ${navigator.userAgent}`, `When: ${new Date().toISOString()}`].join('\n');
  const entries = read();
  const body = entries.length
    ? entries
        .map((e) => `[${new Date(e.t).toISOString()}] ${e.kind}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`)
        .join('\n\n')
    : '(no errors logged)';
  return `${header}\n\n${body}\n`;
}

/** Capture uncaught errors and promise rejections. Call once at startup. */
export function installGlobalErrorHandlers(): void {
  window.addEventListener('error', (ev) => logError('error', ev.message, ev.error?.stack));
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason as { message?: string; stack?: string } | undefined;
    logError('unhandledrejection', String(reason?.message ?? ev.reason), reason?.stack);
  });
}
