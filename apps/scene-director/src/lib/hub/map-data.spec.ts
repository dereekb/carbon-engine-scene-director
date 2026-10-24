import { describe, expect, it } from 'vitest';
import { MapData } from './map-data';
import { MAP_ROUTES, MakeFakeMapData, MakeUnpreparedMapData } from './map-data.testing';
import { ShipDataError } from './ship-data';
import { SDE, TOOLS_CORE } from './ship-data.testing';

async function CaughtShipDataFailure(action: () => Promise<unknown>): Promise<ShipDataError> {
  const error = await action().then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ShipDataError);
  return error as ShipDataError;
}

describe('MapData', () => {
  it('reads a system: name, security, constellation, region, nebula and star', async () => {
    const { mapData, calls } = MakeFakeMapData();
    const jita = await mapData.System(30000142);
    expect(jita).toEqual({
      id: 30000142,
      name: 'Jita',
      securityStatus: 0.945913,
      securityClass: 'B',
      constellation: { id: 20000020, name: 'Kimotoro' },
      region: { id: 10000002, name: 'The Forge' },
      nebula: 'res:/dx9/scene/universe/c02_cube.black',
      star: {
        id: 40009076,
        name: 'Jita - Star',
        typeID: 3796,
        radius: 513100000,
        spectralClass: 'F1 V',
        temperature: 7305,
        luminosity: 1.692,
        light: { color: [0.85632, 0.85939, 1], intensity: 2.03842 },
        graphic: 'res:/dx9/model/celestial/sun/sun_blue_sun_01a.black'
      }
    });
    await mapData.System(30000142);
    expect(calls.filter((call) => call.includes('map/systems/30000142?'))).toHaveLength(1);
  });

  it('reads a system’s celestials with map radii for bodies and type radii for stations and gates', async () => {
    const { mapData, calls } = MakeFakeMapData();
    const celestials = await mapData.SystemCelestials(30000142);
    expect(celestials.map((celestial) => celestial.kind)).toEqual(['star', 'planet', 'moon', 'moon', 'station', 'station', 'station', 'stargate']);
    const byId = new Map(celestials.map((celestial) => [celestial.id, celestial]));
    expect(byId.get(40009076)).toMatchObject({ name: 'Jita - Star', position: [0, 0, 0], radius: 513100000, radiusFrom: 'map', orbit: null });
    expect(byId.get(40009087)).toMatchObject({ name: 'Jita IV - Moon 4', position: [-107306319871, -18744939412, 436491860176], radius: 1620000, radiusFrom: 'map', orbit: { id: 40009082, kind: 'planet' } });
    expect(byId.get(60003760)).toMatchObject({ name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', typeID: 52678, radius: 100000, radiusFrom: 'type', graphics: { sofDna: 'jita:caldarinavy:caldari', resFilePath: 'res:/dx9/model/spaceobjectfactory/hulls/jita.black' } });
    expect(byId.get(60003466)?.graphics).toEqual({ sofDna: 'cs1:caldaribase:caldari' });
    expect(byId.get(50001249)).toMatchObject({ name: 'Stargate (Perimeter)', radius: 3532, radiusFrom: 'type', rotation: [0.041926, 0.912317, 0.096665, -0.395697], destination: { system: 30000144, stargate: 50002185 } });
    expect(calls.filter((call) => call.includes('types/1529?'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('types/'))).toHaveLength(3);
  });

  it('reads one celestial as the system list does', async () => {
    const { mapData } = MakeFakeMapData();
    const [celestial, listed] = await Promise.all([mapData.Celestial(60003760), mapData.SystemCelestials(30000142)]);
    expect(celestial).toEqual({ ...listed.find((candidate) => candidate.id === 60003760), solarSystemID: 30000142 });
  });

  it('maps an unknown system, an unprepared SDE and a network error', async () => {
    expect((await CaughtShipDataFailure(() => MakeFakeMapData().mapData.System(123))).failure).toBe('not-found');
    const unprepared = await CaughtShipDataFailure(() => MakeUnpreparedMapData('3600000').System(30000142));
    expect(unprepared.failure).toBe('unavailable');
    expect(unprepared.message).toContain('node bin/cjs-sde-prepare.js --build 3600000');
    const offline = new MapData({
      url: TOOLS_CORE,
      sdeBuild: async () => SDE,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch
    });
    const unreachable = await CaughtShipDataFailure(() => offline.System(30000142));
    expect(unreachable.failure).toBe('unavailable');
    expect(unreachable.message).toContain('unreachable');
    expect(unreachable.message).toContain('or run the hub with --eve-data off');
    expect(await offline.Index()).toEqual({ present: true, degraded: false });
  });

  it('searches with the exact route and reads the index', async () => {
    const { mapData, calls } = MakeFakeMapData();
    const answer = await mapData.Search({ query: 'Jita', kinds: ['system'], limit: 50 });
    expect(answer.items).toEqual([{ kind: 'system', id: 30000142, name: 'Jita', constellationID: 20000020, regionID: 10000002 }]);
    expect(calls).toContain(`/eve/${SDE}/map/search?q=Jita&kind=system&limit=50`);
    expect(await mapData.Index()).toEqual({ present: true, degraded: false });
    expect(Object.keys(MAP_ROUTES).length).toBeGreaterThan(0);
  });
});
