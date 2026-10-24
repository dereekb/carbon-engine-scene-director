import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ToContent } from '../mcp/server';
import { Hub, type HubOptions } from './hub';
import { applySceneOperations, createEmptyScene, encodeExportPacket, exportBytesToBase64, type MovieExportPlan, type MovieExportStatus, type MovieRecordPlan } from '@scene-director/scene';
import { FleetCompositionFileStore } from '../store/composition-files';
import { FleetPersonalityFileStore } from '../store/personality-files';
import { SceneFileStore } from '../store/scene-files';
import { MovieFileStore } from '../store/movie-files';
import { ReadMp4 } from './mp4-reader.testing';
import { RemoteHub } from './remote-hub';
import { ToolError } from './tool-call';
import { MakeFakeShipData, SDE, TFI_DNA, UnpreparedSdeRoutes } from './ship-data.testing';
import { MakeFakeMapData, MakeUnpreparedMapData } from './map-data.testing';
import type { ToolsCoreApi } from './tools-core';
import { MakeFakeObjectData } from './object-data.testing';
import { MakeFakeAsteroidData } from './asteroid-data.testing';
import { MakeFakeDogmaData } from './dogma-data.testing';
import { MakeFakeWeaponData } from './weapon-data.testing';
import { AudioBankCache } from './audio-cache';

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

/** A hub on a free port whose saved scene, fleet composition, fleet personality and movie files go to fresh temp directories. */
async function StartHub(options: Partial<HubOptions> = {}): Promise<Hub> {
  const scenes = new SceneFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-hub-')));
  const compositions = new FleetCompositionFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-fleets-')));
  const personalities = new FleetPersonalityFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-personalities-')));
  const movies = new MovieFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-movies-')));
  return new Hub({ port: 0, toolsCore, viewerDirectory: VIEWER_SOURCE, scenes, compositions, personalities, movies, log: () => undefined, ...options }).Start();
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

  it('a page calls hub tools over its link; page tools and unknown tools are refused', async () => {
    const page = await ConnectPage({});
    const replies = new Map<number, { ok: boolean; value?: unknown; error?: { message: string; problems?: string[] } }>();
    page.on('message', (data) => {
      const message = JSON.parse(String(data)) as { type: string; id: number; ok: boolean; value?: unknown; error?: { message: string } };
      if (message.type === 'result') replies.set(message.id, message);
    });
    async function CallFromPage(id: number, name: string, args: Record<string, unknown> = {}) {
      page.send(JSON.stringify({ type: 'call', id, name, args }));
      await expect.poll(() => replies.has(id)).toBe(true);
      return replies.get(id);
    }
    try {
      expect(await CallFromPage(1, 'search_hulls', { query: 'af1' })).toEqual({ type: 'result', id: 1, ok: true, value: { kind: 'hulls', total: 2, names: ['af1_t1', 'af1_t2'] } });
      const staged = await CallFromPage(2, 'stage_engagement', {
        scene: { name: 'from the page' },
        sides: [
          { ships: [{ dna: TFI_DNA, count: 2 }], fleet: 'blue' },
          { ships: [{ dna: TFI_DNA, count: 2 }], fleet: 'red', team: 'red' }
        ],
        range: 20000
      });
      const result = staged?.value as { loaded: boolean; scene: { ships: { id: string }[] } };
      expect(staged?.ok).toBe(true);
      expect(result.loaded).toBe(false);
      expect(result.scene.ships).toHaveLength(4);
      const pageTool = await CallFromPage(3, 'get_state');
      expect(pageTool?.ok).toBe(false);
      expect(pageTool?.error?.message).toMatch(/"get_state" is a page tool/);
      expect((await CallFromPage(4, 'no_such_tool'))?.error?.message).toMatch(/unknown tool "no_such_tool"/);
    } finally {
      page.close();
    }
  });

  it('serves the battle console under /console/ with an index fallback, and nothing outside its directory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'scene-director-console-'));
    await writeFile(path.join(directory, 'index.html'), '<base href="/console/"><app-root></app-root>');
    await writeFile(path.join(directory, 'main.js'), 'export {};');
    await writeFile(path.join(directory, 'styles.css'), 'body {}');
    await mkdir(path.join(directory, 'media'));
    await writeFile(path.join(directory, 'media', 'symbols.woff2'), 'w');
    const withConsole = await StartHub({ consoleDirectory: directory });
    const base = `http://127.0.0.1:${withConsole.port}`;
    try {
      for (const route of ['/console/', '/console', '/console/fleets/blue']) {
        const index = await fetch(base + route);
        expect([route, index.status, index.headers.get('content-type')]).toEqual([route, 200, 'text/html; charset=utf-8']);
        expect(await index.text()).toMatch(/<app-root>/);
      }
      const types = await Promise.all(['/console/main.js', '/console/styles.css', '/console/media/symbols.woff2'].map(async (route) => (await fetch(base + route)).headers.get('content-type')));
      expect(types).toEqual(['text/javascript; charset=utf-8', 'text/css; charset=utf-8', 'font/woff2']);
      expect((await fetch(`${base}/console/missing.js`)).status).toBe(404);
      expect((await fetch(`${base}/console/..%2F..%2Fpackage.json`)).status).toBe(404);
      const viewer = await fetch(`${base}/`);
      expect(await viewer.text()).toMatch(/<canvas id="view">/);
    } finally {
      await withConsole.Stop();
    }
    const none = await fetch(`http://127.0.0.1:${hub.port}/console/`);
    expect(none.status).toBe(404);
    expect(await none.text()).toMatch(/--console/);
  });

  it('screenshot values become MCP image content', () => {
    const content = ToContent({ image: { data: 'iVBORw0KGgo=', mimeType: 'image/png' }, width: 2, height: 1 });
    expect(content.content[0]).toMatchObject({ type: 'image', data: 'iVBORw0KGgo=' });
    expect(JSON.parse((content.content[1] as { text: string }).text)).toEqual({ width: 2, height: 1 });
    expect(ToContent({ a: 1 }).content[0].type).toBe('text');
  });
});

describe('objects', () => {
  it('search_objects and add_objects are hub tools over the injected object data', async () => {
    const objectsHub = await StartHub({ objectData: MakeFakeObjectData().objectData });
    try {
      const answer = (await objectsHub.Call('search_objects', { query: 'Astrahus', limit: 1 })) as { items: { name: string }[] };
      expect(answer.items.map((item) => item.name)).toEqual(['Astrahus']);
      const added = (await objectsHub.Call('add_objects', { scene: { name: 'x' }, type: 'Astrahus', id: 'astra' })) as { added: { id: string; radius: number }[]; loaded: boolean };
      expect(added).toMatchObject({ added: [{ id: 'astra', radius: 45000 }], loaded: false });
    } finally {
      await objectsHub.Stop();
    }
  });

  it('add_asteroid_field is a hub tool over the injected asteroid data', async () => {
    const fieldsHub = await StartHub({ asteroidData: MakeFakeAsteroidData().asteroidData });
    try {
      const added = (await fieldsHub.Call('add_asteroid_field', { scene: { name: 'x' }, ores: ['Veldspar'], id: 'belt', count: 40 })) as { added: { id: string; placed: number }; loaded: boolean };
      expect(added).toMatchObject({ added: { id: 'belt', placed: 40 }, loaded: false });
    } finally {
      await fieldsHub.Stop();
    }
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

describe('fit routes', () => {
  it('GET /fit/type, /dogma/types and /dogma/skills answer from DogmaData and map failures', async () => {
    const fits = await StartHub({ shipData: MakeFakeShipData().shipData, dogmaData: MakeFakeDogmaData() });
    try {
      expect(await (await fetch(`${fits.url}fit/type?name=${encodeURIComponent('Warp Scrambler II')}&hull=Rifter`)).json()).toEqual({ typeID: 448, name: 'Warp Scrambler II', groupID: 52, categoryID: 7, category: 'module', slot: 'mid' });
      expect((await fetch(`${fits.url}fit/type?name=${encodeURIComponent('No Such Thing')}`)).status).toBe(404);
      const bundle = (await (await fetch(`${fits.url}dogma/types?ids=2048,587`)).json()) as { types: Record<string, unknown>; sdeBuild: string };
      expect(Object.keys(bundle.types)).toEqual(['587', '2048']);
      expect(bundle.sdeBuild).toBe(SDE);
      expect((await fetch(`${fits.url}dogma/types?ids=abc`)).status).toBe(400);
      expect((await fetch(`${fits.url}dogma/types`)).status).toBe(400);
      expect(Object.keys(((await (await fetch(`${fits.url}dogma/skills`)).json()) as { types: object }).types)).toHaveLength(512);
    } finally {
      await fits.Stop();
    }
  });

  it('GET /weapon answers a weapon graphic and maps failures', async () => {
    const weapons = await StartHub({ shipData: MakeFakeShipData().shipData, weaponData: MakeFakeWeaponData() });
    try {
      expect(await (await fetch(`${weapons.url}weapon?type=2929`)).json()).toMatchObject({ typeID: 2929, name: '800mm Repeating Cannon II', kind: 'turret', slot: 'turrets', size: 3, sofFactionName: 'brutor' });
      const missing = await fetch(`${weapons.url}weapon?type=448`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ failure: 'not-found' });
      expect((await fetch(`${weapons.url}weapon?type=abc`)).status).toBe(400);
      expect((await fetch(`${weapons.url}weapon`)).status).toBe(400);
    } finally {
      await weapons.Stop();
    }
  });

  it('GET /missile answers a missile graphic and maps failures', async () => {
    const weapons = await StartHub({ shipData: MakeFakeShipData().shipData, weaponData: MakeFakeWeaponData() });
    try {
      expect(await (await fetch(`${weapons.url}missile?charge=209&launcher=2410`)).json()).toEqual({
        chargeTypeID: 209,
        name: 'Scourge Heavy Missile',
        launcherTypeID: 2410,
        impactResPath: 'res:/dx9/model/turret/launcher/heavy/heavy_impact_scourge.black',
        projectileGraphicID: 21936,
        projectileResPath: 'res:/dx9/model/turret/launcher/heavy/heavy_missile.black'
      });
      const wrong = await fetch(`${weapons.url}missile?charge=209&launcher=2404`);
      expect(wrong.status).toBe(404);
      expect(await wrong.json()).toMatchObject({ failure: 'not-found' });
      expect((await fetch(`${weapons.url}missile?charge=209`)).status).toBe(400);
      expect((await fetch(`${weapons.url}missile?charge=x&launcher=2410`)).status).toBe(400);
    } finally {
      await weapons.Stop();
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

  it('an audio body cut short upstream ends that response, not the hub', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-255/256', 'content-length': '256' });
      response.write(Buffer.alloc(16));
      setTimeout(() => response.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    audioUpstream = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    try {
      const cut = await fetch(`${hub.url}audio/path/${encodeURIComponent('res:/audio/essential_media/turrets.bnk')}`, { headers: { range: 'bytes=0-255' } });
      await expect(cut.arrayBuffer()).rejects.toThrow();
      expect((await fetch(`${hub.url}audio/library`)).status).toBe(206);
    } finally {
      audioUpstream = 'http://127.0.0.1:9';
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  it('the audio routes serve ranges from the audio cache, downloading a bank once', async () => {
    const bank = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const seen: (string | undefined)[] = [];
    const upstream = createServer((request, response) => {
      seen.push(request.headers.range);
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '256' });
      response.end(bank);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    audioUpstream = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const cached = await StartHub({ audioCache: new AudioBankCache({ directory: await mkdtemp(path.join(os.tmpdir(), 'scene-director-hub-audio-')) }) });
    try {
      const resPath = encodeURIComponent('res:/audio/essential_media/turrets.bnk');
      for (const range of ['bytes=16-31', 'bytes=240-255']) {
        const part = await fetch(`${cached.url}audio/path/${resPath}`, { headers: { range } });
        expect(part.status).toBe(206);
        const [from, to] = range.slice('bytes='.length).split('-').map(Number);
        expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([...bank.subarray(from, to + 1)]);
      }
      expect(seen).toEqual([undefined]);
      // A read without Range is proxied as before.
      expect((await fetch(`${cached.url}audio/path/${resPath}`)).status).toBe(200);
      expect(seen).toEqual([undefined, undefined]);
    } finally {
      await cached.Stop();
      audioUpstream = 'http://127.0.0.1:9';
      await new Promise((resolve) => upstream.close(resolve));
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

  it('set_fleet_personality embeds a saved personality and sets the fleet in one patch_scene to the tab', async () => {
    const live = applySceneOperations(createEmptyScene(), [{ op: 'add_ships', dna: 'ac3_t2:carthum:amarr', count: 2, fleet: { new: true, id: 'g' } }]).scene;
    const patches: Record<string, unknown>[] = [];
    const page = await ConnectPage(
      {
        get_scene: () => live,
        patch_scene: (args) => {
          patches.push(args);
          return applySceneOperations(live, args['operations']);
        }
      },
      hub
    );
    try {
      const status = (await hub.Call('viewer_status')) as { personalitiesDirectory: string };
      expect(status.personalitiesDirectory).toBe(hub.fleetPersonalities.files.directory);
      await hub.Call('save_fleet_personality', { personality: { schema: 'cjs-fleet-personality/1', id: 'hub-kiter', extends: 'kiter' } });
      const result = (await hub.Call('set_fleet_personality', { fleet: 'g', personality: 'hub-kiter' })) as { personality: object; scene: { fleets: { personality?: string }[] } };
      expect(patches.map((patch) => (patch['operations'] as { op: string }[]).map((operation) => operation.op))).toEqual([['set_personalities', 'update_fleet']]);
      expect(result.personality).toEqual({ name: 'hub-kiter', from: 'disk', chain: ['hub-kiter', 'kiter', 'line'], embedded: ['hub-kiter'] });
      expect(result.scene.fleets[0].personality).toBe('hub-kiter');
      expect(((await hub.Call('get_fleet_personality', { name: 'hub-kiter' })) as { store: string }).store).toBe('disk');
      expect(((await hub.Call('delete_fleet_personality', { name: 'hub-kiter' })) as { deleted: boolean }).deleted).toBe(true);
    } finally {
      page.close();
    }
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

/** A page's plan for a small export. */
function ExportPlan(frames: number): MovieExportPlan {
  return {
    source: 'slate',
    from: 0,
    to: frames / 10,
    seconds: frames / 10,
    frames,
    fps: 10,
    width: 320,
    height: 180,
    picture: { x: 0, y: 23, width: 320, height: 134 },
    letterbox: 2.39,
    codec: 'h264',
    codecString: 'avc1.64001F',
    bitrate: 500000,
    quality: 'standard',
    hardware: 'no-preference',
    restart: true,
    timeline: true,
    preroll: { seconds: 0, frames: 0 },
    keyframeEvery: 20
  };
}

/** Waits until the hub's export status satisfies a check. */
async function ExportStatus(target: Hub, done: (status: MovieExportStatus) => boolean): Promise<MovieExportStatus> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = (await target.Call('export_movie')) as MovieExportStatus;
    if (done(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the export status never got there');
}

describe('movie export', () => {
  const AVCC = new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0]);

  /** A page that arms an export and records the export messages the hub sends it. */
  async function ExportPage(target: Hub, handlers: Record<string, Handler> = {}): Promise<{ ws: WebSocket; calls: Record<string, unknown>[]; hubMessages: Record<string, unknown>[] }> {
    const calls: Record<string, unknown>[] = [];
    const hubMessages: Record<string, unknown>[] = [];
    const ws = await ConnectPage(
      {
        export_movie: (args) => {
          calls.push(args);
          return args['action'] === 'start' ? { id: args['id'], state: 'preparing', plan: ExportPlan(30), scene: 'Duel at Jita', warnings: ['a page warning'] } : { state: 'cancelled' };
        },
        ...handlers
      },
      target
    );
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message['type'] === 'export') hubMessages.push(message);
    });
    return { ws, calls, hubMessages };
  }

  function Report(id: string, state: string, frame: number): Record<string, unknown> {
    return {
      id,
      state,
      plan: ExportPlan(30),
      frame,
      frames: 30,
      progress: frame / 30,
      time: frame / 10,
      rate: { fps: 30, realtime: 3 },
      eta: 0,
      encoder: { queue: 0, chunks: frame, keyFrames: 2, bytes: frame * 50 },
      frameMs: { mean: 2, max: 4, retries: 0 },
      startedAt: new Date().toISOString(),
      wallSeconds: 1,
      gpuErrors: 0,
      warnings: []
    };
  }

  it('status answers idle with no tab, and start with no tab explains what to open', async () => {
    const fresh = await StartHub();
    try {
      expect(await fresh.Call('export_movie')).toMatchObject({ state: 'idle' });
      await expect(fresh.Call('export_movie', { action: 'start', source: 'slate' })).rejects.toThrow(/No viewer tab is connected/);
      await expect(fresh.Call('export_movie', { action: 'cancel' })).rejects.toThrow(/no movie export is running/);
      await expect(fresh.Call('export_movie', { action: 'start', width: 321 })).rejects.toThrow(/width must be pixels/);
    } finally {
      await fresh.Stop();
    }
  });

  it("writes the page's chunks to an MP4 the /movies route serves with Range", async () => {
    const target = await StartHub();
    const { ws, calls, hubMessages } = await ExportPage(target);
    try {
      const started = (await target.Call('export_movie', { action: 'start', source: 'slate', fps: 10, width: 320, height: 180 })) as { id: string; file: { path: string; url: string }; warnings: string[] };
      expect(calls[0]).toMatchObject({ action: 'start', id: started.id, fps: 10, source: 'slate' });
      expect(path.basename(started.file.path)).toMatch(/^duel-at-jita-\d{8}-\d{6}\.mp4$/u);
      expect(started.file.url).toBe(`${target.url}movies/${path.basename(started.file.path)}`);
      expect(started.warnings).toEqual(['a page warning']);
      await expect(target.Call('export_movie', { action: 'start' })).rejects.toThrow(/a movie export is running/);
      ws.send(JSON.stringify({ type: 'export', id: started.id, kind: 'config', track: { codec: 'h264', codecString: 'avc1.64001F', width: 320, height: 180, fps: 10, description: exportBytesToBase64(AVCC) } }));
      for (let seq = 0; seq < 30; seq++) ws.send(encodeExportPacket({ id: started.id, seq, key: seq % 20 === 0, timestamp: seq * 100_000, duration: 100_000 }, new Uint8Array(50).fill(seq)));
      ws.send(JSON.stringify({ type: 'export', id: started.id, kind: 'progress', report: Report(started.id, 'rendering', 30) }));
      ws.send(JSON.stringify({ type: 'export', id: started.id, kind: 'end', report: Report(started.id, 'finishing', 30) }));
      const status = await ExportStatus(target, (entry) => entry.state === 'done');
      expect(status).toMatchObject({ id: started.id, frame: 30, result: { frames: 30, seconds: 3, fps: 10, width: 320, height: 180, path: started.file.path } });
      expect(hubMessages.at(-1)).toMatchObject({ kind: 'saved', id: started.id, file: { path: started.file.path } });
      const mp4 = ReadMp4(new Uint8Array(await readFile(started.file.path)));
      expect(mp4.samples).toHaveLength(30);
      expect(mp4.stss).toEqual([1, 21]);
      expect([...mp4.samples[7]]).toEqual(new Array(50).fill(7));
      const full = await fetch(started.file.url);
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('video/mp4');
      expect((await full.arrayBuffer()).byteLength).toBe(mp4.boxes.at(-1)!.offset + mp4.boxes.at(-1)!.size);
      const ranged = await fetch(started.file.url, { headers: { range: 'bytes=0-99' } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-99\//u);
      expect((await ranged.arrayBuffer()).byteLength).toBe(100);
      expect((await fetch(started.file.url, { headers: { range: 'bytes=99999999-' } })).status).toBe(416);
      const head = await fetch(started.file.url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('accept-ranges')).toBe('bytes');
      expect((await fetch(`${target.url}movies/nothing.mp4`)).status).toBe(404);
      expect((await fetch(`${target.url}movies/..%2Fhub.spec.ts`)).status).toBe(404);
      expect(((await target.Call('viewer_status')) as { moviesDirectory: string }).moviesDirectory).toBe(path.dirname(started.file.path));
    } finally {
      ws.close();
      await target.Stop();
    }
  });

  it("cancel reaches the export's own tab and deletes the part", async () => {
    const target = await StartHub();
    const first = await ExportPage(target);
    const second = await ExportPage(target);
    try {
      second.ws.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = (await target.Call('export_movie', { action: 'start', source: 'slate' })) as { id: string; file: { path: string } };
      first.ws.send(JSON.stringify({ type: 'export', id: started.id, kind: 'config', track: { codec: 'h264', codecString: 'avc1.64001F', width: 320, height: 180, fps: 10, description: exportBytesToBase64(AVCC) } }));
      first.ws.send(encodeExportPacket({ id: started.id, seq: 0, key: true, timestamp: 0, duration: 100_000 }, new Uint8Array(10)));
      const third = await ExportPage(target);
      const cancelled = (await target.Call('export_movie', { action: 'cancel' })) as MovieExportStatus;
      expect(cancelled.state).toBe('cancelled');
      expect(first.calls.at(-1)).toEqual({ action: 'cancel', id: started.id });
      expect(third.calls).toEqual([]);
      expect(await readdir(path.dirname(started.file.path))).toEqual([]);
      third.ws.close();
    } finally {
      first.ws.close();
      await target.Stop();
    }
  });

  it('the tab closing fails it and deletes the part; a page failure keeps its error; a lost chunk fails it', async () => {
    const target = await StartHub();
    try {
      const closing = await ExportPage(target);
      const started = (await target.Call('export_movie', { action: 'start', source: 'slate' })) as { id: string; file: { path: string } };
      closing.ws.close();
      const closed = await ExportStatus(target, (entry) => entry.state === 'failed');
      expect(closed).toMatchObject({ error: 'the viewer tab closed or reloaded during the export' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await readdir(path.dirname(started.file.path))).toEqual([]);

      const failing = await ExportPage(target);
      const again = (await target.Call('export_movie', { action: 'start', source: 'slate' })) as { id: string };
      failing.ws.send(JSON.stringify({ type: 'export', id: again.id, kind: 'failed', error: 'the encoder failed: boom', report: Report(again.id, 'rendering', 3) }));
      expect(await ExportStatus(target, (entry) => entry.state === 'failed')).toMatchObject({ id: again.id, error: 'the encoder failed: boom' });

      const lossy = (await target.Call('export_movie', { action: 'start', source: 'slate' })) as { id: string };
      failing.ws.send(JSON.stringify({ type: 'export', id: lossy.id, kind: 'config', track: { codec: 'h264', codecString: 'avc1.64001F', width: 320, height: 180, fps: 10, description: exportBytesToBase64(AVCC) } }));
      failing.ws.send(encodeExportPacket({ id: lossy.id, seq: 1, key: true, timestamp: 0, duration: 100_000 }, new Uint8Array(10)));
      expect(await ExportStatus(target, (entry) => entry.state === 'failed')).toMatchObject({ id: lossy.id, error: 'chunk 0 never arrived (chunk 1 came instead)' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(failing.hubMessages.at(-1)).toMatchObject({ kind: 'failed', id: lossy.id });
      failing.ws.close();
    } finally {
      await target.Stop();
    }
  });

  it('a page refusal keeps its problems and leaves no file', async () => {
    const target = await StartHub();
    const { ws } = await ExportPage(target, {
      export_movie: () => {
        throw Object.assign(new Error('Invalid export'), { problems: ['this scene has no timeline: give duration, seconds from now'] });
      }
    });
    try {
      const failure = await target.Call('export_movie', { action: 'start', to: 4 }).catch((error: unknown) => error);
      expect((failure as ToolError).details?.problems).toEqual(['this scene has no timeline: give duration, seconds from now']);
      expect(await target.Call('export_movie')).toMatchObject({ state: 'idle' });
      expect(await readdir(target.movieExports.directory)).toEqual([]);
    } finally {
      ws.close();
      await target.Stop();
    }
  });
});

describe('no EVE data', () => {
  const DNA = 'ac3_t2:carthum:amarr';

  /** A hub with the mode off: the injected fake tools-core must never be asked anything. */
  async function StartNoEveHub(): Promise<{ readonly offHub: Hub; readonly asked: string[] }> {
    const asked: string[] = [];
    const watched = new Proxy(toolsCore, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key !== 'url') asked.push(key);
        return Reflect.get(target, key, receiver) as unknown;
      }
    });
    return { offHub: await StartHub({ eveData: 'off', toolsCore: watched }), asked };
  }

  it('reports the mode in viewer_status, GET /config and the hello reply', async () => {
    const { offHub, asked } = await StartNoEveHub();
    try {
      const status = (await offHub.Call('viewer_status')) as { eveData: { mode: string; note: string }; toolsCore: unknown };
      expect(status.eveData.mode).toBe('off');
      expect(status.eveData.note).toMatch(/--eve-data off/u);
      expect(status.toolsCore).toBeNull();
      const config = (await (await fetch(`${offHub.url}config`)).json()) as { eveData: { mode: string } };
      expect(config.eveData.mode).toBe('off');
      expect(((await (await fetch(`${hub.url}config`)).json()) as { eveData: unknown }).eveData).toEqual({ mode: 'tools-core' });
      const ws = new WebSocket(`ws://127.0.0.1:${offHub.port}/ws`);
      await new Promise((resolve) => ws.once('open', resolve));
      const hello = new Promise<string>((resolve) => ws.once('message', (data) => resolve(String(data))));
      ws.send(JSON.stringify({ type: 'hello', role: 'controller' }));
      expect(JSON.parse(await hello)).toMatchObject({ type: 'hello', hub: { eveData: { mode: 'off' } } });
      ws.close();
      expect(asked).toEqual([]);
    } finally {
      await offHub.Stop();
    }
  });

  it('answers the EVE routes 503 naming the mode, without touching tools-core', async () => {
    const { offHub, asked } = await StartNoEveHub();
    try {
      for (const route of ['resource/x.black', 'resfileindex.txt', 'audio/library', 'audio/path/x', 'build']) {
        const response = await fetch(`${offHub.url}${route}`);
        expect(response.status, route).toBe(503);
        expect(await response.text(), route).toMatch(/--eve-data off/u);
      }
      for (const route of [`ship-stats?dna=${DNA}`, 'map/system?id=30000142', 'prop-mod?module=10MN%20AB%20II', 'fit/type?name=Damage%20Control%20II']) {
        const response = await fetch(`${offHub.url}${route}`);
        expect(response.status, route).toBe(503);
        expect(((await response.json()) as { failure: string }).failure, route).toBe('unavailable');
      }
      expect(asked).toEqual([]);
    } finally {
      await offHub.Stop();
    }
  });

  it('refuses the tools that need EVE data with the mode, not "start tools-core"', async () => {
    const { offHub, asked } = await StartNoEveHub();
    try {
      const calls: [string, Record<string, unknown>][] = [
        ['search_hulls', { query: 'af1' }],
        ['search_map', { query: 'Jita' }],
        ['get_system', { system: 'Jita' }],
        ['set_location', { system: 'Jita', scene: { name: 'x' } }],
        ['search_objects', { query: 'Astrahus' }],
        ['ship_stats', { dna: DNA }],
        ['add_ships', { hull: 'Rifter', scene: { name: 'x' } }],
        ['add_objects', { type: 'Astrahus', scene: { name: 'x' } }],
        ['add_asteroid_field', { ores: ['Veldspar'], scene: { name: 'x' } }]
      ];
      for (const [name, args] of calls) {
        const error = (await offHub.Call(name, args).catch((caught: unknown) => caught)) as Error & { details?: { problems?: string[] } };
        const text = [error.message, ...(error.details?.problems ?? [])].join(' ');
        expect(text, name).toMatch(/--eve-data off/u);
        expect(text, name).not.toMatch(/Start it with|tools-core at/u);
      }
      expect(asked).toEqual([]);
    } finally {
      await offHub.Stop();
    }
  });

  it('runs the tools that need no EVE data', async () => {
    const { offHub, asked } = await StartNoEveHub();
    const page = await ConnectPage({ get_scene: () => createEmptyScene(), patch_scene: (args) => applySceneOperations(createEmptyScene(), args['operations']) }, offHub);
    try {
      const stats = (await offHub.Call('ship_stats', { dna: DNA, stats: { maxVelocity: 300, agility: 3, mass: 1e6, signatureRadius: 40 } })) as { stats: unknown };
      expect(stats).toBeTruthy();
      await expect(offHub.Call('add_ships', { dna: DNA, count: 3 })).resolves.toBeTruthy();
      await expect(offHub.Call('add_fleet_composition', { name: 'tfis', position: [0, 0, 0] })).resolves.toBeTruthy();
      await expect(offHub.Call('add_objects', { dna: 'ahbs_t1:amarrbase:amarr', radius: 5000 })).resolves.toBeTruthy();
      expect(asked).toEqual([]);
    } finally {
      page.close();
      await offHub.Stop();
    }
  });
});

describe('live recording', () => {
  const AVCC = new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0]);
  const RECORD_PLAN: MovieRecordPlan = {
    source: 'slate',
    fps: 10,
    width: 320,
    height: 180,
    picture: { x: 0, y: 0, width: 320, height: 180 },
    letterbox: false,
    codec: 'h264',
    codecString: 'avc1.64001F',
    bitrate: 500000,
    quality: 'standard',
    hardware: 'no-preference',
    keyframeEvery: 20,
    duration: null,
    maxFrames: 36_000
  };

  function RecordReport(id: string, state: string, frame: number): Record<string, unknown> {
    return {
      id,
      state,
      plan: RECORD_PLAN,
      frame,
      seconds: frame / 10,
      sceneSeconds: 5 + frame / 10,
      rate: { fps: 10, realtime: 1 },
      left: 3600 - frame / 10,
      encoder: { queue: 0, chunks: frame, keyFrames: 1, bytes: frame * 50 },
      frameMs: { mean: 100, max: 120, retries: 0 },
      startedAt: new Date().toISOString(),
      wallSeconds: 2,
      gpuErrors: 0,
      warnings: []
    };
  }

  /** A page that arms a recording; its stop answers finishing (then ends the file) unless `empty`. */
  async function RecordPage(target: Hub, { empty = false, save = true }: { readonly empty?: boolean; readonly save?: boolean } = {}) {
    const calls: Record<string, unknown>[] = [];
    let ws: WebSocket | null = null;
    const send = (message: object): void => ws?.send(JSON.stringify(message));
    ws = await ConnectPage(
      {
        record_movie: (args) => {
          calls.push(args);
          const id = String(args['id']);
          if (args['action'] === 'start') return { id, state: 'preparing', plan: RECORD_PLAN, scene: 'Brawl', warnings: [] };
          if (args['action'] === 'cancel') return RecordReport(id, 'cancelled', 0);
          if (empty) {
            send({ type: 'export', id, kind: 'cancelled', report: RecordReport(id, 'cancelled', 0) });
            return RecordReport(id, 'cancelled', 0);
          }
          // The page flushes the encoder, then ends the file: the hub saves it.
          setTimeout(() => {
            send({ type: 'export', id, kind: 'config', track: { codec: 'h264', codecString: 'avc1.64001F', width: 320, height: 180, fps: 10, description: exportBytesToBase64(AVCC) } });
            for (let seq = 0; seq < 12; seq++) ws?.send(encodeExportPacket({ id, seq, key: seq === 0, timestamp: seq * 100_000, duration: 100_000 }, new Uint8Array(50).fill(seq)));
            if (save) send({ type: 'export', id, kind: 'end', report: RecordReport(id, 'finishing', 12) });
          }, 30);
          return RecordReport(id, 'finishing', 12);
        },
        export_movie: (args) => (args['action'] === 'start' ? { id: args['id'], state: 'preparing', plan: ExportPlan(30), scene: 'Duel', warnings: [] } : { state: 'cancelled' })
      },
      target
    );
    return { ws, calls };
  }

  it('stop waits for the saved file and returns the status with its result', async () => {
    const target = await StartHub();
    const { ws, calls } = await RecordPage(target);
    try {
      expect(await target.Call('record_movie')).toMatchObject({ state: 'idle' });
      const started = (await target.Call('record_movie', { action: 'start', source: 'slate', fps: 10, width: 320, height: 180, name: 'Brawl take' })) as { id: string; file: { path: string } };
      expect(started.id).toMatch(/^record-/u);
      expect(path.basename(started.file.path)).toBe('brawl-take.mp4');
      expect(calls[0]).toMatchObject({ action: 'start', id: started.id, fps: 10 });
      const stopped = await target.Call('record_movie', { action: 'stop' });
      expect(calls[1]).toEqual({ action: 'stop', id: started.id });
      expect(stopped).toMatchObject({ id: started.id, state: 'done', frame: 12, result: { frames: 12, seconds: 1.2, fps: 10, path: started.file.path } });
      expect(ReadMp4(new Uint8Array(await readFile(started.file.path))).samples).toHaveLength(12);
      await expect(target.Call('record_movie', { action: 'stop' })).rejects.toThrow(/no live recording is running/);
    } finally {
      ws.close();
      await target.Stop();
    }
  });

  it('runs one session of either kind, and reports each kind its own last session', async () => {
    const target = await StartHub();
    const { ws } = await RecordPage(target);
    try {
      const started = (await target.Call('record_movie', { action: 'start', source: 'slate' })) as { id: string };
      await expect(target.Call('export_movie', { action: 'start', source: 'slate' })).rejects.toThrow(/a live recording is running \(preparing\): record_movie \{ action: "stop" \} ends it/u);
      await expect(target.Call('record_movie', { action: 'start', source: 'slate' })).rejects.toThrow(/a live recording is running/u);
      await expect(target.Call('export_movie', { action: 'cancel' })).rejects.toThrow(/no movie export is running/u);
      expect(await target.Call('export_movie')).toMatchObject({ state: 'idle' });
      expect(await target.Call('record_movie')).toMatchObject({ id: started.id, state: 'preparing', frame: 0, seconds: 0 });
      expect(await target.Call('record_movie', { action: 'cancel' })).toMatchObject({ id: started.id, state: 'cancelled' });
      expect(await readdir(target.movieExports.directory)).toEqual([]);
      const exported = (await target.Call('export_movie', { action: 'start', source: 'slate' })) as { id: string };
      await expect(target.Call('record_movie', { action: 'start', source: 'slate' })).rejects.toThrow(/a movie export is running/u);
      expect(await target.Call('record_movie')).toMatchObject({ id: started.id, state: 'cancelled' });
      expect(await target.Call('export_movie')).toMatchObject({ id: exported.id, state: 'preparing' });
    } finally {
      ws.close();
      await target.Stop();
    }
  });

  it('a stop with nothing recorded ends cancelled; a save that never comes answers still finishing; the tab closing fails it', async () => {
    const target = await StartHub({});
    (target.movieExports as unknown as { options: { stopTimeoutMs: number } }).options.stopTimeoutMs = 200;
    const empty = await RecordPage(target, { empty: true });
    try {
      await target.Call('record_movie', { action: 'start', source: 'slate' });
      expect(await target.Call('record_movie', { action: 'stop' })).toMatchObject({ state: 'cancelled' });
    } finally {
      empty.ws.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const unsaved = await RecordPage(target, { save: false });
    try {
      await target.Call('record_movie', { action: 'start', source: 'slate' });
      expect(await target.Call('record_movie', { action: 'stop' })).toMatchObject({ state: 'finishing', note: 'the file is still being written: record_movie status shows when it is saved' });
      unsaved.ws.close();
      for (let attempt = 0; attempt < 50 && ((await target.Call('record_movie')) as { state: string }).state !== 'failed'; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await target.Call('record_movie')).toMatchObject({ state: 'failed', error: 'the viewer tab closed or reloaded during the recording' });
      expect(await readdir(target.movieExports.directory)).toEqual([]);
    } finally {
      await target.Stop();
    }
  });
});
