import { describe, expect, it } from 'vitest';
import { defaultLocationRange, toLocationPlacement } from './placement';
import { CNAP, CNAP_30KM_OFFSET, CNAP_30KM_ORIGIN, expectVectorClose, GATE, MOON, vectorLength } from './location.spec-helper';

const STAR_RADIUS = 513100000;

describe('toLocationPlacement', () => {
  it('puts the origin 30 km off the CNAP toward the sun', () => {
    const placed = toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius, range: 30000, name: CNAP.name });
    expect(placed.problems).toEqual([]);
    expect(placed.warnings).toEqual([]);
    expectVectorClose(placed.offset, CNAP_30KM_OFFSET);
    expectVectorClose(placed.origin, CNAP_30KM_ORIGIN);
    expect(Math.abs(placed.distance - 130000)).toBeLessThanOrEqual(1e-3);
    expect(Math.abs(placed.range - 30000)).toBeLessThanOrEqual(1e-3);
  });

  it('uses the default range by kind', () => {
    const gate = toLocationPlacement({ kind: 'stargate', position: GATE.position, radius: GATE.radius });
    expect(Math.abs(vectorLength(gate.offset ?? []) - 6032)).toBeLessThanOrEqual(1e-3);
    expectVectorClose(gate.offset, [4290.378, 749.48, 4173.243]);
    expectVectorClose(gate.origin, [-4067676852029.622, -710577069330.519, -3956622577586.756]);

    const moon = toLocationPlacement({ kind: 'moon', position: MOON.position, radius: MOON.radius });
    expect(Math.abs(moon.distance - 2 * MOON.radius)).toBeLessThanOrEqual(1e-3);
    expectVectorClose(moon.origin, [-107305547057.788, -18744804412.152, 436488716589.707]);

    expect(Math.abs(toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius }).distance - 105000)).toBeLessThanOrEqual(1e-3);

    const belt = toLocationPlacement({ kind: 'asteroidBelt', position: [1e11, 0, 0], radius: 44424.7 });
    expect(belt.offset).toEqual([0, 0, 0]);
    expect(belt.origin).toEqual([1e11, 0, 0]);
    expect(belt.warnings).toEqual([]);

    const star = toLocationPlacement({ kind: 'star', position: [0, 0, 0], radius: STAR_RADIUS });
    expect(star.origin).toEqual([0, 0, 2 * STAR_RADIUS]);
    expect(defaultLocationRange({ kind: 'planet', radius: null })).toBe(0);
  });

  it('takes "away" and a vector direction, and refuses a zero one', () => {
    const away = toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius, range: 30000, direction: 'away' });
    expectVectorClose(
      away.offset,
      CNAP_30KM_OFFSET.map((component) => -component)
    );
    const above = toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius, range: 0, direction: [0, 2, 0] });
    expect(above.offset).toEqual([0, 100000, 0]);
    expect(toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius, direction: [0, 0, 0] }).problems).toEqual(['direction must be "sun", "away" or a non-zero [x, y, z]']);
  });

  it('keeps an explicit offset, refuses it beside a range and warns inside the body', () => {
    const kept = toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius, offset: [0, 0, 200000] });
    expect(kept.offset).toEqual([0, 0, 200000]);
    expect(kept.range).toBe(100000);
    expect(toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius, offset: [0, 0, 200000], range: 5 }).problems).toEqual(['give offset, or range and/or direction, not both']);
    expect(toLocationPlacement({ kind: 'moon', position: MOON.position, radius: MOON.radius, offset: [0, 0, 1000], name: MOON.name }).warnings).toEqual(['the origin is inside Jita IV - Moon 4 (radius 1620000 m)']);
  });

  it('measures from the centre without a radius, and refuses a bad range or a far origin', () => {
    const unknown = toLocationPlacement({ kind: 'station', position: CNAP.position, radius: null, range: 30000, name: 'X' });
    expect(unknown.warnings).toEqual(["X's radius is unknown, so range is measured from its centre"]);
    expect(Math.abs(unknown.distance - 30000)).toBeLessThanOrEqual(1e-3);
    const negative = toLocationPlacement({ kind: 'station', position: CNAP.position, radius: CNAP.radius, range: -1 });
    expect(negative.problems).toEqual(['range must be a finite number of metres, 0 or more']);
    expect(negative.origin).toBeNull();
    const far = toLocationPlacement({ kind: 'station', position: [1e15, 0, 0], radius: 1, range: 1e6, direction: 'away' });
    expect(far.problems).toEqual(['the origin would be more than 1e15 m from the star']);
    expect(far.origin).toBeNull();
  });
});
