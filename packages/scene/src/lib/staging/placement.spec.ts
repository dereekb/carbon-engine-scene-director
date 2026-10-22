import { describe, expect, it } from 'vitest';
import { headingToward, normalizeHeading, readNearDirection, tangentHeading, toNearShipPoint } from './placement';

const AT_ORIGIN = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };

describe('toNearShipPoint', () => {
  it('places the lead surface to surface off the ship, along its heading', () => {
    const point = (direction: 'ahead' | 'behind' | 'left' | 'right' | 'above' | 'below', yaw = 0) => toNearShipPoint({ ship: { position: [0, 0, 0], rotation: [yaw, 0, 0] }, shipRadius: 250, leadRadius: 31, range: 10000, direction, where: 'near' }).point;
    expect(point('ahead')).toEqual([0, 0, 10281]);
    expect(point('behind')).toEqual([0, 0, -10281]);
    expect(point('right')).toEqual([10281, 0, 0]);
    expect(point('left')).toEqual([-10281, 0, 0]);
    expect(point('above')).toEqual([0, 10281, 0]);
    expect(point('below')).toEqual([0, -10281, 0]);
    expect(point('ahead', 90)).toEqual([10281, 0, 0]);
    expect(point('right', 90)).toEqual([0, 0, -10281]);
  });

  it('defaults to 5 km ahead and reports the ship heading', () => {
    const placed = toNearShipPoint({ ship: { position: [100, 0, 0], rotation: [-270, 0, 0] }, shipRadius: 0, leadRadius: 0, where: 'near' });
    expect(placed.point).toEqual([5100, 0, 0]);
    expect(placed.heading).toBe(90);
  });

  it('points toward or away from the star with a location', () => {
    const sun = toNearShipPoint({ ship: AT_ORIGIN, shipRadius: 0, leadRadius: 0, range: 1000, direction: 'sun', locationOrigin: [0, 0, 1e9], where: 'near' });
    expect(sun.point).toEqual([0, 0, -1000]);
    const away = toNearShipPoint({ ship: AT_ORIGIN, shipRadius: 0, leadRadius: 0, range: 1000, direction: 'away', locationOrigin: [0, 0, 1e9], where: 'near' });
    expect(away.point).toEqual([0, 0, 1000]);
  });

  it('points toward the origin or along a vector, and refuses degenerate directions', () => {
    expect(toNearShipPoint({ ship: { position: [0, 0, 10000], rotation: [0, 0, 0] }, shipRadius: 0, leadRadius: 0, range: 1000, direction: 'origin', where: 'near' }).point).toEqual([0, 0, 9000]);
    expect(toNearShipPoint({ ship: AT_ORIGIN, shipRadius: 0, leadRadius: 0, range: 1000, direction: [3, 0, 4], where: 'near' }).point).toEqual([600, 0, 800]);
    expect(toNearShipPoint({ ship: AT_ORIGIN, shipRadius: 0, leadRadius: 0, direction: [0, 0, 0], where: 'near' }).problems[0]).toMatch(/zero vector/u);
    expect(toNearShipPoint({ ship: AT_ORIGIN, shipRadius: 0, leadRadius: 0, direction: 'sun', where: 'near' }).problems[0]).toMatch(/set_location/u);
    expect(toNearShipPoint({ ship: AT_ORIGIN, shipRadius: 0, leadRadius: 0, direction: 'origin', where: 'near' }).problems[0]).toMatch(/at the scene origin/u);
  });

  it('reads directions', () => {
    expect(readNearDirection('Ahead', 'd', [])).toBe('ahead');
    expect(readNearDirection([1, 2, 3], 'd', [])).toEqual([1, 2, 3]);
    const problems: string[] = [];
    expect(readNearDirection('up', 'd', problems)).toBeNull();
    expect(problems).toHaveLength(1);
  });
});

describe('headings', () => {
  it('faces toward a point, null straight above', () => {
    expect(headingToward([0, 0, 0], [0, 0, -5])).toBe(180);
    expect(headingToward([0, 0, 0], [5, 0, 0])).toBe(90);
    expect(headingToward([0, 0, 0], [0, 100, 0])).toBeNull();
  });

  it('turns tangent to the line from a reference', () => {
    expect(tangentHeading([0, 0, 0], [0, 0, 100])).toBe(90);
    expect(tangentHeading([0, 0, 0], [0, 100, 0])).toBe(0);
  });

  it('normalizes into (-180, 180]', () => {
    expect(normalizeHeading(180)).toBe(180);
    expect(normalizeHeading(-180)).toBe(180);
    expect(normalizeHeading(270)).toBe(-90);
    expect(normalizeHeading(-0)).toBe(0);
    expect(normalizeHeading(12.34567)).toBe(12.346);
  });
});
