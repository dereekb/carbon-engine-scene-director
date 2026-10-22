import { type MapCelestial, type MapSystem, type SceneLocation, toMapSystemAnswer } from '@scene-director/scene';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocationLookup, LocationText } from './location';

const ORIGIN: [number, number, number] = [-107303331552.681, -18744969943.288, 436488926028.301];
const CNAP = 'Jita IV - Moon 4 - Caldari Navy Assembly Plant';
const LOCATION: SceneLocation = { system: 30000142, name: 'Jita', region: 'The Forge', origin: ORIGIN, anchor: { celestial: 60003760, name: CNAP, kind: 'station' } };
const SYSTEM: MapSystem = { id: 30000142, name: 'Jita', securityStatus: 0.945913, securityClass: 'B', constellation: null, region: { id: 10000002, name: 'The Forge' }, nebula: null, star: null };
const CELESTIALS: MapCelestial[] = [
  { id: 40009076, kind: 'star', name: 'Jita - Star', typeID: 3796, radius: 513100000, radiusFrom: 'map', position: [0, 0, 0], orbit: null, graphics: {} },
  { id: 60003760, kind: 'station', name: CNAP, typeID: 52678, radius: 100000, radiusFrom: 'type', position: [-107303362560, -18744975360, 436489052160], orbit: null, graphics: {} }
];
const ANSWER = toMapSystemAnswer({ system: SYSTEM, celestials: CELESTIALS, origin: ORIGIN, sdeBuild: '3632936' });

function Respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('LocationLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the system once per system and origin, then reports actual distances', async () => {
    const fetch = vi.fn(() => Promise.resolve(Respond(200, ANSWER)));
    const onChange = vi.fn();
    const lookup = new LocationLookup({ fetch, onChange });
    lookup.Update(LOCATION);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([`/map/system?id=30000142&origin=${ORIGIN.map(String).join(',')}`, { signal: expect.any(AbortSignal) }]);
    expect(lookup.Report()).toMatchObject({ status: 'loading', anchor: { id: 60003760, name: CNAP }, nearby: [] });
    await lookup.Settled();
    expect(onChange).toHaveBeenCalledTimes(1);
    const report = lookup.Report();
    expect(report?.status).toBe('ready');
    expect(report?.nearby[0].id).toBe(60003760);
    expect(report?.anchor).toMatchObject({ distance: 130000, surfaceDistance: 30000 });
    expect(LocationText(report ?? (null as never))).toBe(`Jita · 30.0 km off ${CNAP}`);

    lookup.Update({ ...LOCATION, anchor: { celestial: 60003760, name: 'The CNAP' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lookup.Report()?.anchor).toMatchObject({ id: 60003760, distance: 130000 });
    expect(lookup.Answer()?.celestials[0].id).toBe(60003760);
  });

  it('reports a failed fetch, and fetches again only on retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn(() => Promise.resolve(Respond(503, { error: { message: 'tools-core has no SDE for build 1' }, failure: 'unavailable' })));
    const lookup = new LocationLookup({ fetch });
    lookup.Update(LOCATION);
    await lookup.Settled();
    expect(lookup.Report()).toMatchObject({ status: 'failed', error: 'tools-core has no SDE for build 1' });
    expect(LocationText(lookup.Report() ?? (null as never))).toBe('Jita (failed: tools-core has no SDE for build 1)');
    lookup.Update(LOCATION);
    expect(fetch).toHaveBeenCalledTimes(1);
    lookup.Update(LOCATION, { retry: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('reports a fetch that throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lookup = new LocationLookup({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    lookup.Update(LOCATION);
    await lookup.Settled();
    expect(lookup.Report()?.error).toBe("the hub's /map/system did not answer (Failed to fetch)");
  });

  it('drops a late answer for an old key, and clears on null', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)))
      .mockImplementation(() => Promise.resolve(Respond(200, { ...ANSWER, origin: [1, 2, 3] })));
    const lookup = new LocationLookup({ fetch });
    lookup.Update(LOCATION);
    const first = lookup.Settled();
    lookup.Update({ system: 30000142, origin: [1, 2, 3] });
    await lookup.Settled();
    release(Respond(200, ANSWER));
    await first;
    expect(lookup.Answer()?.origin).toEqual([1, 2, 3]);
    expect(LocationText(lookup.Report() ?? (null as never))).toBe('Jita');

    lookup.Update(null);
    expect(lookup.Report()).toBeNull();
    expect(lookup.Answer()).toBeNull();
  });
});
