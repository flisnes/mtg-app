// The MCP side of the bridge: a low-level Server whose tool list is whatever
// the connected tab announced. JSON Schemas pass through untouched.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { TabHub } from './hub.js';
import { log } from './log.js';

export async function startMcp(hub: TabHub, version: string): Promise<void> {
  const server = new Server(
    { name: 'mtg-app', version },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: hub.tools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object' as const, ...t.inputSchema },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await hub.call(name, (args ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  hub.onToolsChanged = () => {
    void server.sendToolListChanged().catch(() => {
      // Not connected yet or client gone; nothing to do.
    });
  };

  await server.connect(new StdioServerTransport());
  log('MCP server connected over stdio');
}
