// Runtime config from the environment. Behind Caddy in production; Caddy
// terminates TLS and reverse-proxies /ws, so the Node process binds plain HTTP.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: num('PORT', 8080),
  /** Comma-separated Origin allowlist for /ws; empty allows any origin. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** In-memory session limits (beta plan §7). */
  maxSessionsPerIp: num('MAX_SESSIONS_PER_IP', 20),
  maxOfferLines: num('MAX_OFFER_LINES', 500),
  maxMessagesPerSec: num('MAX_MESSAGES_PER_SEC', 20),
  /** Reconnect grace + absolute session lifetime, in ms. */
  reconnectGraceMs: num('RECONNECT_GRACE_MS', 10 * 60 * 1000),
  sessionTtlMs: num('SESSION_TTL_MS', 2 * 60 * 60 * 1000),
  /** Device-transfer sessions are short-lived; no resume, so a tight TTL. */
  transferTtlMs: num('TRANSFER_TTL_MS', 15 * 60 * 1000),
} as const;
