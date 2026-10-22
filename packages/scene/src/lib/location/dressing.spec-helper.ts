import type { SceneVector } from '../scene';
import type { MapCelestial, MapSystem, MapSystemAnswer } from './map';
import { toMapSystemAnswer } from './map';

/**
 * A trimmed Jita in system metres (tools-core map routes through the hub's /map/system, SDE 3632936): the star, two
 * planets, three moons, four stations and four gates with their rotations.
 */
export const JITA_SYSTEM: MapSystem = {
  id: 30000142,
  name: 'Jita',
  securityStatus: 0.945913,
  securityClass: 'B',
  constellation: { id: 20000020, name: 'Kimotoro' },
  region: { id: 10000002, name: 'The Forge' },
  nebula: 'res:/dx9/scene/universe/c02_cube.black',
  star: { id: 40009076, name: 'Jita - Star', typeID: 3796, radius: 513100000, spectralClass: 'F1 V', temperature: 7305, luminosity: 1.692, light: { color: [0.85632, 0.85939, 1], intensity: 2.03842 }, graphic: 'res:/dx9/model/celestial/sun/sun_blue_sun_01a.black' }
};

export const JITA_CELESTIALS: MapCelestial[] = [
  { id: 40009076, kind: 'star', name: 'Jita - Star', typeID: 3796, radius: 513100000, radiusFrom: 'map', position: [0, 0, 0], orbit: null, graphics: { resFilePath: 'res:/dx9/model/celestial/sun/sun_blue_sun_01a.black' } },
  {
    id: 40009082,
    kind: 'planet',
    name: 'Jita IV',
    typeID: 13,
    radius: 18890000,
    radiusFrom: 'map',
    position: [-107354576606, -18753785170, 436797007078],
    orbit: { id: 40009076, kind: 'star' },
    graphics: { resFilePath: 'res:/dx9/model/worldobject/planet/gasgiant.black', shaderPreset: 'res:/dx9/model/worldobject/planet/template_hi/gas/p_gasgiant_30.black', heightMap1: 'res:/dx9/model/worldobject/planet/gasgiant/gasgiant03_d.dds', heightMap2: 'res:/dx9/model/worldobject/planet/gasgiant/gasgiant03_d.dds' }
  },
  {
    id: 40009083,
    kind: 'moon',
    name: 'Jita IV - Moon 1',
    typeID: 14,
    radius: 150000,
    radiusFrom: 'map',
    position: [-107312642157, -18746459635, 436850790914],
    orbit: { id: 40009082, kind: 'planet' },
    graphics: { resFilePath: 'res:/dx9/model/worldobject/planet/moon.black', shaderPreset: 'res:/dx9/model/worldobject/planet/template/moon/p_moon_01.black', heightMap1: 'res:/dx9/model/worldobject/planet/moon/moon03_h.dds', heightMap2: 'res:/dx9/model/worldobject/planet/moon/moon02_h.dds' }
  },
  {
    id: 40009087,
    kind: 'moon',
    name: 'Jita IV - Moon 4',
    typeID: 52673,
    radius: 1620000,
    radiusFrom: 'map',
    position: [-107306319871, -18744939412, 436491860176],
    orbit: { id: 40009082, kind: 'planet' },
    graphics: {
      resFilePath: 'res:/dx9/model/worldobject/planet/template/moon/p_moon_jita4-4.black',
      shaderPreset: 'res:/dx9/model/worldobject/planet/template/moon/p_moon_jita4-4.black',
      heightMap1: 'res:/dx9/model/worldobject/planet/moon/moon01_h.dds',
      heightMap2: 'res:/dx9/model/worldobject/planet/moon/moon04_h.dds'
    }
  },
  {
    id: 40009089,
    kind: 'moon',
    name: 'Jita IV - Moon 6',
    typeID: 14,
    radius: 820000,
    radiusFrom: 'map',
    position: [-107073753739, -18704728186, 436342969469],
    orbit: { id: 40009082, kind: 'planet' },
    graphics: { resFilePath: 'res:/dx9/model/worldobject/planet/moon.black', shaderPreset: 'res:/dx9/model/worldobject/planet/template/moon/p_moon_45.black', heightMap1: 'res:/dx9/model/worldobject/planet/moon/moon03_h.dds', heightMap2: 'res:/dx9/model/worldobject/planet/moon/moon03_h.dds' }
  },
  {
    id: 40009123,
    kind: 'planet',
    name: 'Jita VIII',
    typeID: 2016,
    radius: 5110000,
    radiusFrom: 'map',
    position: [-4067664386090, -710580828973, -3956610895960],
    orbit: { id: 40009076, kind: 'star' },
    graphics: {
      resFilePath: 'res:/dx9/model/worldobject/planet/sandstormplanet.black',
      shaderPreset: 'res:/dx9/model/worldobject/planet/template_hi/sandstorm/p_sandstorm_47.black',
      heightMap1: 'res:/dx9/model/worldobject/planet/terrestrial/terrestrial04_h_hi.dds',
      heightMap2: 'res:/dx9/model/worldobject/planet/moon/moon01_h.dds'
    }
  },
  {
    id: 50001248,
    kind: 'stargate',
    name: 'Stargate (Maurasi)',
    typeID: 16,
    radius: 3532,
    radiusFrom: 'type',
    position: [-4067658424320, -710585180160, -3956625039360],
    orbit: null,
    graphics: { sofDna: 'csg:caldaribase:caldari' },
    rotation: [0.026281, 0.971867, -0.132267, 0.193103],
    destination: { system: 30000140, stargate: 50000802 }
  },
  {
    id: 50001249,
    kind: 'stargate',
    name: 'Stargate (Perimeter)',
    typeID: 16,
    radius: 3532,
    radiusFrom: 'type',
    position: [-4067676856320, -710577070080, -3956622581760],
    orbit: null,
    graphics: { sofDna: 'csg:caldaribase:caldari' },
    rotation: [0.041926, 0.912317, 0.096665, -0.395697],
    destination: { system: 30000144, stargate: 50002185 }
  },
  {
    id: 50001250,
    kind: 'stargate',
    name: 'Stargate (New Caldari)',
    typeID: 16,
    radius: 3532,
    radiusFrom: 'type',
    position: [-4067676119040, -710568468480, -3956615454720],
    orbit: null,
    graphics: { sofDna: 'csg:caldaribase:caldari' },
    rotation: [-0.211134, -0.76651, -0.310664, 0.520935],
    destination: { system: 30000145, stargate: 50002198 }
  },
  {
    id: 50013921,
    kind: 'stargate',
    name: 'Stargate (Niyabainen)',
    typeID: 16,
    radius: 3532,
    radiusFrom: 'type',
    position: [-4067679068160, -710575104000, -3956620124160],
    orbit: null,
    graphics: { sofDna: 'csg:caldaribase:caldari' },
    rotation: [0.075877, 0.866172, 0.138626, -0.474102],
    destination: { system: 30000143, stargate: 50013922 }
  },
  { id: 60003466, kind: 'station', name: 'Jita IV - Moon 4 - Caldari Business Tribunal Bureau Offices', typeID: 1529, radius: 45734, radiusFrom: 'type', position: [-107302625280, -18745221120, 436489789440], orbit: { id: 40009087, kind: 'moon' }, graphics: { sofDna: 'cs1:caldaribase:caldari' } },
  {
    id: 60003760,
    kind: 'station',
    name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    typeID: 52678,
    radius: 100000,
    radiusFrom: 'type',
    position: [-107303362560, -18744975360, 436489052160],
    orbit: { id: 40009087, kind: 'moon' },
    graphics: { sofDna: 'jita:caldarinavy:caldari', resFilePath: 'res:/dx9/model/spaceobjectfactory/hulls/jita.black' }
  },
  { id: 60004423, kind: 'station', name: 'Jita IV - Moon 6 - Caldari Provisions School', typeID: 1529, radius: 45734, radiusFrom: 'type', position: [-107074560000, -18705408000, 436344545280], orbit: { id: 40009089, kind: 'moon' }, graphics: { sofDna: 'cs1:caldaribase:caldari' } },
  { id: 60015262, kind: 'station', name: 'Jita VIII - Quafe Company Trade Embassy', typeID: 3866, radius: 24871, radiusFrom: 'type', position: [-4067659542266.66, -710579719780.06, -3956604392439.14], orbit: { id: 40009123, kind: 'planet' }, graphics: { sofDna: 'gs4:gallentebase:gallente' } }
];

/**
 * 2.5 km off the Perimeter gate.
 */
export const PERIMETER_2500_ORIGIN: SceneVector = [-4067676852029.622, -710577069330.52, -3956622577586.756];

export function jitaAnswer(origin: SceneVector, celestials: readonly MapCelestial[] = JITA_CELESTIALS): MapSystemAnswer {
  return toMapSystemAnswer({ system: JITA_SYSTEM, celestials, origin, sdeBuild: '3632936' });
}

/**
 * Count stations on a ring around an origin, each a little bigger than the last (all above the drawing threshold).
 */
export function syntheticStations(origin: SceneVector, count: number): MapCelestial[] {
  return Array.from({ length: count }, (_, index): MapCelestial => {
    const angle = (index / count) * 2 * Math.PI;
    return {
      id: 61000000 + index,
      kind: 'station',
      name: `Station ${index}`,
      typeID: 1529,
      radius: 10000 + index * 1000,
      radiusFrom: 'type',
      position: [origin[0] + 1e6 * Math.cos(angle), origin[1], origin[2] + 1e6 * Math.sin(angle)],
      orbit: null,
      graphics: { sofDna: 'cs1:caldaribase:caldari' }
    };
  });
}
