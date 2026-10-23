import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeaponGraphic } from '@scene-director/scene';
import { WeaponLookup } from './weapon-lookup';

// The hub's /weapon answer for the 425mm AutoCannon II (SDE 3632936).
const AUTOCANNON: WeaponGraphic = { typeID: 2913, name: '425mm AutoCannon II', kind: 'turret', slot: 'turrets', size: 2, resPath: 'res:/dx9/model/turret/projectile/auto/m/auto_425mm_t1.black', sofFactionName: 'brutor', chargeSize: 2 };

function Respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('WeaponLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks once per type and answers synchronously once cached', async () => {
    const fetch = vi.fn(() => Promise.resolve(Respond(200, AUTOCANNON)));
    const lookup = new WeaponLookup({ fetch, retryDelaysMs: [] });
    expect(lookup.Cached(2913)).toBeNull();
    const [first, second] = await Promise.all([lookup.Lookup(2913), lookup.Lookup(2913)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/weapon?type=2913', expect.objectContaining({ signal: expect.anything() })]);
    expect(first).toEqual({ weapon: AUTOCANNON, note: null });
    expect(second).toBe(first);
    expect(lookup.Cached(2913)).toBe(first);
  });

  it("keeps the hub's message for a failure, rejects junk, refetches only after ForgetFailures, and never rejects", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn((url: string) => {
      let response: Promise<Response>;
      if (url.endsWith('=1')) response = Promise.reject(new Error('offline'));
      else if (url.endsWith('=2')) response = Promise.resolve(Respond(200, { typeID: 2 }));
      else response = Promise.resolve(Respond(404, { error: { message: 'type 34 has no weapon graphic' }, failure: 'not-found' }));
      return response;
    });
    const lookup = new WeaponLookup({ fetch, retryDelaysMs: [] });
    expect(await lookup.Lookup(34)).toEqual({ weapon: null, note: 'type 34 has no weapon graphic' });
    await lookup.Lookup(34);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await lookup.Lookup(1)).toEqual({ weapon: null, note: "the hub's /weapon did not answer (offline)" });
    expect(await lookup.Lookup(2)).toEqual({ weapon: null, note: "the hub's /weapon answer is not a weapon graphic" });
    lookup.ForgetFailures();
    expect(lookup.Cached(34)).toBeNull();
    await lookup.Lookup(34);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalled();
  });

  it('retries no answer and 502 / 503 / 504, but not a 404', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const statuses = [503, 0, 200];
    const fetch = vi.fn((url: string) => {
      if (url.endsWith('=34')) return Promise.resolve(Respond(404, { error: { message: 'not a weapon' } }));
      const status = statuses.shift();
      return status === 0 ? Promise.reject(new Error('reset')) : Promise.resolve(Respond(status ?? 200, status === 200 ? AUTOCANNON : { error: { message: 'tools-core is down' } }));
    });
    const lookup = new WeaponLookup({ fetch, retryDelaysMs: [0, 0] });
    expect(await lookup.Lookup(2913)).toEqual({ weapon: AUTOCANNON, note: null });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await lookup.Lookup(34)).weapon).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
