import { type Answer, FakeToolsCoreFetch, SDE, TOOLS_CORE } from './ship-data.testing';
import { MapData } from './map-data';

/**
 * A tools-core stand-in for the location specs: tools-core's map answers for Jita, Perimeter and Niyabainen (SDE
 * 3632936, captured live on 2026-10-22), trimmed to the rows and fields MapData reads, shapes kept. A map search
 * with no fixture answers as tools-core does for no match: 200 with no items.
 */

const JITA_SYSTEM = {
  kind: 'system',
  id: 30000142,
  name: 'Jita',
  constellationID: 20000020,
  regionID: 10000002,
  securityStatus: 0.945913,
  securityClass: 'B',
  derived: {
    nebula: { graphics: { scene: 'res:/dx9/scene/universe/c02_cube.black' } },
    star: {
      id: 40009076,
      typeID: 3796,
      radius: 513100000,
      position: [0, 0, 0],
      name: { text: 'Jita - Star', language: 'en' },
      graphics: { sofDna: null, resFilePath: 'res:/dx9/model/celestial/sun/sun_blue_sun_01a.black' },
      spectralClass: 'F1 V',
      temperature: 7305,
      luminosity: 1.692,
      light: { color: [0.85632, 0.85939, 1], intensity: 2.03842 }
    },
    scene: { nebula: { graphics: { scene: 'res:/dx9/scene/universe/c02_cube.black' } } }
  },
  constellation: { kind: 'constellation', id: 20000020, name: 'Kimotoro' },
  region: { kind: 'region', id: 10000002, name: 'The Forge' },
  position: [-129064861735000000, 60755306910000000, 117469227060000000],
  radius: 3591948992512
};
const PERIMETER_SYSTEM = {
  kind: 'system',
  id: 30000144,
  name: 'Perimeter',
  constellationID: 20000020,
  regionID: 10000002,
  securityStatus: 0.949,
  securityClass: 'A',
  derived: {
    nebula: { graphics: { scene: 'res:/dx9/scene/universe/c02_cube.black' } },
    star: {
      id: 40009228,
      typeID: 3802,
      radius: 91900000,
      position: [0, 0, 0],
      name: { text: 'Perimeter - Star', language: 'en' },
      graphics: { sofDna: null, resFilePath: 'res:/dx9/model/celestial/sun/sun_yellow_small_01a.black' },
      spectralClass: 'K1 V',
      temperature: 4796,
      luminosity: 0.04031,
      light: { color: [1, 0.766963, 0.577616], intensity: 0.800842 }
    },
    scene: { nebula: { graphics: { scene: 'res:/dx9/scene/universe/c02_cube.black' } } }
  },
  constellation: { kind: 'constellation', id: 20000020, name: 'Kimotoro' },
  region: { kind: 'region', id: 10000002, name: 'The Forge' },
  position: [-143265233088942900, 64923714928938900, 104178623206741810],
  radius: 1467665219584
};
const NIYABAINEN_SYSTEM = {
  kind: 'system',
  id: 30000143,
  name: 'Niyabainen',
  constellationID: 20000020,
  regionID: 10000002,
  securityStatus: 0.949,
  securityClass: 'A',
  derived: {
    nebula: { graphics: { scene: 'res:/dx9/scene/universe/c02_cube.black' } },
    star: {
      id: 40009126,
      typeID: 3802,
      radius: 237200000,
      position: [0, 0, 0],
      name: { text: 'Niyabainen - Star', language: 'en' },
      graphics: { sofDna: null, resFilePath: 'res:/dx9/model/celestial/sun/sun_yellow_small_01a.black' },
      spectralClass: 'K2 V',
      temperature: 4624,
      luminosity: 0.2321,
      light: { color: [1, 0.744303, 0.533928], intensity: 1.240544 }
    },
    scene: { nebula: { graphics: { scene: 'res:/dx9/scene/universe/c02_cube.black' } } }
  },
  constellation: { kind: 'constellation', id: 20000020, name: 'Kimotoro' },
  region: { kind: 'region', id: 10000002, name: 'The Forge' },
  position: [-144006154015412200, 66582208175810270, 107909631497080420],
  radius: 1875601653760
};
const JITA_CELESTIALS = {
  solarSystemID: 30000142,
  name: 'Jita',
  celestials: {
    star: [
      { kind: 'star', id: 40009076, solarSystemID: 30000142, typeID: 3796, position: [0, 0, 0], radius: 513100000, orbitID: null, derived: { name: { text: 'Jita - Star', language: 'en' }, orbit: null, localPosition: null, graphics: { sofDna: null, resFilePath: 'res:/dx9/model/celestial/sun/sun_blue_sun_01a.black' } } }
    ],
    planet: [
      {
        kind: 'planet',
        id: 40009082,
        solarSystemID: 30000142,
        typeID: 13,
        position: [-107354576606, -18753785170, 436797007078],
        radius: 18890000,
        orbitID: 40009076,
        derived: {
          name: { text: 'Jita IV', language: 'en' },
          orbit: { id: 40009076, kind: 'star' },
          localPosition: [-107354576606, -18753785170, 436797007078],
          graphics: {
            sofDna: null,
            resFilePath: 'res:/dx9/model/worldobject/planet/gasgiant.black',
            shaderPreset: 'res:/dx9/model/worldobject/planet/template_hi/gas/p_gasgiant_30.black',
            heightMap1: 'res:/dx9/model/worldobject/planet/gasgiant/gasgiant03_d.dds',
            heightMap2: 'res:/dx9/model/worldobject/planet/gasgiant/gasgiant03_d.dds'
          }
        }
      }
    ],
    moon: [
      {
        kind: 'moon',
        id: 40009087,
        solarSystemID: 30000142,
        typeID: 52673,
        position: [-107306319871, -18744939412, 436491860176],
        radius: 1620000,
        orbitID: 40009082,
        derived: {
          name: { text: 'Jita IV - Moon 4', language: 'en' },
          orbit: { id: 40009082, kind: 'planet' },
          localPosition: [48256735, 8845758, -305146902],
          graphics: {
            sofDna: null,
            resFilePath: 'res:/dx9/model/worldobject/planet/template/moon/p_moon_jita4-4.black',
            shaderPreset: 'res:/dx9/model/worldobject/planet/template/moon/p_moon_jita4-4.black',
            heightMap1: 'res:/dx9/model/worldobject/planet/moon/moon01_h.dds',
            heightMap2: 'res:/dx9/model/worldobject/planet/moon/moon04_h.dds'
          }
        }
      },
      {
        kind: 'moon',
        id: 40009088,
        solarSystemID: 30000142,
        typeID: 14,
        position: [-107684046957, -18811340389, 436991965137],
        radius: 530000,
        orbitID: 40009082,
        derived: {
          name: { text: 'Jita IV - Moon 5', language: 'en' },
          orbit: { id: 40009082, kind: 'planet' },
          localPosition: [-329470351, -57555219, 194958059],
          graphics: { sofDna: null, resFilePath: 'res:/dx9/model/worldobject/planet/moon.black', shaderPreset: 'res:/dx9/model/worldobject/planet/template/moon/p_moon_04.black', heightMap1: 'res:/dx9/model/worldobject/planet/moon/moon02_h.dds', heightMap2: 'res:/dx9/model/worldobject/planet/moon/moon03_h.dds' }
        }
      }
    ],
    asteroidBelt: [],
    station: [
      {
        kind: 'station',
        id: 60003466,
        solarSystemID: 30000142,
        typeID: 1529,
        position: [-107302625280, -18745221120, 436489789440],
        radius: null,
        orbitID: 40009087,
        derived: { name: { text: 'Jita IV - Moon 4 - Caldari Business Tribunal Bureau Offices', language: 'en' }, orbit: { id: 40009087, kind: 'moon' }, localPosition: [3694591, -281708, -2070736], graphics: { sofDna: 'cs1:caldaribase:caldari', resFilePath: null } }
      },
      {
        kind: 'station',
        id: 60003757,
        solarSystemID: 30000142,
        typeID: 1529,
        position: [-107684782080, -18811330560, 436992614400],
        radius: null,
        orbitID: 40009088,
        derived: { name: { text: 'Jita IV - Moon 5 - Caldari Navy Assembly Plant', language: 'en' }, orbit: { id: 40009088, kind: 'moon' }, localPosition: [-735123, 9829, 649263], graphics: { sofDna: 'cs1:caldaribase:caldari', resFilePath: null } }
      },
      {
        kind: 'station',
        id: 60003760,
        solarSystemID: 30000142,
        typeID: 52678,
        position: [-107303362560, -18744975360, 436489052160],
        radius: null,
        orbitID: 40009087,
        derived: { name: { text: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', language: 'en' }, orbit: { id: 40009087, kind: 'moon' }, localPosition: [2957311, -35948, -2808016], graphics: { sofDna: 'jita:caldarinavy:caldari', resFilePath: 'res:/dx9/model/spaceobjectfactory/hulls/jita.black' } }
      }
    ],
    stargate: [
      {
        kind: 'stargate',
        id: 50001249,
        solarSystemID: 30000142,
        typeID: 16,
        position: [-4067676856320, -710577070080, -3956622581760],
        radius: null,
        orbitID: null,
        destination: { solarSystemID: 30000144, stargateID: 50002185 },
        derived: {
          name: { text: 'Stargate (Perimeter)', language: 'en' },
          orbit: null,
          localPosition: null,
          graphics: { sofDna: 'csg:caldaribase:caldari', resFilePath: null },
          orientation: { direction: [-0.7138963448502554, 0.20955869212101305, -0.6681595343673362], rotation: [0.041926, 0.912317, 0.096665, -0.395697], rule: 'faces-destination-system' }
        }
      }
    ]
  }
};
const PERIMETER_CELESTIALS = {
  solarSystemID: 30000144,
  name: 'Perimeter',
  celestials: {
    star: [
      {
        kind: 'star',
        id: 40009228,
        solarSystemID: 30000144,
        typeID: 3802,
        position: [0, 0, 0],
        radius: 91900000,
        orbitID: null,
        derived: { name: { text: 'Perimeter - Star', language: 'en' }, orbit: null, localPosition: null, graphics: { sofDna: null, resFilePath: 'res:/dx9/model/celestial/sun/sun_yellow_small_01a.black' } }
      }
    ],
    planet: [],
    moon: [],
    asteroidBelt: [
      {
        kind: 'asteroidBelt',
        id: 40009232,
        solarSystemID: 30000144,
        typeID: 15,
        position: [132939571200, 5971353600, 102934487040],
        radius: 44424.699219,
        orbitID: 40009231,
        derived: { name: { text: 'Perimeter II - Asteroid Belt 1', language: 'en' }, orbit: { id: 40009231, kind: 'planet' }, localPosition: [44697799394, -81883, -23584847], graphics: { sofDna: null, resFilePath: null } }
      }
    ],
    station: [],
    stargate: [
      {
        kind: 'stargate',
        id: 50002185,
        solarSystemID: 30000144,
        typeID: 93250,
        position: [660601774080, 44692316160, 2112967680000],
        radius: null,
        orbitID: null,
        destination: { solarSystemID: 30000142, stargateID: 50001249 },
        derived: {
          name: { text: 'Stargate (Jita)', language: 'en' },
          orbit: null,
          localPosition: null,
          graphics: { sofDna: 'csg_damaged:caldaribase:caldari', resFilePath: null },
          orientation: { direction: [0.7138963448502554, -0.20955869212101305, 0.6681595343673362], rotation: [0.096665, 0.395697, -0.041926, 0.912317], rule: 'faces-destination-system' }
        }
      }
    ]
  }
};
const TYPE_52678 = { typeID: 52678, groupID: 15, radius: 100000, name: { text: 'Jita Trade Hub', language: 'en' }, groupName: { text: 'Station', language: 'en' } };
const TYPE_1529 = { typeID: 1529, groupID: 15, radius: 45734, name: { text: 'Caldari Administrative Station', language: 'en' }, groupName: { text: 'Station', language: 'en' } };
const TYPE_16 = { typeID: 16, groupID: 10, radius: 3532, name: { text: 'Stargate (Caldari System)', language: 'en' }, groupName: { text: 'Stargate', language: 'en' } };
const TYPE_93250 = { typeID: 93250, groupID: 10, radius: 3532, name: { text: 'Damaged Stargate (Caldari System)', language: 'en' }, groupName: { text: 'Stargate', language: 'en' } };

const SEARCHABLE = ['region', 'constellation', 'system', 'star', 'planet', 'stargate', 'station'];
const CELESTIAL_SEARCH_KINDS = 'star,planet,station,stargate';

function Search(query: string, items: object[], total: number = items.length): Answer {
  return { json: { query, searchable: SEARCHABLE, total, items } };
}

function Route(route: string): string {
  return `/eve/${SDE}/${route}`;
}

const JITA_ITEM = { kind: 'system', id: 30000142, name: 'Jita', constellationID: 20000020, regionID: 10000002 };
const PERIMETER_ITEM = { kind: 'system', id: 30000144, name: 'Perimeter', constellationID: 20000020, regionID: 10000002 };
const CNAP_ITEM = { kind: 'station', id: 60003760, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', solarSystemID: 30000142 };
const TRIBUNAL_ITEM = { kind: 'station', id: 60003466, name: 'Jita IV - Moon 4 - Caldari Business Tribunal Bureau Offices', solarSystemID: 30000142 };
const PERIMETER_GATE_ITEM = { kind: 'stargate', id: 50001249, name: 'Stargate (Perimeter)', solarSystemID: 30000142 };
const CNAP_ROW = JITA_CELESTIALS.celestials.station.find((row) => row.id === 60003760);

/**
 * The map routes MapData reads, for Jita, Perimeter and Niyabainen.
 */
export const MAP_ROUTES: Record<string, Answer> = {
  '/eve/latest/build': { json: { build: SDE, builds: { resources: SDE, sde: SDE } } },
  [Route('map')]: { json: { target: 'eve', build: SDE, counts: { regions: 114, constellations: 1184, systems: 8490 }, index: { present: true, degraded: false } } },
  [Route('map/systems/30000142?expand=all')]: { json: JITA_SYSTEM },
  [Route('map/systems/30000144?expand=all')]: { json: PERIMETER_SYSTEM },
  [Route('map/systems/30000143?expand=all')]: { json: NIYABAINEN_SYSTEM },
  [Route('map/systems/30000142/celestials?expand=all')]: { json: JITA_CELESTIALS },
  [Route('map/systems/30000144/celestials?expand=all')]: { json: PERIMETER_CELESTIALS },
  [Route('map/celestials/60003760?expand=all')]: { json: CNAP_ROW },
  [Route('types/52678?lang=en')]: { json: TYPE_52678 },
  [Route('types/1529?lang=en')]: { json: TYPE_1529 },
  [Route('types/16?lang=en')]: { json: TYPE_16 },
  [Route('types/93250?lang=en')]: { json: TYPE_93250 },
  [Route('map/search?q=Jita&kind=system&limit=50')]: Search('Jita', [JITA_ITEM]),
  [Route('map/search?q=Perimeter&kind=system&limit=50')]: Search('Perimeter', [PERIMETER_ITEM]),
  [Route(`map/search?q=${encodeURIComponent(CNAP_ITEM.name)}&kind=${CELESTIAL_SEARCH_KINDS}&limit=50`)]: Search(CNAP_ITEM.name, [CNAP_ITEM]),
  [Route(`map/search?q=${encodeURIComponent('Jita IV - Moon 4')}&kind=${CELESTIAL_SEARCH_KINDS}&limit=50`)]: Search('Jita IV - Moon 4', [CNAP_ITEM, TRIBUNAL_ITEM]),
  [Route(`map/search?q=${encodeURIComponent('Stargate (Perimeter)')}&kind=${CELESTIAL_SEARCH_KINDS}&limit=50`)]: Search('Stargate (Perimeter)', [PERIMETER_GATE_ITEM, { kind: 'stargate', id: 50001518, name: 'Stargate (Perimeter)', solarSystemID: 30000143 }]),
  [Route('map/search?q=Perimeter&limit=20')]: Search('Perimeter', [PERIMETER_ITEM, { kind: 'star', id: 40009228, name: 'Perimeter - Star', solarSystemID: 30000144 }, PERIMETER_GATE_ITEM], 22)
};

/**
 * A MapData reading the fake tools-core.
 *
 * @param routes - The routes to answer; MAP_ROUTES by default.
 * @returns The MapData and the list of paths it requested.
 */
export function MakeFakeMapData(routes: Record<string, Answer> = MAP_ROUTES): { readonly mapData: MapData; readonly calls: string[] } {
  const fake = FakeToolsCoreFetch(routes);
  const searchPrefix = Route('map/search?');
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).slice(TOOLS_CORE.length);
    if (path in routes || !path.startsWith(searchPrefix)) return fake.fetch(input, init);
    fake.calls.push(path);
    const query = new URLSearchParams(path.slice(searchPrefix.length)).get('q') ?? '';
    return new Response(JSON.stringify({ query, searchable: SEARCHABLE, total: 0, items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { mapData: new MapData({ url: `${TOOLS_CORE}/`, sdeBuild: async () => SDE, fetch: fakeFetch }), calls: fake.calls };
}

/**
 * Tools-core with no prepared SDE: every route answers 404 "not prepared".
 *
 * @param build - The SDE build MapData reads.
 * @returns A MapData over it.
 */
export function MakeUnpreparedMapData(build: string = SDE): MapData {
  const fakeFetch = (async () => new Response(JSON.stringify({ error: `EVE SDE build ${build} is not prepared; run cjs-sde-prepare` }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  return new MapData({ url: TOOLS_CORE, sdeBuild: async () => build, fetch: fakeFetch });
}
