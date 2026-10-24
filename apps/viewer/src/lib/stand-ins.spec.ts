import { describe, expect, it } from 'vitest';
import { quat, vec3 } from './runtime-sim';
import { NEUTRAL_STAND_IN_COLOR, PackStandInCubes, STAND_IN_FLOATS, StandInTeamColor, StandInViewProjection, type StandInCube } from './stand-ins';

/**
 * A column-major 4×4 times a point.
 */
function Transform(matrix: ArrayLike<number>, point: readonly number[]): number[] {
  return [0, 1, 2, 3].map((row) => matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row] * (point[3] ?? 1));
}

describe('StandInTeamColor', () => {
  it('takes a team named after a colour, keeps green off the green screen, and greys a ship with no team', () => {
    expect(StandInTeamColor('Red')).toEqual([0.86, 0.2, 0.18]);
    expect(StandInTeamColor(' blue ')).toEqual([0.2, 0.42, 0.9]);
    expect(StandInTeamColor('green')[1]).toBeLessThan(0.4);
    expect(StandInTeamColor(null)).toBe(NEUTRAL_STAND_IN_COLOR);
    expect(StandInTeamColor('')).toBe(NEUTRAL_STAND_IN_COLOR);
  });

  it('gives any other team a stable palette colour', () => {
    expect(StandInTeamColor('Goonswarm')).toBe(StandInTeamColor('goonswarm'));
    expect(StandInTeamColor('Goonswarm')).not.toBe(NEUTRAL_STAND_IN_COLOR);
  });
});

describe('PackStandInCubes', () => {
  const rotation = quat.setAxisAngle(quat.create(), vec3.normalize(vec3.create(), [1, 2, 3]), 1.1);
  const cube: StandInCube = { position: [5000, -200, 1e6], rotation, radius: 300, color: [0.1, 0.2, 0.3] };
  const eye = [4000, 100, 1e6 - 50];
  const packed = PackStandInCubes([cube, cube], eye, new Float32Array(2 * STAND_IN_FLOATS));
  const model = packed.subarray(0, 16);

  it('places the cube relative to the eye, with its nose (local +Z) along the ball heading', () => {
    expect(Transform(model, [0, 0, 0])).toEqual([1000, -300, 50, 1]);
    const nose = Transform(model, [0, 0, 1, 0]).slice(0, 3);
    const heading = vec3.transformQuat(vec3.create(), [0, 0, 1], rotation);
    for (let axis = 0; axis < 3; axis++) expect(nose[axis]).toBeCloseTo((heading[axis] * 300) / Math.sqrt(3), 3);
  });

  it('sizes the cube so its corners touch the ball', () => {
    const corner = Transform(model, [1, 1, 1, 0]).slice(0, 3);
    expect(Math.hypot(corner[0], corner[1], corner[2])).toBeCloseTo(300, 2);
  });

  it('packs the colour after the matrix, one cube per stride', () => {
    expect(Array.from(packed.subarray(16, 20))).toEqual([0.1, 0.2, 0.3, 1].map(Math.fround));
    expect(Array.from(packed.subarray(STAND_IN_FLOATS, 2 * STAND_IN_FLOATS))).toEqual(Array.from(packed.subarray(0, STAND_IN_FLOATS)));
  });
});

describe('StandInViewProjection', () => {
  it('maps an eye-relative point where projection × view maps the world point', () => {
    const eye = [120, 40, -300];
    const angle = 0.7;
    // A view looking down -Z, turned about Y, at the eye: rotation R, translation -R·eye.
    const rotation = [Math.cos(angle), 0, Math.sin(angle), 0, 0, 1, 0, 0, -Math.sin(angle), 0, Math.cos(angle), 0, 0, 0, 0, 1];
    const translated = Transform(rotation, [-eye[0], -eye[1], -eye[2], 1]);
    const view = [...rotation.slice(0, 12), translated[0], translated[1], translated[2], 1];
    const projection = [1.2, 0, 0, 0, 0, 1.9, 0, 0, 0, 0, -1.0001, -1, 0, 0, -0.5, 0];
    const combined = StandInViewProjection(view, projection, new Float32Array(16));
    const world = [500, -80, -2000];
    const expected = Transform(projection, Transform(view, world));
    const actual = Transform(combined, [world[0] - eye[0], world[1] - eye[1], world[2] - eye[2]]);
    for (let index = 0; index < 4; index++) expect(actual[index]).toBeCloseTo(expected[index], 2);
  });
});
