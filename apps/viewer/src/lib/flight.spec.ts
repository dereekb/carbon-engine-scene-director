import { afterEach, describe, expect, it, vi } from 'vitest';
import { findBakedPropMod } from '@scene-director/scene';
import { CLASS_RIG_SIZES, HullStatsKey, HullStatsLookup, ResolveFlight, RunningFlight, ShipClassOf, type PublishedHull } from './flight';
import { ResolveShipPropMod } from './prop-mods';

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5 } };
const RIFTER_STATS = { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35 };

describe('ResolveFlight', () => {
  it("flies the hub's hull with the max-skills pilot", () => {
    const flight = ResolveFlight({ published: RIFTER, hull: { category: 'frigate', radius: 86.9 }, overrides: null });
    expect(flight).toMatchObject({ mass: 1_067_000, maxVelocity: 456.25, radius: 31, signatureRadius: 35, source: 'sde', typeID: 587, typeName: 'Rifter' });
    expect(flight.agility).toBeCloseTo(2.16, 9);
    expect(flight.alignTime).toBeCloseTo(3.19502, 5);
    expect(flight.note).toBeUndefined();
  });

  it("applies the document's stats before the pilot's skills", () => {
    expect(ResolveFlight({ published: RIFTER, hull: null, overrides: { maxVelocity: 200 } }).maxVelocity).toBe(250);
    expect(ResolveFlight({ published: RIFTER, hull: null, overrides: { maxVelocity: 0 } }).maxVelocity).toBe(0);
  });

  it('flies all four stats whatever the hull, on the best radius known', () => {
    const withHull = ResolveFlight({ published: RIFTER, hull: null, overrides: RIFTER_STATS });
    expect(withHull).toMatchObject({ source: 'stats', radius: 31, maxVelocity: 456.25 });
    expect(ResolveFlight({ published: null, note: 'no SDE', hull: { category: null, radius: 55 }, overrides: RIFTER_STATS })).toMatchObject({ source: 'stats', radius: 55, maxVelocity: 456.25 });
    const bare = ResolveFlight({ published: null, hull: null, overrides: RIFTER_STATS });
    expect(bare).toMatchObject({ source: 'stats', radius: 100 });
    expect(bare.note).toBeUndefined();
  });

  it('flies class values through the same pilot when the EVE data cannot name the hull', () => {
    const frigate = ResolveFlight({ published: null, note: 'no EVE ship type has the DNA', hull: { category: 'Frigate', radius: 27.9 }, overrides: null });
    expect(frigate).toMatchObject({ mass: 1.2e6, maxVelocity: 437.5, radius: 27.9, source: 'class', note: 'no EVE ship type has the DNA' });
    expect(frigate.agility).toBeCloseTo(2.16, 9);
    expect(frigate.typeID).toBeUndefined();
    expect(ResolveFlight({ published: null, hull: { category: 'Mystery', radius: 726 }, overrides: null }).maxVelocity).toBe(137.5);
    expect(ResolveFlight({ published: null, hull: null, overrides: null })).toMatchObject({ maxVelocity: 287.5, radius: 100, source: 'class' });
  });
});

const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3, rigSize: 3 } };
const GUARDIAN: PublishedHull = { typeID: 11987, name: 'Guardian', published: { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70, radius: 80, warpSpeedMultiplier: 4, rigSize: 2 } };

describe('ResolveFlight with a prop mod', () => {
  it('carries the running numbers ship_stats gives withPropMod, leaving the base numbers alone', () => {
    const propMod = ResolveShipPropMod({ module: 'mwd', rigSize: 3, answer: null });
    const flight = ResolveFlight({ published: TFI, hull: null, overrides: null, propMod });
    expect(flight.maxVelocity).toBeCloseTo(162.5, 9);
    expect(flight.mass).toBe(103_300_000);
    expect(flight.propMod).toMatchObject({ module: 'mwd', name: '500MN Microwarpdrive II', typeID: 12084, kind: 'microwarpdrive', size: 'L', source: 'baked', mass: 153_300_000, cycleTime: 10 });
    expect(flight.propMod?.maxVelocity).toBeCloseTo(1176.137476, 5);
    expect(flight.propMod?.signatureRadius).toBeCloseTo(2012.5, 9);
    expect(flight.propMod?.alignTime).toBeCloseTo(16.496782, 5);
    const guardian = ResolveFlight({ published: GUARDIAN, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: '10MN Afterburner II', rigSize: 2, answer: null }) });
    expect(guardian.propMod?.maxVelocity).toBeCloseTo(650.701745, 5);
    expect(guardian.propMod?.cycleTime).toBeCloseTo(7.5, 12);
    expect(ResolveFlight({ published: TFI, hull: null, overrides: null }).propMod).toBeUndefined();
  });

  it('gives class values prop mod numbers too, and a cycle time without a duration', () => {
    const stats = { ...findBakedPropMod(12084)!, duration: null };
    const flight = ResolveFlight({ published: null, hull: { category: 'Battleship', radius: 700 }, overrides: null, propMod: { module: 12084, stats, source: 'sde', size: 'L' } });
    expect(flight.source).toBe('class');
    expect(flight.propMod?.mass).toBe(1e8 + 5e7);
    expect(flight.propMod?.maxVelocity).toBeGreaterThan(flight.maxVelocity * 4);
    expect(flight.propMod?.cycleTime).toBe(10);
  });

  it('RunningFlight swaps the numbers only while the module runs', () => {
    const flight = ResolveFlight({ published: TFI, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 3, answer: null }) });
    expect(RunningFlight(flight, false)).toBe(flight);
    const running = RunningFlight(flight, true);
    expect(running).toMatchObject({ mass: 153_300_000, signatureRadius: flight.propMod?.signatureRadius, alignTime: flight.propMod?.alignTime, maxVelocity: flight.propMod?.maxVelocity, agility: flight.agility, radius: 250 });
    const none = ResolveFlight({ published: TFI, hull: null, overrides: null });
    expect(RunningFlight(none, true)).toBe(none);
  });

  it('sizes a hull by its class', () => {
    expect(ShipClassOf({ category: 'Battleship', radius: null })).toBe('battleship');
    expect(ShipClassOf({ category: null, radius: 60 })).toBe('frigate');
    expect(ShipClassOf(null)).toBe('cruiser');
    expect(CLASS_RIG_SIZES).toEqual({ frigate: 1, destroyer: 1, cruiser: 2, battlecruiser: 2, battleship: 3, capital: 4, titan: 4 });
  });
});

describe('ResolveFlight warp speed', () => {
  it("is the hull's warpSpeedMultiplier, else its class value", () => {
    expect(ResolveFlight({ published: { ...RIFTER, published: { ...RIFTER.published, warpSpeedMultiplier: 4.5 } }, hull: null, overrides: null }).warpSpeed).toBe(4.5);
    expect(ResolveFlight({ published: null, hull: { category: 'Frigate', radius: 27.9 }, overrides: null }).warpSpeed).toBe(5);
    expect(ResolveFlight({ published: null, hull: { category: 'Battleship', radius: 400 }, overrides: null }).warpSpeed).toBe(3);
    expect(ResolveFlight({ published: null, hull: null, overrides: null }).warpSpeed).toBe(4);
  });

  it('keeps the published value under all four stats, and falls back to class values when the SDE has none', () => {
    expect(ResolveFlight({ published: RIFTER, hull: null, overrides: RIFTER_STATS }).warpSpeed).toBe(5);
    expect(ResolveFlight({ published: null, hull: { category: 'Battleship', radius: 400 }, overrides: RIFTER_STATS }).warpSpeed).toBe(3);
    expect(ResolveFlight({ published: { ...RIFTER, published: { ...RIFTER.published, warpSpeedMultiplier: null } }, hull: { category: 'Battleship', radius: 400 }, overrides: null }).warpSpeed).toBe(3);
  });
});

describe('HullStatsKey', () => {
  it("keys by the DNA's hull, faction and race, or by the type when the ship names one", () => {
    expect(HullStatsKey({ dna: 'mf1_t1:MinmatarBase:minmatar:commands' })).toBe(HullStatsKey({ dna: 'mf1_t1:minmatarbase:minmatar' }));
    expect(HullStatsKey({ dna: 'mf1_t1:minmatarbase:minmatar', type: 587 })).toBe(HullStatsKey({ dna: 'af1_t1:amarrbase:amarr', type: '587' }));
    expect(HullStatsKey({ dna: 'mf1_t1:minmatarbase:minmatar', type: 587 })).not.toBe(HullStatsKey({ dna: 'mf1_t1:minmatarbase:minmatar' }));
  });
});

function Respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HullStatsLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks once per key and parses the hull', async () => {
    const fetch = vi.fn(() => Promise.resolve(Respond(200, { hull: { typeID: 587, name: 'Rifter', published: RIFTER.published, candidates: [] }, stats: {} })));
    const lookup = new HullStatsLookup({ fetch });
    const ship = { dna: 'mf1_t1:minmatarbase:minmatar', type: 'Rifter Mk 2' };
    expect(lookup.Cached(ship)).toBeNull();
    const [first, second] = await Promise.all([lookup.Lookup(ship), lookup.Lookup({ dna: 'af1_t1:amarrbase:amarr', type: 'rifter mk 2' })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/ship-stats?dna=mf1_t1%3Aminmatarbase%3Aminmatar&type=Rifter%20Mk%202', expect.objectContaining({ signal: expect.anything() })]);
    expect(first).toEqual({ hull: RIFTER, note: null });
    expect(second).toBe(first);
    expect(lookup.Cached(ship)).toBe(first);
  });

  it("keeps the hub's message for a failure, refetching it only after ForgetFailures", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const message = 'tools-core has no SDE for build 3632936';
    const fetch = vi.fn((url: string) => Promise.resolve(url.includes('nosuchhull') ? Respond(503, { error: { message }, failure: 'unavailable' }) : Respond(200, { hull: { typeID: 587, name: 'Rifter', published: RIFTER.published } })));
    const lookup = new HullStatsLookup({ fetch, url: 'http://hub/ship-stats' });
    const bad = { dna: 'nosuchhull:amarrbase:amarr' };
    const good = { dna: 'mf1_t1:minmatarbase:minmatar' };
    expect(await lookup.Lookup(bad)).toEqual({ hull: null, note: message });
    await lookup.Lookup(good);
    expect(warn).toHaveBeenCalledTimes(1);
    await lookup.Lookup(bad);
    expect(fetch).toHaveBeenCalledTimes(2);
    lookup.ForgetFailures();
    expect(lookup.Cached(bad)).toBeNull();
    expect(lookup.Cached(good)?.hull).toEqual(RIFTER);
    await lookup.Lookup(bad);
    await lookup.Lookup(good);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('never rejects when the hub does not answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lookup = new HullStatsLookup({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
    const answer = await lookup.Lookup({ dna: 'mf1_t1:minmatarbase:minmatar' });
    expect(answer.hull).toBeNull();
    expect(answer.note).toMatch(/the hub's \/ship-stats did not answer \(fetch failed\)/);
  });
});
