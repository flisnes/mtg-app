// The tab-side tool registry: what the bridge announces to the agent and how
// a call is dispatched. Tools are plain objects; their inputSchema is raw
// JSON Schema passed to the agent verbatim.

import type { AgentToolDescriptor } from '@mtg/shared';
import { getPrefs } from '../prefs.js';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Gated behind the "Allow changes" checkbox in Settings. */
  write?: boolean;
  timeoutMs?: number;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Keep results comfortably under the bridge's 1 MiB frame cap. */
const MAX_RESULT_BYTES = 900 * 1024;

export function manifestOf(tools: AgentTool[]): AgentToolDescriptor[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.write ? `${t.description} Requires "Allow changes" in the app's Agent connections settings.` : t.description,
    inputSchema: t.inputSchema,
    ...(t.timeoutMs ? { timeoutMs: t.timeoutMs } : {}),
  }));
}

export async function dispatch(tools: AgentTool[], name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  if (tool.write && !getPrefs().agentWrites) {
    throw new Error('writes_disabled: the user has turned off "Allow changes" in Settings > Agent connections');
  }
  const result = await tool.handler(args);
  const size = JSON.stringify(result ?? null).length;
  if (size > MAX_RESULT_BYTES) {
    throw new Error(`result_too_large: ${size} bytes — narrow the query (use limit/offset)`);
  }
  return result;
}
