import { DEFAULT_UNIVERSE, type MapCelestial, type SceneDocument, type SceneLocation } from '@scene-director/scene';
import { beforeEach, describe, expect, it } from 'vitest';
import { Locations, MatchCelestialName, NEBULA_ARGUMENT_WARNING } from './locations';
import { MAP_ROUTES, MakeFakeMapData } from './map-data.testing';
import { ToolError } from './tool-call';

const NO_PAGE = {
  Connected: () => false,
  NotConnected: () => new ToolError('No viewer tab is connected.'),
  Call: async () => {
    throw new Error('no page');
  }
};
const CNAP = 'Jita IV - Moon 4 - Caldari Navy Assembly Plant';
const NEBULA = 'res:/dx9/scene/universe/c02_cube.black';

interface SetLocationResult {
  readonly location: SceneLocation;
  readonly celestial: { readonly id: number; readonly kind: string; readonly radius: number; readonly radiusFrom: string } | null;
  readonly range?: number;
  readonly distance?: number;
  readonly scene: SceneDocument;
  readonly loaded: boolean;
  readonly warnings: string[];
}

let locations: Locations;
let jitaCelestials: MapCelestial[];

beforeEach(async () => {
  const { mapData } = MakeFakeMapData();
  locations = new Locations({ mapData, page: NO_PAGE });
  jitaCelestials = await mapData.SystemCelestials(30000142);
});

function ExpectClose(actual: readonly number[] | undefined, expected: readonly number[], tolerance = 1e-3): void {
  expect(actual).toHaveLength(3);
  for (const [index, value] of expected.entries()) expect(Math.abs((actual?.[index] ?? NaN) - value)).toBeLessThanOrEqual(tolerance);
}

async function Set(args: Record<string, unknown>): Promise<SetLocationResult> {
  return (await locations.SetLocation({ scene: { name: 'loc' }, ...args })) as SetLocationResult;
}

describe('MatchCelestialName', () => {
  const match = (text: string) => {
    const found = MatchCelestialName({ celestials: jitaCelestials, text, systemName: 'Jita' });
    return found && 'celestial' in found ? found.celestial.id : (found?.candidates.map((celestial) => celestial.id) ?? null);
  };

  it('matches exact, system-prefixed, star, gate and substring names', () => {
    expect(match(CNAP)).toBe(60003760);
    expect(match('  jita iv -  moon 4 ')).toBe(40009087);
    expect(match('IV - Moon 4')).toBe(40009087);
    expect(match('IV')).toBe(40009082);
    expect(match('star')).toBe(40009076);
    expect(match('the sun')).toBe(40009076);
    for (const text of ['Perimeter gate', 'the Perimeter gate', 'gate to Perimeter', 'stargate Perimeter']) expect(match(text)).toBe(50001249);
    expect(match('Business Tribunal')).toBe(60003466);
  });

  it('lists candidates for an ambiguous substring and null for no match', () => {
    expect(match('Caldari Navy Assembly Plant')).toEqual([60003757, 60003760]);
    expect(match('Nowhere')).toBeNull();
  });
});

describe('set_location', () => {
  it('forwards only the location to a connected tab and names the region nebula the page draws', async () => {
    const calls: { name: string; args: { operations: object[] } }[] = [];
    const page = {
      Connected: () => true,
      NotConnected: () => new ToolError('No viewer tab is connected.'),
      Call: async (name: string, args: { operations: object[] }) => {
        calls.push({ name, args });
        return { warnings: [] };
      }
    };
    const { mapData } = MakeFakeMapData();
    const result = (await new Locations({ mapData, page }).SetLocation({ celestial: CNAP, range: 30000 })) as SetLocationResult & { nebula: string };
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('patch_scene');
    expect(calls[0].args.operations).toEqual([{ op: 'set_location', location: result.location }]);
    expect(result.nebula).toBe(NEBULA);
    expect(result.warnings).toEqual([]);
  });

  it('warns that the nebula argument is no longer used', async () => {
    const result = await Set({ celestial: CNAP, range: 30000, nebula: false });
    expect(result.scene.environment.universe).toBe(DEFAULT_UNIVERSE);
    expect(result.warnings).toContain(NEBULA_ARGUMENT_WARNING);
  });

  it('warns when the system has no nebula in the EVE data', async () => {
    const key = Object.keys(MAP_ROUTES).find((route) => route.includes('map/systems/30000142?expand=all')) ?? '';
    const jita = MAP_ROUTES[key] as { json: { derived: object } };
    const { mapData } = MakeFakeMapData({ ...MAP_ROUTES, [key]: { ...jita, json: { ...jita.json, derived: { ...jita.json.derived, nebula: null, scene: {} } } } });
    const result = (await new Locations({ mapData, page: NO_PAGE }).SetLocation({ scene: { name: 'loc' }, celestial: CNAP })) as SetLocationResult & { nebula?: string };
    expect(result.nebula).toBeUndefined();
    expect(result.warnings).toContain('The Forge has no nebula in the EVE data; the page draws environment.universe');
  });

  it('puts the scene 30 km off the CNAP and leaves environment.universe alone', async () => {
    const result = await Set({ celestial: CNAP, range: 30000 });
    expect(result.loaded).toBe(false);
    expect(result.location).toMatchObject({ system: 30000142, name: 'Jita', region: 'The Forge', anchor: { celestial: 60003760, name: CNAP, kind: 'station' } });
    ExpectClose(result.location.origin, [-107303331552.681, -18744969943.288, 436488926028.301]);
    ExpectClose(result.location.anchor?.offset, [31007.319, 5416.712, -126131.699]);
    expect(result.celestial).toMatchObject({ id: 60003760, kind: 'station', radius: 100000, radiusFrom: 'type' });
    expect(Math.abs((result.range ?? 0) - 30000)).toBeLessThanOrEqual(1e-3);
    expect(result.scene.location).toEqual(result.location);
    expect(result.scene.environment.universe).toBe(DEFAULT_UNIVERSE);
    expect((result as SetLocationResult & { nebula: string }).nebula).toBe(NEBULA);
  });

  it('finds the Perimeter gate in Jita, a moon by its full name, and an id', async () => {
    for (const args of [{ celestial: 'Perimeter gate', system: 'Jita' }, { celestial: 'the Perimeter gate in Jita' }]) {
      const result = await Set(args);
      expect(result.location.anchor?.celestial).toBe(50001249);
      expect(Math.abs((result.range ?? 0) - 2500)).toBeLessThanOrEqual(1e-3);
    }
    const moon = await Set({ celestial: 'Jita IV - Moon 4' });
    expect(moon.location.anchor).toMatchObject({ celestial: 40009087, kind: 'moon' });
    expect(Math.abs((moon.distance ?? 0) - 3240000)).toBeLessThanOrEqual(1e-3);
    expect((await Set({ celestial: 60003760, system: 'Jita' })).location.anchor?.celestial).toBe(60003760);
    expect((await Set({ system: 'Jita', celestial: 'star' })).location.anchor?.kind).toBe('star');
  });

  it('places from an explicit origin with no anchor', async () => {
    const result = await Set({ system: 'Jita', origin: [1, 2, 3] });
    expect(result.location).toEqual({ system: 30000142, name: 'Jita', region: 'The Forge', origin: [1, 2, 3] });
    expect(result.celestial).toBeNull();
  });

  it('explains what is ambiguous, missing or wrong', async () => {
    await expect(Set({ celestial: 'Stargate (Perimeter)' })).rejects.toThrow(/is in 2 systems \(Jita, Niyabainen\); pass system/u);
    await expect(Set({ celestial: 60003760, system: 'Perimeter' })).rejects.toThrow(`${CNAP} (60003760) is in Jita, not Perimeter`);
    await expect(Set({ system: 'Jita' })).rejects.toThrow(/name a celestial in Jita .*for example: "Jita IV - Moon \d - .*", "Stargate \(Perimeter\)"; get_system lists them all/u);
    await expect(Set({ origin: [1, 2, 3] })).rejects.toThrow('origin needs system: the solar system the origin is in');
    await expect(Set({ origin: [1, 2, 3], system: 'Jita', celestial: 'star' })).rejects.toThrow('give origin, or a celestial with range, direction or offset, not both');
    await expect(Set({ celestial: 'Nowhere Special' })).rejects.toThrow(/no celestial named "Nowhere Special".*moons and asteroid belts are found through their system/u);
    await expect(Set({ celestial: 'Caldari Navy Assembly Plant', system: 'Jita' })).rejects.toThrow(/matches 2 celestials in Jita/u);
    await expect(Set({ celestial: CNAP, range: -5 })).rejects.toThrow(/range must be a finite number/u);
    await expect(Set({})).rejects.toThrow('give celestial (a name or id) and/or system, or origin with system');
    await expect(Set({ celestial: 'star', system: 'Nowhereville' })).rejects.toThrow('no solar system named "Nowhereville"');
  });

  it('needs a tab or a scene', async () => {
    await expect(locations.SetLocation({ celestial: CNAP })).rejects.toThrow(/No viewer tab is connected\..*Or pass "scene"/su);
  });
});

describe('search_map and get_system', () => {
  it('search_map adds system and region names', async () => {
    const result = (await locations.SearchMap({ query: 'Perimeter' })) as { total: number; items: Record<string, unknown>[]; note: string };
    expect(result.total).toBe(22);
    expect(result.items[0]).toEqual({ kind: 'system', id: 30000144, name: 'Perimeter', region: 'The Forge', securityStatus: expect.any(Number) });
    expect(result.items[2]).toEqual({ kind: 'stargate', id: 50001249, name: 'Stargate (Perimeter)', system: { id: 30000142, name: 'Jita' } });
    expect(result.note).toMatch(/not searchable/u);
    await expect(locations.SearchMap({ query: 'Jita', kinds: ['moon'] })).rejects.toThrow(/kinds must be among region, constellation, system/u);
    await expect(locations.SearchMap({ query: ' ' })).rejects.toThrow(/query is required/u);
  });

  it('get_system counts every kind and lists the asked kinds with their parents', async () => {
    const result = (await locations.GetSystem({ system: 'Jita', kinds: ['station'] })) as { system: Record<string, unknown>; counts: Record<string, number>; celestials: Record<string, unknown>[]; nebula: string };
    expect(result.system).toEqual({ id: 30000142, name: 'Jita', securityStatus: 0.945913, securityClass: 'B', constellation: 'Kimotoro', region: 'The Forge' });
    expect(result.counts).toEqual({ star: 1, planet: 1, moon: 2, asteroidBelt: 0, station: 3, stargate: 1 });
    expect(result.celestials.map((celestial) => celestial['kind'])).toEqual(['station', 'station', 'station']);
    expect(result.celestials[0]).toEqual({ id: 60003466, kind: 'station', name: 'Jita IV - Moon 4 - Caldari Business Tribunal Bureau Offices', radius: 45734, position: [-107302625280, -18745221120, 436489789440], orbit: 'Jita IV - Moon 4' });
    expect(result.nebula).toBe(NEBULA);
    const gates = (await locations.GetSystem({ system: 30000142, kinds: ['stargate'] })) as { celestials: Record<string, unknown>[] };
    expect(gates.celestials[0]).toMatchObject({ id: 50001249, radius: 3532, destination: 30000144 });
    await expect(locations.GetSystem({ system: 123 })).rejects.toThrow('no solar system 123');
  });
});

describe('SystemAnswer', () => {
  it('re-bases on the origin, nearest first', async () => {
    const answer = await locations.SystemAnswer({ system: 30000142, origin: [-107303331552.681, -18744969943.288, 436488926028.301] });
    expect(answer.celestials[0].id).toBe(60003760);
    expect(Math.abs(answer.celestials[0].distance - 130000)).toBeLessThanOrEqual(1e-3);
    expect(answer.sdeBuild).toBe('3632936');
  });
});
