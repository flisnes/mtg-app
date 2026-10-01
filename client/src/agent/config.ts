import { AGENT_DEFAULT_PORT } from '@mtg/shared';

/**
 * Where the local agent bridge listens (bridge/ workspace, spawned by Claude
 * Code). Loopback by definition — the whole point is that the tab and the
 * bridge share a machine.
 */
export const AGENT_WS_URL: string =
  (import.meta.env.VITE_AGENT_WS_URL as string | undefined) ?? `ws://127.0.0.1:${AGENT_DEFAULT_PORT}`;
