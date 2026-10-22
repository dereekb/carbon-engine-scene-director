import { afterEach, describe, expect, it, vi } from 'vitest';
import { findBakedPropMod, type RigSize } from '@scene-director/scene';
import type { PublishedHull } from './flight';
import { PropModKey, PropModLookup, PropModLookupTarget, ResolveShipPropMod, RigSizeOf } from './prop-mods';

function Respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const COLD_GAS = { typeID: 5945, name: '500MN Cold-Gas Enduring Microwarpdrive', kind: 'microwarpdrive', speedFactor: 505, speedBoostFactor: 1.5e8, massAddition: 5e7, signatureRadiusBonus: 500, duration: 10_000 } as const;
const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, rigSize: 3 } };

describe('ResolveShipPropMod', () => {
  it('fits nothing for none', () => {
    expect(ResolveShipPropMod({ module: 'none', rigSize: 2, answer: null })).toBeNull();
    expect(PropModLookupTarget('none', 2)).toBeNull();
  });

  it('sizes mwd and ab for every hull size', () => {
    const expected: Record<RigSize, [number, number]> = { 1: [440, 438], 2: [12076, 12058], 3: [12084, 12068], 4: [41253, 41239] };
    for (const rigSize of [1, 2, 3, 4] as RigSize[]) {
      expect(ResolveShipPropMod({ module: 'mwd', rigSize, answer: null })?.stats.typeID).toBe(expected[rigSize][0]);
      expect(ResolveShipPropMod({ module: 'ab', rigSize, answer: null })?.stats.typeID).toBe(expected[rigSize][1]);
    }
    expect(ResolveShipPropMod({ module: 'mwd', rigSize: 4, answer: null })?.size).toBe('XL');
  });

  it('flies the hub answer, else the baked numbers, else the hull-sized module of the kind with a note', () => {
    expect(ResolveShipPropMod({ module: '500MN Cold-Gas Enduring Microwarpdrive', rigSize: 3, answer: { propMod: COLD_GAS, note: null } })).toEqual({ module: '500MN Cold-Gas Enduring Microwarpdrive', stats: COLD_GAS, source: 'sde', size: 'L' });
    const baked = ResolveShipPropMod({ module: 12058, rigSize: 2, answer: { propMod: null, note: 'no SDE' } });
    expect(baked).toEqual({ module: 12058, stats: findBakedPropMod(12058), source: 'baked', size: 'M', note: 'no SDE' });
    expect(ResolveShipPropMod({ module: '50mn mwd ii', rigSize: 2, answer: null })?.source).toBe('baked');
    const unknown = ResolveShipPropMod({ module: '1MN Odd Afterburner', rigSize: 1, answer: { propMod: null, note: 'no propulsion module is named "1MN Odd Afterburner"' } });
    expect(unknown).toMatchObject({ source: 'default', size: 'S', stats: { typeID: 438 }, note: '1MN Afterburner II stands in for "1MN Odd Afterburner": no propulsion module is named "1MN Odd Afterburner"' });
    expect(ResolveShipPropMod({ module: 99_999, rigSize: 3, answer: null })).toMatchObject({ source: 'default', stats: { typeID: 12084 }, note: '500MN Microwarpdrive II stands in for type 99999: the EVE data has not answered yet' });
  });

  it('sizes from the SDE rigSize, else the SOF class', () => {
    expect(RigSizeOf({ published: TFI, hull: { category: 'Frigate', radius: 30 } })).toBe(3);
    expect(RigSizeOf({ published: null, hull: { category: 'Battleship', radius: null } })).toBe(3);
    expect(RigSizeOf({ published: null, hull: { category: null, radius: 900 } })).toBe(3);
    expect(ResolveShipPropMod({ module: 'mwd', rigSize: RigSizeOf({ published: null, hull: { category: 'Battleship', radius: null } }), answer: null })?.stats.name).toBe('500MN Microwarpdrive II');
    expect(RigSizeOf({ published: { ...TFI, published: { ...TFI.published, rigSize: null } }, hull: null })).toBe(2);
  });
});

describe('PropModLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks once per key, by id or normalized name', async () => {
    const fetch = vi.fn(() => Promise.resolve(Respond(200, { propMod: COLD_GAS, sdeBuild: '3632936' })));
    const lookup = new PropModLookup({ fetch });
    expect(lookup.Cached('500MN Cold-Gas Enduring Microwarpdrive')).toBeNull();
    const [first, second] = await Promise.all([lookup.Lookup('500MN Cold-Gas Enduring Microwarpdrive'), lookup.Lookup('500mn  cold-gas enduring MWD')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/prop-mod?module=500MN%20Cold-Gas%20Enduring%20Microwarpdrive', expect.objectContaining({ signal: expect.anything() })]);
    expect(first).toEqual({ propMod: COLD_GAS, note: null });
    expect(second).toBe(first);
    expect(PropModKey(5945)).toBe('id:5945');
  });

  it("keeps the hub's message for a failure, refetching only after ForgetFailures, and never rejects", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetch = vi.fn((url: string) => (url.includes('throw') ? Promise.reject(new Error('offline')) : Promise.resolve(Respond(404, { error: { message: 'no propulsion module is named "x"' }, failure: 'not-found' }))));
    const lookup = new PropModLookup({ fetch });
    expect(await lookup.Lookup('x')).toEqual({ propMod: null, note: 'no propulsion module is named "x"' });
    await lookup.Lookup('x');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await lookup.Lookup('throw')).toEqual({ propMod: null, note: "the hub's /prop-mod did not answer (offline)" });
    lookup.ForgetFailures();
    expect(lookup.Cached('x')).toBeNull();
    await lookup.Lookup('x');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalled();
  });
});
