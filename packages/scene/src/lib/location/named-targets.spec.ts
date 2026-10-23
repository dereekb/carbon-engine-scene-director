import { describe, expect, it } from 'vitest';
import type { SceneVector } from '../scene';
import { JITA_CELESTIALS, jitaAnswer } from './dressing.spec-helper';
import { CNAP_30KM_ORIGIN } from './location.spec-helper';
import type { MapCelestial } from './map';
import { resolveNamedOrderTarget, type ResolveNamedOrderTargetInput } from './named-targets';
import { toCelestialTargets } from './targets';

const ANSWER = jitaAnswer(CNAP_30KM_ORIGIN);
const TARGETS = new Set(toCelestialTargets(ANSWER).map((target) => target.target));
const OBJECTS = [
  { id: 'keep', type: 'Fortizar', name: 'Home Keepstar' },
  { id: 'wreck-1', type: 'Rifter Wreck' },
  { id: 'wreck-2', type: 'Rifter Wreck' },
  { id: 'beacon', type: 12_345 }
];

function Resolve(text: string, more: Partial<ResolveNamedOrderTargetInput> = {}) {
  return resolveNamedOrderTarget({ text, type: 'warp', range: 0, from: [0, 0, 0], objects: OBJECTS, celestials: ANSWER.celestials, systemName: 'Jita', targets: TARGETS, ...more });
}

function Gap(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('resolveNamedOrderTarget', () => {
  it('takes an object by its exact name, then by a type only one object has', () => {
    expect(Resolve('home KEEPSTAR', { type: 'orbit', range: 20_000 })).toEqual({ resolved: { name: 'Home Keepstar', kind: 'object', target: 'keep', range: 20_000 } });
    expect(Resolve('fortizar')).toEqual({ resolved: { name: 'Home Keepstar', kind: 'object', target: 'keep', range: 0 } });
    expect(Resolve('12345')).toEqual({ resolved: { name: '12345', kind: 'object', target: 'beacon', range: 0 } });
    expect(Resolve('Rifter Wreck')).toEqual({ problem: 'order.target "Rifter Wreck" matches 2 objects: "wreck-1", "wreck-2"; give one\'s id' });
  });

  it('turns a station or gate into its celestial target, and refuses one that is not a target', () => {
    expect(Resolve('Caldari Navy Assembly Plant', { type: 'approach', range: undefined })).toEqual({
      resolved: { name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', kind: 'station', target: 'celestial:60003760', range: 0 }
    });
    expect(Resolve('Business Tribunal', { range: 30_000 })).toMatchObject({ resolved: { kind: 'station', target: 'celestial:60003466', range: 30_000 } });
    expect((Resolve('Perimeter gate') as { problem: string }).problem).toMatch(/^order\.target "Perimeter gate" is Stargate \(Perimeter\), .+ from the scene origin: a scene spans at most 10,000 km, so it is not an order target; set_location there first$/);
    // A station inside the extent without a radius is no target.
    const celestials = jitaAnswer(
      CNAP_30KM_ORIGIN,
      JITA_CELESTIALS.map((celestial): MapCelestial => (celestial.id === 60003760 ? { ...celestial, radius: null } : celestial))
    ).celestials;
    expect(Resolve('Caldari Navy Assembly Plant', { celestials, targets: new Set(toCelestialTargets({ celestials }).map((target) => target.target)) })).toEqual({
      problem: 'order.target "Caldari Navy Assembly Plant" is Jita IV - Moon 4 - Caldari Navy Assembly Plant, which has no radius in the static data, so it is not an order target'
    });
  });

  it('warps to a moon: the point range off its surface on the line toward the ship, the range then 0', () => {
    const moon = ANSWER.celestials.find((celestial) => celestial.id === 40009087)!;
    const from: SceneVector = [5000, -2000, 10_000];
    const result = Resolve('IV - Moon 4', { range: 50_000, from }) as { resolved: { point: SceneVector } };
    expect(result).toMatchObject({ resolved: { name: 'Jita IV - Moon 4', kind: 'moon', range: 0 } });
    expect(Gap(result.resolved.point, moon.position)).toBeCloseTo(moon.radius! + 50_000, 0);
    // On the segment from the centre toward the ship.
    expect(Gap(result.resolved.point, from) + Gap(result.resolved.point, moon.position)).toBeCloseTo(Gap(from, moon.position), 0);
    expect(Resolve('Jita IV - Moon 4', { type: 'approach' })).toEqual({
      problem: 'order.target "Jita IV - Moon 4" is Jita IV - Moon 4, a moon: ships only warp to planets, moons, stars and asteroid belts (a warp lands range metres off it), they cannot approach one'
    });
    expect(Resolve('Jita IV - Moon 4', { range: -1 })).toEqual({ problem: 'order.range must be a number of metres in [0, 1000000]' });
  });

  it('refuses a body whose landing is beyond the scene extent, and lands on a belt at its centre', () => {
    expect((Resolve('Jita IV', { where: 'order.order' }) as { problem: string }).problem).toMatch(/^order\.order\.target "Jita IV" is Jita IV: a warp to it lands .+ km from the scene origin, and a scene spans at most 10,000 km; set_location there first$/);
    const belt: MapCelestial = { id: 40009090, kind: 'asteroidBelt', name: 'Jita IV - Asteroid Belt 1', typeID: 15, radius: 1, radiusFrom: 'map', position: [CNAP_30KM_ORIGIN[0] + 1_000_000, CNAP_30KM_ORIGIN[1], CNAP_30KM_ORIGIN[2]], orbit: null, graphics: {} };
    const celestials = jitaAnswer(CNAP_30KM_ORIGIN, [...JITA_CELESTIALS, belt]).celestials;
    expect(Resolve('Asteroid Belt 1', { celestials, range: 10_000 })).toEqual({ resolved: { name: 'Jita IV - Asteroid Belt 1', kind: 'asteroidBelt', point: [990_000, 0, 0], range: 0 } });
  });

  it('lists the candidates of an ambiguous celestial name (nearest first), and gives null when nothing has the name', () => {
    expect(Resolve('Moon 6')).toEqual({ problem: 'order.target "Moon 6" matches 2 celestials: "Jita IV - Moon 6 - Caldari Provisions School", "Jita IV - Moon 6"; give the full name' });
    expect(Resolve('rifter-9')).toBeNull();
    expect(Resolve('CNAP', { celestials: [], systemName: null })).toBeNull();
  });
});
