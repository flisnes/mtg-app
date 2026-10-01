// Agent bridge protocol: the PWA tab <-> the local MCP bridge (bridge/).
//
// Direction of trust is inverted from the trade relay: the bridge runs on the
// user's own machine (spawned by Claude Code over stdio), binds 127.0.0.1
// only, and the browser tab connects OUT to it. The tab owns the data and the
// tools; the bridge is a dumb proxy that forwards MCP tools/list and
// tools/call. Tool input schemas are plain JSON Schema objects authored in
// the client and passed through to the agent verbatim.

export const AGENT_PROTOCOL_VERSION = 1 as const;

/** Default loopback port the bridge listens on and the tab dials. */
export const AGENT_DEFAULT_PORT = 8970;

/** One tool as the tab announces it. `inputSchema` is raw JSON Schema. */
export interface AgentToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Optional per-tool call timeout override, capped by the bridge. */
  timeoutMs?: number;
}

/** Error codes the bridge sends before giving up on a socket. */
export type AgentErrorCode = 'origin_rejected' | 'protocol_version' | 'malformed';

// ---------------------------------------------------------------------------
// Tab -> bridge
// ---------------------------------------------------------------------------

export type AgentTabMessage =
  // First message on every connection. Carries the full tool manifest; a
  // later hello from another tab evicts this one (newest wins).
  | {
      v: typeof AGENT_PROTOCOL_VERSION;
      type: 'agent_hello';
      app: string;
      appVersion: string;
      tools: AgentToolDescriptor[];
    }
  // The tool set changed while connected (e.g. the writes toggle flipped).
  | { v: typeof AGENT_PROTOCOL_VERSION; type: 'agent_tools_update'; tools: AgentToolDescriptor[] }
  // Answer to one agent_call. `result` is the tool's JSON result; `error` is
  // a short human-readable reason (the bridge relays it as an MCP tool error).
  | { v: typeof AGENT_PROTOCOL_VERSION; type: 'agent_call_result'; callId: string; ok: true; result: unknown }
  | { v: typeof AGENT_PROTOCOL_VERSION; type: 'agent_call_result'; callId: string; ok: false; error: string };

// ---------------------------------------------------------------------------
// Bridge -> tab
// ---------------------------------------------------------------------------

export type AgentBridgeMessage =
  | { v: typeof AGENT_PROTOCOL_VERSION; type: 'agent_call'; callId: string; tool: string; args: Record<string, unknown> }
  // A newer tab said hello; this socket is about to close (code 4001).
  | { v: typeof AGENT_PROTOCOL_VERSION; type: 'agent_replaced' }
  | { v: typeof AGENT_PROTOCOL_VERSION; type: 'agent_error'; code: AgentErrorCode; message: string };
