import { describe, expect, it } from 'vitest';
import { legacyOrbitOf, orbitOrderFor } from './orbit';
import { RIFTER_PROFILE } from './piloting.spec-helper';

const RIFTER = { speed: RIFTER_PROFILE.flight.speed, tau: RIFTER_PROFILE.flight.tau, radii: 2 * RIFTER_PROFILE.radius };

describe('legacyOrbitOf', () => {
  it("settles where Destiny's legacy orbit flies a Rifter around a Rifter (measured on the parks)", () => {
    const rows = [
      [0, 312, 0.56, 39.1],
      [500, 867, 0.764, 21.5],
      [1000, 1355, 0.85, 15.7],
      [2500, 2796, 0.946, 8.6],
      [5000, 5242, 0.982, 4.8]
    ] as const;
    for (const [ordered, flown, fraction, degrees] of rows) {
      const orbit = legacyOrbitOf({ ...RIFTER, range: ordered });
      expect(orbit.distance, `${ordered}`).toBeCloseTo(flown, -1);
      expect(orbit.speedFraction, `${ordered}`).toBeCloseTo(fraction, 2);
      expect((orbit.angular * 180) / Math.PI, `${ordered}`).toBeCloseTo(degrees, 0);
      expect(orbit.speed / RIFTER.speed, `${ordered}`).toBeCloseTo(fraction, 2);
    }
  });

  it('flies an MWD Rifter ordered to 10 km at ~13.1 km and 83 % (players: "orbit 7.5 km with MWD holds 11-12 km")', () => {
    const propMod = RIFTER_PROFILE.propMod;
    if (!propMod) throw new Error('the Rifter fixture has no MWD');
    const orbit = legacyOrbitOf({ speed: propMod.speed, tau: propMod.tau, radii: RIFTER.radii, range: 10_000 });
    expect(orbit.distance).toBeGreaterThan(13_000);
    expect(orbit.distance).toBeLessThan(13_250);
    expect(orbit.speedFraction).toBeCloseTo(0.83, 2);
  });

  it('is still for a ship that cannot move', () => {
    expect(legacyOrbitOf({ ...RIFTER, speed: 0, range: 1000 })).toMatchObject({ distance: 1000, speed: 0, angular: 0 });
  });
});

describe('orbitOrderFor', () => {
  it('inverts the model: the order flies the range asked for', () => {
    for (const distance of [500, 1000, 4000, 12_000]) {
      const ordered = orbitOrderFor({ ...RIFTER, distance });
      expect(ordered).toBeLessThan(distance);
      expect(Math.abs(legacyOrbitOf({ ...RIFTER, range: ordered }).distance - distance), `${distance}`).toBeLessThan(15);
    }
  });

  it('orders 0 for a range tighter than the ship can fly', () => {
    expect(orbitOrderFor({ ...RIFTER, distance: 200 })).toBe(0);
  });
});
