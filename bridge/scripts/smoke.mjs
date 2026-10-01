// Quick manual smoke test: spawns the bridge over stdio as an MCP client and
// lists the tools the connected tab announces. Open the app with Agent
// connections enabled first, then:  node bridge/scripts/smoke.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCli = path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(repo, 'bridge', 'src', 'index.ts')],
    cwd: repo,
    env: process.env,
    stderr: 'inherit',
  }),
);

for (let i = 0; i < 24; i++) {
  const { tools } = await client.listTools();
  if (tools.length > 0) {
    console.log(`${tools.length} tools from the tab:`);
    for (const t of tools) console.log(`  ${t.name}`);
    const res = await client.callTool({ name: 'list_containers', arguments: {} });
    console.log('list_containers:', res.content?.[0]?.text?.slice(0, 500));
    await client.close();
    process.exit(0);
  }
  console.log('no tab yet, waiting...');
  await new Promise((r) => setTimeout(r, 5000));
}
console.error('no tab connected within 2 minutes');
await client.close();
process.exit(1);
