import { describe, expect, it } from 'vitest';
import { FleetFrame, FormationGoto, FramePoint, HeadingForward, LeadDistance, RotateVector, WarpFrame } from './steering';

function ExpectVector(actual: ArrayLike<number>, expected: ArrayLike<number>, digits = 6): void {
  for (let axis = 0; axis < 3; axis++) expect(actual[axis]).toBeCloseTo(expected[axis], digits);
}

describe('FleetFrame', () => {
  it('turns +Z with the yaw and pitches the nose up for a negative pitch', () => {
    ExpectVector(RotateVector(FleetFrame(0, 0), [0, 0, 1]), [0, 0, 1]);
    ExpectVector(RotateVector(FleetFrame(Math.PI / 2, 0), [0, 0, 1]), [1, 0, 0]);
    ExpectVector(RotateVector(FleetFrame(Math.PI / 2, 0), [1, 0, 0]), [0, 0, -1]);
    const up = RotateVector(FleetFrame(0, -Math.PI / 4), [0, 0, 1]);
    expect(up[1]).toBeGreaterThan(0.7);
    ExpectVector(up, HeadingForward(0, -Math.PI / 4));
  });

  it('agrees with HeadingForward, the legacy heading convention', () => {
    for (const [yaw, pitch] of [
      [0.3, 0.2],
      [-2, -0.5],
      [3, 1.2]
    ]) {
      ExpectVector(RotateVector(FleetFrame(yaw, pitch), [0, 0, 1]), HeadingForward(yaw, pitch));
    }
  });
});

describe('LeadDistance', () => {
  const base = { maxVelocity: 400, speed: 1, tickSeconds: 1 };

  it('is 0 at rest and for a ship that cannot move', () => {
    expect(LeadDistance({ ...base, anchorSpeed: 0 })).toBe(0);
    expect(LeadDistance({ ...base, anchorSpeed: 100, maxVelocity: 0 })).toBe(0);
  });

  it("is one tick's travel for an anchor at least as fast, and D · (u / V)^(1/4) between", () => {
    expect(LeadDistance({ ...base, anchorSpeed: 400 })).toBe(400);
    expect(LeadDistance({ ...base, anchorSpeed: 900 })).toBe(400);
    expect(LeadDistance({ ...base, anchorSpeed: 25 })).toBeCloseTo(400 * (25 / 400) ** 0.25, 9);
    expect(LeadDistance({ ...base, anchorSpeed: 100, speed: 0.5 })).toBeCloseTo(200 * 0.5 ** 0.25, 9);
  });
});

describe('FormationGoto', () => {
  const member = { position: [0, 0, 0], velocity: [0, 0, 0], radius: 50, maxVelocity: 400, speed: 1 };

  it('puts the slot at the anchor plus the rotated direction times the centre distance, led along the anchor velocity', () => {
    const result = FormationGoto({
      anchor: { position: [100, 0, 2000], velocity: [0, 0, 100], radius: 250 },
      member: { ...member, position: [100, 0, 600] },
      frame: FleetFrame(Math.PI / 2, 0),
      direction: [0, 0, -1],
      slotRange: 1000,
      tickSeconds: 1
    });
    // The frame is a Float32Array quaternion: millimetres at a kilometre.
    ExpectVector(result.point, [100 - 1300, 0, 2000], 2);
    ExpectVector(result.goto, [100 - 1300, 0, 2000 + 400 * (100 / 400) ** 0.25], 2);
    expect(result.error).toBeCloseTo(Math.hypot(1300, 1400), 2);
    expect(result.anchorSpeed).toBeCloseTo(100, 9);
    expect(result.memberSpeed).toBe(0);
    ExpectVector(result.forward, [1, 0, 0]);
  });

  it('stays finite for zero velocities and coincident positions', () => {
    const result = FormationGoto({ anchor: { position: [0, 0, 0], velocity: [0, 0, 0], radius: 0 }, member: { ...member, radius: 0 }, frame: FleetFrame(0, 0), direction: [0, 0, -1], slotRange: 0, tickSeconds: 1 });
    for (const value of [...result.point, ...result.goto, ...result.forward, result.error, result.anchorSpeed, result.memberSpeed]) expect(Number.isFinite(value)).toBe(true);
    ExpectVector(result.goto, [0, 0, 0]);
  });
});

describe('WarpFrame and FramePoint', () => {
  it('faces the landing: +Z, +X, 45 degrees up, and yaw 0 for a zero vector', () => {
    ExpectVector(RotateVector(WarpFrame([0, 0, 0], [0, 0, 500000]), [0, 0, 1]), [0, 0, 1]);
    ExpectVector(RotateVector(WarpFrame([100, 0, 0], [400100, 0, 0]), [0, 0, 1]), [1, 0, 0]);
    ExpectVector(RotateVector(WarpFrame([0, 0, 0], [0, 300000, 300000]), [0, 0, 1]), [0, Math.SQRT1_2, Math.SQRT1_2]);
    ExpectVector(RotateVector(WarpFrame([0, 0, 0], [0, 300000, 300000]), [0, 1, 0]), [0, Math.SQRT1_2, -Math.SQRT1_2]);
    ExpectVector(RotateVector(WarpFrame([5, 5, 5], [5, 5, 5]), [0, 0, 1]), [0, 0, 1]);
  });

  it('agrees with FleetFrame at the legacy heading of the warp', () => {
    const from = [1000, -2000, 3000];
    const to = [-250000, 90000, 410000];
    const [x, y, z] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const expected = FleetFrame(Math.atan2(x, z), -Math.asin(y / Math.hypot(x, y, z)));
    const frame = WarpFrame(from, to);
    for (let index = 0; index < 4; index++) expect(frame[index]).toBeCloseTo(expected[index], 12);
    ExpectVector(RotateVector(frame, [0, 0, 1]), HeadingForward(Math.atan2(x, z), -Math.asin(y / Math.hypot(x, y, z))));
  });

  it('places an offset in the frame from the origin', () => {
    // FleetFrame is a float32 quaternion: about 1e-7 of the offset.
    ExpectVector(FramePoint({ origin: [10, 20, 30], frame: FleetFrame(Math.PI / 2, 0), offset: [0, 0, 1000] }), [1010, 20, 30], 3);
    ExpectVector(FramePoint({ origin: [10, 20, 30], frame: FleetFrame(Math.PI / 2, 0), offset: [1000, 5, 0] }), [10, 25, -970], 3);
  });
});
