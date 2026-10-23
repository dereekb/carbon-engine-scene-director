import { describe, expect, it } from 'vitest';
import { agilityTimeConstant, alignTimeOf, closingRateOf, distanceAfter, reversalTimeOf, speedAfter, timeToCloseOf, timeToSpeed } from './kinematics';
import { type PilotBody, relativeMotionOf, surfaceDistanceOf } from './relative';

describe('relativeMotionOf', () => {
  it("measures EVE's overview columns: transversal, angular, bearing and aspect", () => {
    const self: PilotBody = { position: [0, 0, 0], velocity: [100, 0, 0], radius: 30 };
    const other: PilotBody = { position: [0, 0, 1000], velocity: [300, 0, 0], radius: 20 };
    expect(relativeMotionOf(self, other)).toEqual({ distance: 950, centreDistance: 1000, radialVelocity: 0, closingVelocity: -0, transversal: 200, angular: 0.2, bearing: 90, aspect: 90 });
  });

  it('measures a closing ship head on', () => {
    const motion = relativeMotionOf({ position: [0, 0, 0], velocity: [0, 0, 0], radius: 0, heading: [0, 0, 1] }, { position: [0, 0, 5000], velocity: [0, 0, -400], radius: 0 });
    expect(motion).toMatchObject({ distance: 5000, radialVelocity: -400, closingVelocity: 400, transversal: 0, angular: 0, bearing: 0, aspect: 0 });
  });

  it('never measures a surface distance below 0', () => {
    expect(surfaceDistanceOf({ position: [0, 0, 0], radius: 100 }, { position: [50, 0, 0], radius: 100 })).toBe(0);
  });
});

describe('kinematics', () => {
  it("relaxes velocity on Destiny's time constant", () => {
    const tau = agilityTimeConstant(1_067_000, 2.16);
    expect(tau).toBeCloseTo(2.30472, 5);
    expect(alignTimeOf(tau)).toBeCloseTo(tau * Math.log(4), 9);
    expect(speedAfter({ tau, from: 0, to: 456, seconds: tau })).toBeCloseTo(456 * (1 - Math.exp(-1)), 6);
    expect(distanceAfter({ tau, from: 0, to: 456, seconds: 10 })).toBeCloseTo(456 * 10 - 456 * tau * (1 - Math.exp(-10 / tau)), 6);
    expect(timeToSpeed({ tau, from: 0, to: 456, speed: 342 })).toBeCloseTo(alignTimeOf(tau), 9);
    expect(timeToSpeed({ tau, from: 0, to: 456, speed: 500 })).toBe(Number.POSITIVE_INFINITY);
    expect(timeToSpeed({ tau, from: 100, to: 456, speed: 100 })).toBe(0);
    expect(reversalTimeOf(tau)).toBeCloseTo(tau * Math.LN2, 9);
  });

  it('closes a straight chase only when faster', () => {
    expect(closingRateOf(400, 300)).toBe(100);
    expect(timeToCloseOf(10_000, 400, 300)).toBe(100);
    expect(timeToCloseOf(10_000, 300, 400)).toBe(Number.POSITIVE_INFINITY);
    expect(timeToCloseOf(0, 300, 400)).toBe(0);
  });
});
