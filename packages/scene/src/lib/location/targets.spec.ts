import { describe, expect, it } from 'vitest';
import { celestialTargetId, readCelestialTargetId, toCelestialTargets, toLocationTargetReports } from './targets';
import type { LocatedMapCelestial } from './map';

function celestial(id: number, kind: LocatedMapCelestial['kind'], distance: number, radius: number | null): LocatedMapCelestial {
  return { id, kind, name: `${kind} ${id}`, typeID: null, radius, radiusFrom: radius == null ? null : 'type', position: [distance, 0, 0], orbit: null, graphics: {}, distance };
}

describe('toCelestialTargets', () => {
  it('keeps stations and gates with a radius within the scene extent, nearest first', () => {
    const targets = toCelestialTargets({
      celestials: [celestial(1, 'stargate', 5e6, 3532.4), celestial(2, 'station', 130_000.6, 100_000), celestial(3, 'planet', 1000, 18e6), celestial(4, 'asteroidBelt', 2000, 1), celestial(5, 'station', 2e5, null), celestial(6, 'station', 2e7, 30_000)]
    });
    expect(targets.map((target) => target.target)).toEqual(['celestial:2', 'celestial:1']);
    expect(targets[0]).toMatchObject({ id: 2, kind: 'station', name: 'station 2', position: [130_000.6, 0, 0], radius: 100_000 });
    expect(toLocationTargetReports(targets)).toEqual([
      { target: 'celestial:2', id: 2, name: 'station 2', kind: 'station', radius: 100_000, distance: 130_001, surfaceDistance: 30_001 },
      { target: 'celestial:1', id: 1, name: 'stargate 1', kind: 'stargate', radius: 3532, distance: 5e6, surfaceDistance: 4_996_468 }
    ]);
  });

  it('round-trips target ids', () => {
    expect(readCelestialTargetId(celestialTargetId(60003760))).toBe(60003760);
    expect(readCelestialTargetId('astra')).toBeNull();
    expect(readCelestialTargetId('celestial:x')).toBeNull();
  });
});
