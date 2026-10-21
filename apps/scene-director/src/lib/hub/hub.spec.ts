import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ToContent } from '../mcp/server';
import { Hub } from './hub';
import { SceneFileStore } from '../store/scene-files';
import { RemoteHub } from './remote-hub';
import { ToolError } from './tool-call';
import type { ToolsCoreApi } from './tools-core';

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

/** A hub on a free port whose saved scene files go to a fresh temp directory. */
async function StartHub(): Promise<Hub> {
  const scenes = new SceneFileStore(await mkdtemp(path.join(os.tmpdir(), 'scene-director-hub-')));
  return new Hub({ port: 0, toolsCore, viewerDirectory: VIEWER_SOURCE, scenes, log: () => undefined }).Start();
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
