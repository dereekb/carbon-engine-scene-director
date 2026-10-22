import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ToContent } from '../mcp/server';
import { Hub, type HubOptions } from './hub';
import { applySceneOperations, createEmptyScene } from '@scene-director/scene';
import { FleetCompositionFileStore } from '../store/composition-files';
import { SceneFileStore } from '../store/scene-files';
import { RemoteHub } from './remote-hub';
import { ToolError } from './tool-call';
import { MakeFakeShipData, SDE, TFI_DNA, UnpreparedSdeRoutes } from './ship-data.testing';
import { MakeFakeMapData, MakeUnpreparedMapData } from './map-data.testing';
import type { ToolsCoreApi } from './tools-core';

/** Where the fake tools-core's audio URLs point: a local server a spec starts. */
let audioUpstream = 'http://127.0.0.1:9';

/** A tools-core stand-in: no network, one pinned build, a small hull catalog. */
const toolsCore: ToolsCoreApi = {
  url: 'http://tools-core.test',
  async ResolveBuild() {
    return '1234';
  },
  async ResourceUrl(resourcePath) {
    return `http://tools-core.test/eve/1234/resources/${resourcePath}`;
  },
  async ResFileIndexUrl() {
    return 'http://tools-core.test/eve/1234/app/resfileindex.txt';
  },
  async AudioLibraryUrl() {
    return `${audioUpstream}/eve/1234/audio/library`;
  },
  async AudioPathUrl(audioPath) {
    return `${audioUpstream}/eve/1234/audio/path/${encodeURIComponent(audioPath)}`;
  },
  async SofCatalog(kind) {
    return kind === 'hulls' ? ['af1_t1', 'af1_t2', 'cf1_t1', 'mf1_t1'] : ['amarrbase'];
  },
  async Status() {
    return { reachable: true, url: this.url, build: '1234' };
  }
};

/** The viewer source holds index.html, which is all these tests fetch. */
const VIEWER_SOURCE = path.resolve(import.meta.dirname, '../../../../viewer/src');

type Handler = (args: Record<string, unknown>) => unknown;

let hub: Hub;

/** A hub on a free port whose saved scene and fleet composition files go to fresh temp directories. */
async function StartHub(options: Partial<HubOptions> = {}): Promise<Hub> {
  const scenes = new SceneFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-hub-')));
  const compositions = new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-fleets-')));
  return new Hub({ port: 0, toolsCore, viewerDirectory: VIEWER_SOURCE, scenes, compositions, log: () => undefined, ...options }).Start();
}

beforeAll(async () => {
  hub = await StartHub();
});

afterAll(async () => {
  await hub.Stop();
});

/** Connects a fake viewer tab that answers tools from `handlers`. */
async function ConnectPage(handlers: Record<string, Handler>, target: Hub = hub): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${target.port}/ws`);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as { type: string; id: number; name: string; args: Record<string, unknown> };
    if (message.type !== 'call') return;
    Promise.resolve()
      .then(() => handlers[message.name](message.args))
      .then(
        (value) => ws.send(JSON.stringify({ type: 'result', id: message.id, ok: true, value })),
        (error: Error & { problems?: string[] }) => ws.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: { message: error.message, problems: error.problems } }))
      );
  });
  ws.send(JSON.stringify({ type: 'hello', role: 'page' }));
  await new Promise((resolve) => ws.once('message', resolve));
  return ws;
}

describe('hub', () => {
  it('hub tools answer without a viewer tab', async () => {
    const status = (await hub.Call('viewer_status')) as { connectedTabs: number; hint: string };
    expect(status.connectedTabs).toBe(0);
    expect(status.hint).toMatch(/Open http:\/\/127\.0\.0\.1:/);
    const hulls = (await hub.Call('search_hulls', { query: 'AF1' })) as { names: string[] };
    expect(hulls.names).toEqual(['af1_t1', 'af1_t2']);
  });

  it('page tools without a tab explain what to open', async () => {
    await expect(hub.Call('get_scene')).rejects.toThrow(/No viewer tab is connected\. Open http/);
    await expect(hub.Call('no_such_tool')).rejects.toThrow(/unknown tool/);
  });

  it('page tools round-trip through the newest tab, errors keep their problem list', async () => {
    const page = await ConnectPage({
      get_scene: () => ({ name: 'duel' }),
      load_scene: () => {
        throw Object.assign(new Error('Invalid scene document'), { problems: ['ships[0].dna is bad'] });
      }
    });
    try {
      expect(await hub.Call('get_scene')).toEqual({ name: 'duel' });
      const failure = await hub.Call('load_scene', { scene: {} }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolError);
      expect((failure as ToolError).details?.problems).toEqual(['ships[0].dna is bad']);
      expect(((await hub.Call('viewer_status')) as { connectedTabs: number }).connectedTabs).toBe(1);
    } finally {
      page.close();
    }
  });

  it('order_fleet goes to the tab unchanged, and an authority refusal keeps its problems', async () => {
    const seen: Record<string, unknown>[] = [];
    const refusal = 'order_fleet: ship "d2" has no command over fleet "f": its commanders are "fc" (fleet); a warp, like any fleet order, is given by one of them (the FC warps the fleet, a wing commander their wing, a squad commander their squad)';
    const page = await ConnectPage({
      order_fleet: (args) => {
        seen.push(args);
        if (args['by'] === 'd2') throw Object.assign(new Error(`Invalid scene document:\n- ${refusal}`), { problems: [refusal] });
        return { fleet: args['fleet'], leader: 'd1' };
      }
    });
    try {
      const args = { fleet: 'f', squad: 'dps', by: 'd1', order: { type: 'warp', point: [0, 0, 400000] } };
      expect(await hub.Call('order_fleet', args)).toEqual({ fleet: 'f', leader: 'd1' });
      expect(seen[0]).toEqual(args);
      const failure = await hub.Call('order_fleet', { fleet: 'f', by: 'd2', order: { type: 'warp', point: [0, 0, 400000] } }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolError);
      expect((failure as ToolError).details?.problems).toEqual([refusal]);
    } finally {
      page.close();
    }
  });

  it('page console lines reach page_log, filtered by level', async () => {
    const page = await ConnectPage({});
    page.send(
      JSON.stringify({
        type: 'log',
        entries: [
          { time: Date.now(), level: 'info', message: 'booted' },
          { time: Date.now(), level: 'error', message: 'frame failed: boom' }
        ]
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    page.close();
    const errors = (await hub.Call('page_log', { level: 'error' })) as { level: string; message: string }[];
    expect(errors.some((entry) => entry.message === 'frame failed: boom')).toBe(true);
    expect(errors.every((entry) => entry.level === 'error')).toBe(true);
  });

  it("a controller in another process shares the hub's tab", async () => {
    const page = await ConnectPage({ get_state: () => ({ ships: [] }) });
    const remote = new RemoteHub({ port: hub.port });
    try {
      expect(await remote.Call('get_state')).toEqual({ ships: [] });
      expect(((await remote.Call('viewer_status')) as { connectedTabs: number }).connectedTabs).toBe(1);
    } finally {
      await remote.Stop();
      page.close();
    }
  });

  it('a pending call fails when its tab closes', async () => {
    const page = await ConnectPage({ screenshot: () => new Promise(() => undefined) });
    const call = hub.Call('screenshot', {});
    setTimeout(() => page.close(), 50);
    await expect(call).rejects.toThrow(/closed or reloaded/);
  });

  it('the HTTP side serves the page and refuses paths outside the viewer directory', async () => {
    const page = await fetch(`http://127.0.0.1:${hub.port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/<canvas id="view">/);
    const escape = await fetch(`http://127.0.0.1:${hub.port}/app/..%2F..%2Fpackage.json`);
    expect(escape.status).toBe(404);
  });

  it('screenshot values become MCP image content', () => {
    const content = ToContent({ image: { data: 'iVBORw0KGgo=', mimeType: 'image/png' }, width: 2, height: 1 });
    expect(content.content[0]).toMatchObject({ type: 'image', data: 'iVBORw0KGgo=' });
    expect(JSON.parse((content.content[1] as { text: string }).text)).toEqual({ width: 2, height: 1 });
    expect(ToContent({ a: 1 }).content[0].type).toBe('text');
  });
});

describe('saved scenes', () => {
  const DUEL = { schema: 'cjs-scene/1', name: 'duel', ships: [{ id: 'a', dna: 'af1_t1:amarrbase:amarr' }] };
  let saves: Hub;

  beforeAll(async () => {
    saves = await StartHub();
  });

  afterAll(async () => {
    await saves.Stop();
  });

  /** Waits until the hub has seen every closed tab go. */
  async function NoTabs(): Promise<void> {
    for (let attempt = 0; attempt < 100 && ((await saves.Call('viewer_status')) as { connectedTabs: number }).connectedTabs > 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('work against disk with no viewer tab', async () => {
    const saved = (await saves.Call('save_scene', { name: 'Duel at Jita', scene: DUEL })) as { saved: string; store: string; file: string };
    expect(saved).toMatchObject({ saved: 'Duel at Jita', store: 'disk', ships: 1 });
    expect(saved.file).toBe(path.join(saves.savedScenes.files.directory, 'duel-at-jita.json'));
    expect(JSON.parse(await readFile(saved.file, 'utf8'))).toMatchObject({ schema: 'cjs-scene/1', name: 'Duel at Jita' });

    const listing = (await saves.Call('list_scenes')) as { scenes: { name: string; store: string }[]; note: string; directory: string };
    expect(listing.scenes).toEqual([expect.objectContaining({ name: 'Duel at Jita', store: 'disk', ships: 1 })]);
    expect(listing.note).toMatch(/not listed/);
    expect(listing.directory).toBe(saves.savedScenes.files.directory);

    const opened = (await saves.Call('open_scene', { name: 'duel at jita' })) as { loaded: boolean; store: string; scene: { ships: unknown[] } };
    expect(opened).toMatchObject({ opened: 'Duel at Jita', store: 'disk', loaded: false });
    expect(opened.scene.ships).toHaveLength(1);

    expect(await saves.Call('delete_scene', { name: 'Duel at Jita' })).toEqual({ deleted: true, name: 'Duel at Jita', store: 'disk' });
    expect(await saves.Call('delete_scene', { name: 'Duel at Jita' })).toMatchObject({ deleted: false, store: 'disk', note: expect.stringMatching(/no viewer tab/) });
  });

  it('explain what is missing with no viewer tab', async () => {
    await expect(saves.Call('save_scene', { name: 'x' })).rejects.toThrow(/Pass "scene" to save a document directly/);
    await expect(saves.Call('save_scene', { name: 'x', store: 'browser' })).rejects.toThrow(/No viewer tab is connected/);
    await expect(saves.Call('list_scenes', { store: 'browser' })).rejects.toThrow(/No viewer tab is connected/);
    await expect(saves.Call('open_scene', { name: 'nothing' })).rejects.toThrow(/no scene "nothing" is saved on disk .*no viewer tab/);
    await expect(saves.Call('open_scene', { name: 'x', store: 'cloud' })).rejects.toThrow(/store must be "disk" or "browser"/);
    const invalid = await saves.Call('save_scene', { name: 'x', scene: { ships: 3 } }).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ problems: ['ships must be an array'] });
  });

  it("save the tab's scene to disk by default and show disk scenes in the tab", async () => {
    const loaded: unknown[] = [];
    const page = await ConnectPage(
      {
        get_scene: () => ({ ...DUEL, name: 'current' }),
        load_scene: ({ scene }) => {
          loaded.push(scene);
          return { scene, warnings: [], ships: [], changes: {} };
        },
        list_scenes: () => []
      },
      saves
    );
    try {
      expect(await saves.Call('save_scene', {})).toMatchObject({ saved: 'current', store: 'disk', ships: 1 });
      const opened = (await saves.Call('open_scene', { name: 'current' })) as { store: string; scene: { name: string } };
      expect(opened).toMatchObject({ opened: 'current', store: 'disk', scene: { name: 'current' } });
      expect(loaded).toHaveLength(1);
      await expect(saves.Call('open_scene', { name: 'current', store: 'browser' })).rejects.toThrow();
    } finally {
      page.close();
      await NoTabs();
      await saves.Call('delete_scene', { name: 'current', store: 'disk' });
    }
  });

  it("keep the browser's IndexedDB saves listable, openable and deletable", async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const record = (name: string, value: unknown) => (args: Record<string, unknown>) => {
      calls.push([name, args]);
      return value;
    };
    const page = await ConnectPage(
      {
        save_scene: record('save_scene', { saved: 'kept', ships: 2 }),
        list_scenes: record('list_scenes', [{ name: 'old', savedAt: '2026-01-01T00:00:00.000Z', ships: 3 }]),
        open_scene: record('open_scene', { scene: { name: 'old' }, warnings: [] }),
        delete_scene: record('delete_scene', { deleted: true, name: 'old' })
      },
      saves
    );
    try {
      await saves.Call('save_scene', { name: 'on-disk', scene: DUEL });
      const listing = (await saves.Call('list_scenes')) as { scenes: { name: string; store: string }[]; note?: string };
      expect(listing.scenes.map(({ name, store }) => `${store}:${name}`)).toEqual(['disk:on-disk', 'browser:old']);
      expect(listing.note).toBeUndefined();
      expect(((await saves.Call('list_scenes', { store: 'disk' })) as { scenes: unknown[] }).scenes).toHaveLength(1);

      expect(await saves.Call('save_scene', { name: 'kept', store: 'browser' })).toEqual({ saved: 'kept', ships: 2, store: 'browser' });
      await expect(saves.Call('save_scene', { name: 'kept', store: 'browser', scene: DUEL })).rejects.toThrow(/only accepted for disk saves/);
      // Not on disk, so these fall through to the browser's storage.
      expect(await saves.Call('open_scene', { name: 'old' })).toMatchObject({ opened: 'old', store: 'browser', scene: { name: 'old' } });
      expect(await saves.Call('delete_scene', { name: 'old' })).toEqual({ deleted: true, name: 'old', store: 'browser' });
      await expect(saves.Call('open_scene', { name: 'old', store: 'disk' })).rejects.toThrow(/no scene "old" is saved on disk/);
      expect(calls.map(([name, args]) => `${name} ${JSON.stringify(args)}`)).toEqual(['list_scenes {}', 'save_scene {"name":"kept"}', 'open_scene {"name":"old"}', 'delete_scene {"name":"old"}']);
    } finally {
      page.close();
      await NoTabs();
    }
  });
});

describe('ship stats', () => {
  it('ship_stats and GET /ship-stats answer from the SDE with no viewer tab', async () => {
    const stats = await StartHub({ shipData: MakeFakeShipData().shipData });
    try {
      const answer = (await stats.Call('ship_stats', { dna: TFI_DNA, propMod: 'mwd' })) as { hull: { typeID: number }; withPropMod: { maxVelocity: number } };
      expect(answer.hull.typeID).toBe(17732);
      expect(answer.withPropMod.maxVelocity).toBeCloseTo(1176.137476, 3);
      const response = await fetch(`${stats.url}ship-stats?dna=${encodeURIComponent(TFI_DNA)}&propMod=mwd`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual(answer);
      expect((await fetch(`${stats.url}ship-stats?dna=nope`)).status).toBe(400);
    } finally {
      await stats.Stop();
    }
  });

  it('an unprepared SDE is a 503 and a tool error naming the prepare command', async () => {
    const stats = await StartHub({ shipData: MakeFakeShipData(UnpreparedSdeRoutes('42', 17732)).shipData });
    try {
      await expect(stats.Call('ship_stats', { type: 17732 })).rejects.toThrow(/cjs-sde-prepare\.js --build 42/);
      const response = await fetch(`${stats.url}ship-stats?type=17732`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ failure: 'unavailable', error: { message: expect.stringMatching(/--build 42/) } });
    } finally {
      await stats.Stop();
    }
  });
});

describe('prop mods and audio', () => {
  it('GET /prop-mod answers a module by name or id, and maps its failures', async () => {
    const stats = await StartHub({ shipData: MakeFakeShipData().shipData });
    try {
      const byName = await fetch(`${stats.url}prop-mod?module=${encodeURIComponent('500MN Cold-Gas Enduring Microwarpdrive')}`);
      expect(byName.status).toBe(200);
      expect(await byName.json()).toEqual({ propMod: { typeID: 5945, name: '500MN Cold-Gas Enduring Microwarpdrive', kind: 'microwarpdrive', speedFactor: 505, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 500, duration: 10_000 }, sdeBuild: SDE });
      expect(((await (await fetch(`${stats.url}prop-mod?module=12058`)).json()) as { propMod: { name: string } }).propMod.name).toBe('10MN Afterburner II');
      expect((await fetch(`${stats.url}prop-mod?module=${encodeURIComponent('50MN Nothing II')}`)).status).toBe(404);
      expect((await fetch(`${stats.url}prop-mod?module=mwd`)).status).toBe(400);
      expect((await fetch(`${stats.url}prop-mod`)).status).toBe(400);
    } finally {
      await stats.Stop();
    }
    const unprepared = await StartHub({ shipData: MakeFakeShipData(UnpreparedSdeRoutes('42', 12084)).shipData });
    try {
      expect((await fetch(`${unprepared.url}prop-mod?module=12084`)).status).toBe(503);
    } finally {
      await unprepared.Stop();
    }
  });

  it('the audio routes stream tools-core, forwarding Range', async () => {
    const bank = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const seen: { url: string; range?: string }[] = [];
    const upstream = createServer((request, response) => {
      seen.push({ url: request.url ?? '', range: request.headers.range });
      if (request.url?.endsWith('/audio/library')) {
        response.writeHead(200, { 'content-type': 'application/json', etag: '"lib"' });
        response.end('{"metadata":{"SoundBanks":[]}}');
      } else if (request.headers.range === 'bytes=16-31') {
        response.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': 'bytes 16-31/256', 'content-length': '16', 'accept-ranges': 'bytes' });
        response.end(bank.subarray(16, 32));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    audioUpstream = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    try {
      const library = await fetch(`${hub.url}audio/library`);
      expect(library.status).toBe(200);
      expect(library.headers.get('etag')).toBe('"lib"');
      expect(await library.json()).toEqual({ metadata: { SoundBanks: [] } });
      const resPath = 'res:/audio/essential_media/boosters.bnk';
      const part = await fetch(`${hub.url}audio/path/${encodeURIComponent(resPath)}`, { headers: { range: 'bytes=16-31' } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe('bytes 16-31/256');
      expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...bank.subarray(16, 32)]);
      expect(seen.at(-1)).toEqual({ url: `/eve/1234/audio/path/${encodeURIComponent(resPath)}`, range: 'bytes=16-31' });
      expect((await fetch(`${hub.url}audio/path/${encodeURIComponent('res:/audio/missing.bnk')}`)).status).toBe(404);
    } finally {
      audioUpstream = 'http://127.0.0.1:9';
      await new Promise((resolve) => upstream.close(resolve));
    }
    expect((await fetch(`${hub.url}audio/library`)).status).toBe(502);
  });
});

describe('fleet compositions', () => {
  it('add_fleet_composition resolves hull names, then forwards one patch_scene op to the tab', async () => {
    const fleets = await StartHub({ shipData: MakeFakeShipData().shipData });
    const patches: Record<string, unknown>[] = [];
    const page = await ConnectPage(
      {
        patch_scene: (args) => {
          patches.push(args);
          return applySceneOperations(createEmptyScene(), args['operations']);
        }
      },
      fleets
    );
    try {
      const status = (await fleets.Call('viewer_status')) as { fleetsDirectory: string };
      expect(status.fleetsDirectory).toBe(fleets.fleetCompositions.files.directory);
      const result = (await fleets.Call('add_fleet_composition', { composition: { id: 'g', commander: { hull: 'Guardian' } }, position: [0, 0, 0], heading: 90 })) as { added: unknown; hulls: unknown[] };
      expect(patches).toHaveLength(1);
      const operations = patches[0]['operations'] as Record<string, unknown>[];
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({ op: 'add_fleet_composition', position: [0, 0, 0], heading: 90, composition: { commander: { hull: 'Guardian', dna: 'ac3_t2:carthum:amarr', radius: 80 } } });
      expect(result.added).toEqual({ fleet: 'g', commander: 'g-fc', ships: ['g-fc'] });
      expect(result.hulls).toEqual([{ hull: 'Guardian', typeID: 11987, dna: 'ac3_t2:carthum:amarr', radius: 80, dnaFrom: 'sde', radiusFrom: 'sde' }]);

      const named = (await fleets.Call('add_fleet_composition', { composition: { id: 'p', commander: { hull: 'Guardian', propMod: '10MN AB II' }, wings: [{ id: 'w', squads: [{ id: 's', role: 'dps', ships: [{ hull: 'Guardian', propMod: '10MN Nothing II' }] }] }] }, position: [0, 0, 5000] })) as {
        propMods: unknown[];
        warnings: string[];
      };
      expect(named.propMods).toEqual([
        { module: '10MN AB II', typeID: 12058, name: '10MN Afterburner II', from: 'sde' },
        { module: '10MN Nothing II', from: 'unknown', note: 'no propulsion module is named "10MN Nothing II"' }
      ]);
      expect(named.warnings).toContain('prop mod "10MN Nothing II" is not a propulsion module in the EVE data (no propulsion module is named "10MN Nothing II"); those ships fly the hull-sized default');
    } finally {
      page.close();
      await fleets.Stop();
    }
  });

  it('add_fleet_composition with no tab and no scene says to open the viewer or pass scene', async () => {
    await expect(hub.Call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0] })).rejects.toThrow(/No viewer tab is connected\. Open http.*Or pass "scene"/su);
  });
});

describe('locations', () => {
  const ORIGIN = [-107303331552.681, -18744969943.288, 436488926028.301];

  it('GET /map/system answers origin-relative celestials, nearest first', async () => {
    const located = await StartHub({ mapData: MakeFakeMapData().mapData });
    try {
      const response = await fetch(`${located.url}map/system?id=30000142&origin=${ORIGIN.map(String).join(',')}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const answer = (await response.json()) as { celestials: { id: number; distance: number; position: number[] }[]; origin: number[] };
      expect(answer.origin).toEqual(ORIGIN);
      expect(answer.celestials[0].id).toBe(60003760);
      expect(Math.abs(answer.celestials[0].distance - 130000)).toBeLessThanOrEqual(1e-3);
      const [x, y, z] = answer.celestials[0].position;
      expect(Math.abs(Math.sqrt(x * x + y * y + z * z) - answer.celestials[0].distance)).toBeLessThanOrEqual(1e-6);
      expect((await fetch(`${located.url}map/system?id=abc`)).status).toBe(400);
      expect((await fetch(`${located.url}map/system?id=30000142&origin=1,2`)).status).toBe(400);
      expect((await fetch(`${located.url}map/system?id=30000142&origin=1.3e17,0,0`)).status).toBe(400);
      expect((await fetch(`${located.url}map/system?id=123`)).status).toBe(404);
    } finally {
      await located.Stop();
    }
  });

  it('GET /map/system without a prepared SDE is a 503', async () => {
    const unprepared = await StartHub({ mapData: MakeUnpreparedMapData() });
    try {
      const response = await fetch(`${unprepared.url}map/system?id=30000142`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ failure: 'unavailable', error: { message: expect.stringMatching(/cjs-sde-prepare/u) } });
    } finally {
      await unprepared.Stop();
    }
  });

  it('set_location resolves the celestial, then forwards one patch_scene to the tab', async () => {
    const located = await StartHub({ mapData: MakeFakeMapData().mapData });
    const patches: Record<string, unknown>[] = [];
    const page = await ConnectPage(
      {
        patch_scene: (args) => {
          patches.push(args);
          return applySceneOperations(createEmptyScene(), args['operations']);
        }
      },
      located
    );
    try {
      const result = (await located.Call('set_location', { celestial: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', range: 30000 })) as Record<string, unknown>;
      expect(patches).toHaveLength(1);
      expect((patches[0]['operations'] as { op: string }[]).map((operation) => operation.op)).toEqual(['set_location']);
      expect(result).toMatchObject({ location: { system: 30000142, anchor: { celestial: 60003760 } }, celestial: { id: 60003760 }, scene: { location: { system: 30000142 } } });
    } finally {
      page.close();
      await located.Stop();
    }
  });
});
