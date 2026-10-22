import { describe, expect, it } from 'vitest';
import type { CelestialKind } from './location';
import { type MapCelestial, type MapSystem, toLocationReport, toMapSystemAnswer } from './map';
import { CNAP, CNAP_30KM_ORIGIN, CNAP_LOCATION, GATE, JITA, MOON, PLANET, vectorLength } from './location.spec-helper';

const SYSTEM: MapSystem = {
  id: JITA,
  name: 'Jita',
  securityStatus: 0.945913,
  securityClass: 'B',
  constellation: { id: 20000020, name: 'Kimotoro' },
  region: { id: 10000002, name: 'The Forge' },
  nebula: 'res:/dx9/scene/universe/c02_cube.black',
  star: null
};

function Celestial(config: { readonly id: number; readonly kind: CelestialKind; readonly name: string; readonly position: [number, number, number]; readonly radius: number | null }): MapCelestial {
  return { typeID: null, radiusFrom: config.radius == null ? null : 'map', orbit: null, graphics: {}, ...config };
}

const STAR = Celestial({ id: 40009076, kind: 'star', name: 'Jita - Star', position: [0, 0, 0], radius: 513100000 });
const CELESTIALS: MapCelestial[] = [
  STAR,
  Celestial({ ...PLANET, kind: 'planet' }),
  Celestial({ ...MOON, kind: 'moon' }),
  { ...Celestial({ ...CNAP, kind: 'station' }), radiusFrom: 'type', graphics: { sofDna: 'jita:caldarinavy:caldari' } },
  { ...Celestial({ ...GATE, kind: 'stargate' }), rotation: [0.041926, 0.912317, 0.096665, -0.395697], destination: { system: 30000144, stargate: 50002185 } },
  Celestial({ id: 40000001, kind: 'asteroidBelt', name: 'Jita I - Asteroid Belt 1', position: [-107303362560, -18744975360, 436489552160], radius: 44424.7 }),
  ...Array.from({ length: 8 }, (_, index) => Celestial({ id: 60100000 + index, kind: 'station', name: `Far ${index}`, position: [1e12 + index, 0, 0], radius: null }))
];
const ANSWER = toMapSystemAnswer({ system: SYSTEM, celestials: CELESTIALS, origin: CNAP_30KM_ORIGIN, sdeBuild: '3632936' });

describe('toMapSystemAnswer', () => {
  it('re-bases on the origin and sorts nearest first, keeping graphics and rotation', () => {
    expect(ANSWER.celestials[0].id).toBe(CNAP.id);
    expect(Math.abs(ANSWER.celestials[0].distance - 130000)).toBeLessThanOrEqual(1e-3);
    expect(ANSWER.celestials[0].graphics).toEqual({ sofDna: 'jita:caldarinavy:caldari' });
    for (const celestial of ANSWER.celestials) expect(Math.abs(vectorLength(celestial.position) - celestial.distance)).toBeLessThanOrEqual(1e-6 * celestial.distance + 1e-6);
    const distances = ANSWER.celestials.map((celestial) => celestial.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(ANSWER.celestials.find((celestial) => celestial.id === GATE.id)?.rotation).toEqual([0.041926, 0.912317, 0.096665, -0.395697]);
    expect(ANSWER.origin).toEqual(CNAP_30KM_ORIGIN);
    expect(CELESTIALS[3].position).toEqual(CNAP.position);
  });
});

describe('toLocationReport', () => {
  it('reports the document while loading or failed', () => {
    const loading = toLocationReport({ location: CNAP_LOCATION, answer: null, status: 'loading' });
    expect(loading).toEqual({ system: { id: JITA, name: 'Jita', region: 'The Forge' }, origin: CNAP_30KM_ORIGIN, status: 'loading', anchor: { id: CNAP.id, name: CNAP.name, kind: 'station' }, nearby: [] });
    const failed = toLocationReport({ location: CNAP_LOCATION, answer: null, status: 'failed', error: 'tools-core has no SDE' });
    expect(failed).toMatchObject({ status: 'failed', error: 'tools-core has no SDE', nearby: [] });
  });

  it('reports actual distances when ready', () => {
    const report = toLocationReport({ location: CNAP_LOCATION, answer: ANSWER, status: 'ready' });
    expect(report.system).toEqual({ id: JITA, name: 'Jita', region: 'The Forge', securityStatus: 0.945913 });
    expect(report.nearby).toHaveLength(10);
    expect(report.nearby[0]).toMatchObject({ id: CNAP.id, kind: 'station', radius: 100000, distance: 130000, surfaceDistance: 30000 });
    expect(report.anchor).toEqual(report.nearby[0]);
    const belt = report.nearby.find((celestial) => celestial.kind === 'asteroidBelt');
    expect(belt?.distance).toBe(Math.round(vectorLength([0, 0, 0].map((_, index) => CELESTIALS[5].position[index] - CNAP_30KM_ORIGIN[index]))));
    expect(belt && 'surfaceDistance' in belt).toBe(false);
    const far = toLocationReport({ location: CNAP_LOCATION, answer: ANSWER, status: 'ready', limit: 20 }).nearby.find((celestial) => celestial.name === 'Far 0');
    expect(far && 'surfaceDistance' in far).toBe(false);
  });

  it('reports the star distance and direction', () => {
    const { star } = toLocationReport({ location: CNAP_LOCATION, answer: ANSWER, status: 'ready' });
    expect(star?.id).toBe(STAR.id);
    expect(star?.distance).toBe(Math.round(vectorLength(CNAP_30KM_ORIGIN)));
    expect(Math.abs(vectorLength(star?.direction ?? []) - 1)).toBeLessThanOrEqual(1e-4);
    expect(star?.direction).toEqual([0.2385, 0.0417, -0.9702]);
  });

  it('notes an anchor that is not in the system', () => {
    const location = { ...CNAP_LOCATION, anchor: { celestial: 1, name: 'Elsewhere' } };
    expect(toLocationReport({ location, answer: ANSWER, status: 'ready' }).anchor).toEqual({ id: 1, name: 'Elsewhere', note: "not among Jita's celestials" });
  });
});
