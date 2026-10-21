import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ToContent } from '../mcp/server';
import { Hub } from './hub';
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

beforeAll(async () => {
  hub = await new Hub({ port: 0, toolsCore, viewerDirectory: VIEWER_SOURCE, log: () => undefined }).Start();
});

afterAll(async () => {
  await hub.Stop();
});

/** Connects a fake viewer tab that answers tools from `handlers`. */
async function ConnectPage(handlers: Record<string, Handler>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
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
