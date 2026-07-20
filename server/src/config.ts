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
  /** Where the accounts SQLite file lives. */
  dataDir: process.env.DATA_DIR ?? './data',
  /**
   * Registration invite code, handed out by the operator. Empty (unset) means
   * registration is closed — existing accounts still work.
   */
  inviteCode: process.env.INVITE_CODE ?? '',
  /** Failed/total auth attempts allowed per IP per window (register+login). */
  authAttemptsPerWindow: num('AUTH_ATTEMPTS_PER_WINDOW', 20),
  authWindowMs: num('AUTH_WINDOW_MS', 15 * 60 * 1000),
  /** Bearer tokens unused for this long are pruned and rejected (sliding on last use). */
  tokenTtlMs: num('TOKEN_TTL_MS', 180 * 24 * 60 * 60 * 1000),
  /**
   * Published card DB the price archiver reads its daily shard from (no
   * trailing slash). Set CARD_DB_URL='' to disable archiving entirely.
   */
  cardDbUrl: (process.env.CARD_DB_URL ?? 'https://flisnes.github.io/mtg-app/carddb').replace(/\/+$/, ''),
  /** How often the archiver checks for a new price day, and the boot-time head start. */
  priceArchiveIntervalMs: num('PRICE_ARCHIVE_INTERVAL_MS', 60 * 60 * 1000),
  priceArchiveDelayMs: num('PRICE_ARCHIVE_DELAY_MS', 15 * 1000),
} as const;
