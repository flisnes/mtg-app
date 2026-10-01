// mtg-app agent bridge. Claude Code spawns this over stdio (.mcp.json at the
// repo root); the PWA tab dials ws://127.0.0.1:8970 when Agent connections is
// enabled in Settings. See shared/src/agent.ts for the wire protocol.

import { AGENT_DEFAULT_PORT } from '@mtg/shared';
import { TabHub } from './hub.js';
import { startMcp } from './mcp.js';
import { log } from './log.js';

const BRIDGE_VERSION = '0.1.0';

const port = Number(process.env.MTG_AGENT_PORT) || AGENT_DEFAULT_PORT;
const extraOrigins = (process.env.MTG_AGENT_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const hub = new TabHub(port, extraOrigins);
startMcp(hub, BRIDGE_VERSION).catch((err) => {
  log('fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
