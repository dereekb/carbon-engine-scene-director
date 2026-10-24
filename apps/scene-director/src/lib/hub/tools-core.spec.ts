import { describe, expect, it } from 'vitest';
import { NO_TOOLS_CORE_HINT, SHARED_TOOLS_CORE_HINT, ToolsCore } from './tools-core';

/** A fetch stand-in whose answer to /eve/latest/build the test switches. */
function FakeFetch(): { fetch: typeof fetch; answer: (build: string | Error) => void; calls: string[] } {
  let next: string | Error = '1234';
  const calls: string[] = [];
  const fake = async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input));
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ build: next }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fake as typeof fetch, answer: (build) => (next = build), calls };
}

describe('ToolsCore.Status', () => {
  it('reports tools-core reachable with the build it answers', async () => {
    const fake = FakeFetch();
    const status = await new ToolsCore({ url: 'http://tools-core.test', fetch: fake.fetch }).Status();
    expect(status).toEqual({ reachable: true, url: 'http://tools-core.test', build: '1234' });
  });

  it('probes again after the build is resolved, and reports a tools-core that went down', async () => {
    const fake = FakeFetch();
    const toolsCore = new ToolsCore({ url: 'http://tools-core.test', fetch: fake.fetch });
    await toolsCore.ResolveBuild();
    fake.answer(new TypeError('fetch failed'));
    const status = await toolsCore.Status();
    expect(status.reachable).toBe(false);
    expect(status.build).toBe('1234');
    expect(status.error).toContain('fetch failed');
    expect(fake.calls).toHaveLength(2);
    expect(status.error?.endsWith(NO_TOOLS_CORE_HINT)).toBe(true);
    expect(NO_TOOLS_CORE_HINT).toContain('--eve-data off');
  });

  it('keeps the pinned build and reports the one tools-core moved on to', async () => {
    const fake = FakeFetch();
    const toolsCore = new ToolsCore({ url: 'http://tools-core.test', build: '1234', fetch: fake.fetch });
    fake.answer('5678');
    const status = await toolsCore.Status();
    expect(status).toEqual({ reachable: true, url: 'http://tools-core.test', build: '1234', latestBuild: '5678' });
    expect(await toolsCore.ResourceUrl('graphics/a.dds')).toBe('http://tools-core.test/eve/1234/resources/graphics/a.dds');
  });
});

describe('ToolsCore with a token', () => {
  it('sends it as a Bearer header on every request, through its fetch too', async () => {
    const seen: (string | null)[] = [];
    const fake = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ build: '1234' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const toolsCore = new ToolsCore({ url: 'https://dbxpc.local:5521/tools-core/', token: 's3cret', fetch: fake });
    expect(toolsCore.url).toBe('https://dbxpc.local:5521/tools-core');
    await toolsCore.ResolveBuild();
    await toolsCore.fetch(await toolsCore.ResourceUrl('graphics/a.dds'), { headers: { range: 'bytes=0-1' } });
    expect(seen).toEqual(['Bearer s3cret', 'Bearer s3cret']);
    await new ToolsCore({ url: 'http://tools-core.test', fetch: fake }).ResolveBuild();
    expect(seen.at(-1)).toBeNull();
  });

  it('names the token when the hub sharing tools-core refuses it', async () => {
    const refused = (async () => new Response('needs its access token', { status: 401 })) as typeof fetch;
    const status = await new ToolsCore({ url: 'https://dbxpc.local:5521/tools-core', token: 'wrong', fetch: refused }).Status();
    expect(status.reachable).toBe(false);
    expect(status.error).toMatch(/HTTP 401: the hub sharing it refused the access token \(--tools-core-token/);
    expect(status.error?.endsWith(SHARED_TOOLS_CORE_HINT)).toBe(true);
  });
});
