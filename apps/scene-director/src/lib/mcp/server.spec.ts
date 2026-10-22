import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '@scene-director/scene';

/** The built CLI: `nx test` builds it first (test dependsOn build), so this runs what .mcp.json launches. */
const CLI = path.resolve(import.meta.dirname, '../../../../../dist/apps/scene-director/main.js');

describe('mcp server', () => {
  it('the stdio MCP server lists every tool and answers a hub tool', async () => {
    expect(existsSync(CLI), `${CLI} is missing; run "npx nx build scene-director"`).toBe(true);
    // Port 0 picks a free port; an unreachable tools-core keeps the test offline.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--port', '0', '--tools-core', 'http://127.0.0.1:9'],
      stderr: 'ignore'
    });
    const client = new Client({ name: 'scene-director-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/move_to_squad/u);
      const orderFleet = tools.find((tool) => tool.name === 'order_fleet')?.description;
      expect(orderFleet).toMatch(/break-off/u);
      expect(orderFleet).toMatch(/regroup/u);
      expect(orderFleet).toMatch(/by is the ship giving the order/u);
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/add_fleet_composition/u);
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/add_ships/u);
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/stage_engagement/u);
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/set_location/u);

      const status = (await client.callTool({ name: 'viewer_status', arguments: {} })) as { content: { text: string }[] };
      const body = JSON.parse(status.content[0].text) as { connectedTabs: number; toolsCore: { reachable: boolean } };
      expect(body.connectedTabs).toBe(0);
      expect(body.toolsCore.reachable).toBe(false);

      const missing = (await client.callTool({ name: 'get_scene', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toMatch(/No viewer tab is connected/);

      const map = (await client.callTool({ name: 'search_map', arguments: { query: 'Jita' } })) as { isError?: boolean; content: { text: string }[] };
      expect(map.isError).toBe(true);
      expect(map.content[0].text).toMatch(/unreachable|tools-core/u);
    } finally {
      await client.close();
    }
  });
});
