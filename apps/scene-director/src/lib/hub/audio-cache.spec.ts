import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudioBankCache } from './audio-cache';

const BANK = Uint8Array.from({ length: 1000 }, (_unused, index) => index % 251);

/** A tools-core stand-in serving one bank whole (no ranges), counting its reads; `status` overrides the answer. */
async function Upstream(state: { reads: number; status: number }): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    state.reads++;
    if (state.status !== 200) {
      response.writeHead(state.status);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(BANK.length), etag: '"bank"' });
    response.end(BANK);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/eve/1234/audio/path/${encodeURIComponent('res:/audio/essential_media/turrets.bnk')}` };
}

/** A hub stand-in answering every request through the cache, 599 when it does not serve it. */
async function Front(cache: AudioBankCache, url: string): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    void cache.Serve({ url, range: request.headers.range ?? '', response }).then((served) => {
      if (served) return;
      response.writeHead(599);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

describe('AudioBankCache', () => {
  let directory: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'scene-director-audio-cache-'));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  async function Start(state: { reads: number; status: number }): Promise<{ readonly front: string; readonly cache: AudioBankCache }> {
    const upstream = await Upstream(state);
    const cache = new AudioBankCache({ directory });
    const front = await Front(cache, upstream.url);
    servers.push(upstream.server, front.server);
    return { front: front.url, cache };
  }

  it('downloads a bank once, then serves every range from its copy', async () => {
    const state = { reads: 0, status: 200 };
    const { front } = await Start(state);
    const [first, second] = await Promise.all([fetch(front, { headers: { range: 'bytes=16-31' } }), fetch(front, { headers: { range: 'bytes=990-' } })]);
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe('bytes 16-31/1000');
    expect(first.headers.get('etag')).toBe('"bank"');
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([...BANK.subarray(16, 32)]);
    expect(second.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([...BANK.subarray(990)]);
    expect((await fetch(front, { headers: { range: 'bytes=500-2000' } })).headers.get('content-range')).toBe('bytes 500-999/1000');
    expect((await fetch(front, { headers: { range: 'bytes=1000-1010' } })).status).toBe(416);
    expect(state.reads).toBe(1);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('keeps nothing from a failed download and tries again on the next read', async () => {
    const state = { reads: 0, status: 503 };
    const { front } = await Start(state);
    expect((await fetch(front, { headers: { range: 'bytes=0-9' } })).status).toBe(599);
    expect(await readdir(directory)).toEqual([]);
    state.status = 200;
    const retry = await fetch(front, { headers: { range: 'bytes=0-9' } });
    expect(retry.status).toBe(206);
    expect(state.reads).toBe(2);
  });

  it('leaves a Range it does not serve to the proxy', async () => {
    const state = { reads: 0, status: 200 };
    const { front } = await Start(state);
    expect((await fetch(front, { headers: { range: 'bytes=0-9,20-29' } })).status).toBe(599);
    expect((await fetch(front)).status).toBe(599);
    expect(state.reads).toBe(0);
  });

  it('reuses a copy across caches and downloads again when its data is gone', async () => {
    const state = { reads: 0, status: 200 };
    await (await fetch((await Start(state)).front, { headers: { range: 'bytes=0-9' } })).arrayBuffer();
    const again = await Start(state);
    expect((await fetch(again.front, { headers: { range: 'bytes=0-9' } })).status).toBe(206);
    expect(state.reads).toBe(1);
    for (const name of await readdir(directory)) if (name.endsWith('.bin')) await rm(path.join(directory, name));
    const fresh = await Start(state);
    expect([...new Uint8Array(await (await fetch(fresh.front, { headers: { range: 'bytes=5-9' } })).arrayBuffer())]).toEqual([...BANK.subarray(5, 10)]);
    expect(state.reads).toBe(2);
  });
});
