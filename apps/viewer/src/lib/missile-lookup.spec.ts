import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissileGraphic } from '@scene-director/scene';
import { PageEveDataOf } from './eve-data';
import { MissileLookup } from './missile-lookup';

// The hub's /missile answer for Scourge Heavy Missile in a Heavy Missile Launcher II (SDE 3632936).
const SCOURGE_HEAVY: MissileGraphic = {
  chargeTypeID: 209,
  name: 'Scourge Heavy Missile',
  launcherTypeID: 2410,
  impactResPath: 'res:/fisfx/impact/missile/heavy_impact_scourge.black',
  projectileGraphicID: 21936,
  projectileResPath: 'res:/dx9/model/missile/heavy_missile.black'
};

function Respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('MissileLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks once per (charge, launcher) and answers synchronously once cached', async () => {
    const fetch = vi.fn(() => Promise.resolve(Respond(200, SCOURGE_HEAVY)));
    const lookup = new MissileLookup({ fetch, retryDelaysMs: [] });
    expect(lookup.Cached(209, 2410)).toBeNull();
    const [first, second] = await Promise.all([lookup.Lookup(209, 2410), lookup.Lookup(209, 2410)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/missile?charge=209&launcher=2410', expect.objectContaining({ signal: expect.anything() })]);
    expect(first).toEqual({ missile: SCOURGE_HEAVY, note: null });
    expect(second).toBe(first);
    expect(lookup.Cached(209, 2410)).toBe(first);
    expect(lookup.Cached(209, 2404)).toBeNull();
    await lookup.Lookup(209, 2404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the hub's message for a failure, rejects junk, refetches only after ForgetFailures, and never rejects", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn((url: string) => {
      let response: Promise<Response>;
      if (url.includes('charge=1&')) response = Promise.reject(new Error('offline'));
      else if (url.includes('charge=2&')) response = Promise.resolve(Respond(200, { ...SCOURGE_HEAVY, projectileResPath: 'http://elsewhere' }));
      else response = Promise.resolve(Respond(404, { error: { message: 'launcher 2410 does not fire charge 34' }, failure: 'not-found' }));
      return response;
    });
    const lookup = new MissileLookup({ fetch, retryDelaysMs: [] });
    expect(await lookup.Lookup(34, 2410)).toEqual({ missile: null, note: 'launcher 2410 does not fire charge 34' });
    await lookup.Lookup(34, 2410);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await lookup.Lookup(1, 2410)).toEqual({ missile: null, note: "the hub's /missile did not answer (offline)" });
    expect(await lookup.Lookup(2, 2410)).toEqual({ missile: null, note: "the hub's /missile answer is not a missile graphic" });
    lookup.ForgetFailures();
    expect(lookup.Cached(34, 2410)).toBeNull();
    await lookup.Lookup(34, 2410);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalled();
  });

  it('retries no answer and 502 / 503 / 504, but not a 404', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const statuses = [502, 0, 200];
    const fetch = vi.fn((url: string) => {
      if (url.includes('charge=34&')) return Promise.resolve(Respond(404, { error: { message: 'not a missile' } }));
      const status = statuses.shift();
      return status === 0 ? Promise.reject(new Error('reset')) : Promise.resolve(Respond(status ?? 200, status === 200 ? SCOURGE_HEAVY : { error: { message: 'tools-core is down' } }));
    });
    const lookup = new MissileLookup({ fetch, retryDelaysMs: [0, 0] });
    expect(await lookup.Lookup(209, 2410)).toEqual({ missile: SCOURGE_HEAVY, note: null });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await lookup.Lookup(34, 2410)).missile).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe('MissileLookup with no EVE data', () => {
  const OFF = PageEveDataOf({ hub: { mode: 'off' }, search: '' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers at once with the mode, never fetching or warning', async () => {
    const fetch = vi.fn();
    const warn = vi.spyOn(console, 'warn');
    const lookup = new MissileLookup({ fetch, eveData: OFF });
    expect(lookup.Cached(1, 2)).toEqual({ missile: null, note: OFF.note });
    expect(await lookup.Lookup(1, 2)).toEqual({ missile: null, note: OFF.note });
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
