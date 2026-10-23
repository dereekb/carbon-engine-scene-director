import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_FLEET_PERSONALITY_NAMES, CAMERA_SHOT_NAMES, TOOLS } from '@scene-director/scene';

/** The built CLI: `nx test` builds it first (test dependsOn build), so this runs what .mcp.json launches. */
const CLI = path.resolve(import.meta.dirname, '../../../../../dist/apps/scene-director/main.js');

describe('mcp server', () => {
  it('the stdio MCP server lists every tool and answers a hub tool', async () => {
    expect(existsSync(CLI), `${CLI} is missing; run "npx nx build scene-director"`).toBe(true);
    // Port 0 picks a free port; an unreachable tools-core keeps the test offline; the personalities store is a temp one.
    const personalities = await mkdtemp(path.join(os.tmpdir(), 'scene-director-mcp-personalities-'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--port', '0', '--tools-core', 'http://127.0.0.1:9', '--personalities', personalities],
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
      expect(tools.find((tool) => tool.name === 'auto_repair')?.description).toMatch(/urgent/u);
      expect(orderFleet).toMatch(/regroup/u);
      expect(orderFleet).toMatch(/by is the ship giving the order/u);
      expect(orderFleet).toMatch(/"targets"/u);
      expect(orderFleet).toMatch(/locks and shoots the primary/u);
      expect(client.getInstructions()).toMatch(/calls the group's primary and target queue/u);
      expect(client.getInstructions()).toMatch(/list_fleet_personalities/u);
      expect(client.getInstructions()).toMatch(/an at \(seconds\) and the call becomes a cue instead of running now/u);
      expect(tools.find((tool) => tool.name === 'timeline')?.inputSchema).toMatchObject({ properties: { action: { enum: ['status', 'play', 'pause', 'restart'] } } });
      for (const name of ['order_fleet', 'add_fleet_composition']) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool?.inputSchema).toMatchObject({ properties: { at: { type: 'number' }, cue: { type: 'string' } } });
        expect(tool?.description).toMatch(/With at \(seconds from play start/u);
      }
      expect(orderFleet).toMatch(/with at the same object becomes a timeline cue/u);
      expect(tools.find((tool) => tool.name === 'add_fleet_composition')?.description).toMatch(/get_scene \{ at \}/u);
      expect(tools.find((tool) => tool.name === 'get_state')?.inputSchema.properties).not.toHaveProperty('at');
      expect(tools.find((tool) => tool.name === 'time_control')?.inputSchema).toMatchObject({ properties: { pause: { type: 'boolean' }, rate: { minimum: 1 / 16, maximum: 32 }, back: { exclusiveMinimum: 0 }, seek: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'object', required: ['timeline'] }] }, every: { minimum: 1, maximum: 60 }, window: { minimum: 10, maximum: 3600 } } });
      expect(tools.find((tool) => tool.name === 'time_control')?.description).toMatch(/back jumps that many scene seconds back/u);
      expect(tools.find((tool) => tool.name === 'get_state')?.description).toMatch(/back \(scene seconds a jump can go back now\)/u);
      expect(client.getInstructions()).toMatch(/time_control \{ back: 10 \} jumps back 10 scene seconds/u);
      expect(client.getInstructions()).toMatch(/\{ seek: \{ timeline: <seconds> \} \}/u);
      expect(tools.find((tool) => tool.name === 'get_state')?.description).toMatch(/timeline \(seconds of timeline time at now/u);
      expect(tools.find((tool) => tool.name === 'time_control')?.description).toMatch(/steps every 1 s Destiny tick/u);
      expect(tools.find((tool) => tool.name === 'get_state')?.description).toMatch(/time is the scene clock under time_control/u);
      expect(client.getInstructions()).toMatch(/time_control pauses or plays the scene/u);
      expect(tools.find((tool) => tool.name === 'stage_engagement')?.inputSchema).toMatchObject({ properties: { sides: { items: { properties: { personality: {} } } } } });
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/add_fleet_composition/u);
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/add_ships/u);
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/stage_engagement/u);
      expect(tools.find((tool) => tool.name === 'patch_scene')?.description).toMatch(/set_location/u);

      const status = (await client.callTool({ name: 'viewer_status', arguments: {} })) as { content: { text: string }[] };
      const body = JSON.parse(status.content[0].text) as { connectedTabs: number; toolsCore: { reachable: boolean } };
      expect(body.connectedTabs).toBe(0);
      expect(body.toolsCore.reachable).toBe(false);
      expect((body as { personalitiesDirectory?: string }).personalitiesDirectory).toBe(personalities);

      // The built-in personalities are static data on the hub: they list with no tab.
      const listed = (await client.callTool({ name: 'list_fleet_personalities', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      expect(listed.isError).toBeFalsy();
      const library = JSON.parse(listed.content[0].text) as { personalities: { name: string; store: string; description?: string }[] };
      expect(library.personalities.filter((entry) => entry.store === 'built-in').map((entry) => entry.name)).toEqual([...BUILT_IN_FLEET_PERSONALITY_NAMES]);
      expect(library.personalities.every((entry) => entry.description)).toBe(true);

      const missing = (await client.callTool({ name: 'get_scene', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toMatch(/No viewer tab is connected/);

      // The shot library is static data on the hub: it answers with no tab.
      const shots = (await client.callTool({ name: 'list_shots', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      expect(shots.isError).toBeFalsy();
      expect((JSON.parse(shots.content[0].text) as { shots: { name: string }[] }).shots.map((shot) => shot.name)).toEqual(CAMERA_SHOT_NAMES);

      const map = (await client.callTool({ name: 'search_map', arguments: { query: 'Jita' } })) as { isError?: boolean; content: { text: string }[] };
      expect(map.isError).toBe(true);
      expect(map.content[0].text).toMatch(/unreachable|tools-core/u);
    } finally {
      await client.close();
    }
  });
});
