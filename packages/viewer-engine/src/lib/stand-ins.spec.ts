import { describe, expect, it } from 'vitest';
import { quat, vec3 } from './runtime-sim';
import {
  DrawsAsCube,
  NEUTRAL_STAND_IN_COLOR,
  PackStandInCubes,
  STAND_IN_DEATH_COLOR,
  STAND_IN_DEATH_SCALE,
  STAND_IN_FLOATS,
  STAND_IN_HIT_FLASH_SECONDS,
  STAND_IN_MISS_OFFSET,
  STAND_IN_TRACER_SECONDS,
  STAND_IN_TRACER_WIDTH,
  StandInDeathPop,
  StandInHitColor,
  StandInShots,
  StandInTeamColor,
  StandInTracerOf,
  StandInViewProjection,
  type StandInCube
} from './stand-ins';

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

describe('PackStandInCubes with half extents', () => {
  it('scales each axis by its own half extent', () => {
    const box: StandInCube = { position: [0, 0, 0], rotation: [0, 0, 0, 1], radius: 1, halfExtents: [2, 3, 50], color: [1, 1, 1] };
    const model = PackStandInCubes([box], [0, 0, 0], new Float32Array(STAND_IN_FLOATS)).subarray(0, 16);
    expect([model[0], model[5], model[10]]).toEqual([2, 3, 50]);
  });
});

describe('StandInTracerOf', () => {
  const base = { from: [0, 0, 0], to: [0, 0, 1000], targetRadius: 100, side: 1 as const, eye: [0, 500, 500], color: [0.2, 0.4, 0.8] as const };

  it('spans shooter to target, its +Z along the shot, its width from the eye distance', () => {
    const tracer = StandInTracerOf({ ...base, hit: true });
    expect(tracer).not.toBeNull();
    expect(Array.from(tracer?.position ?? [])).toEqual([0, 0, 500]);
    expect(tracer?.halfExtents?.[2]).toBe(500);
    expect(tracer?.halfExtents?.[0]).toBeCloseTo((STAND_IN_TRACER_WIDTH * 500) / 2, 9);
    const nose = vec3.transformQuat(vec3.create(), [0, 0, 1], tracer?.rotation as never);
    expect(nose[2]).toBeCloseTo(1, 9);
    [0.6, 0.7, 0.9].forEach((channel, index) => expect(tracer?.color[index]).toBeCloseTo(channel, 9));
    const sideways = StandInTracerOf({ ...base, to: [1000, 0, 0], hit: true });
    expect(vec3.transformQuat(vec3.create(), [0, 0, 1], sideways?.rotation as never)[0]).toBeCloseTo(1, 9);
    expect(StandInTracerOf({ ...base, to: [0, 0, -1000], hit: true })?.position[2]).toBe(-500);
  });

  it('ends a miss past and aside of its target, the side by parity', () => {
    const left = StandInTracerOf({ ...base, hit: false });
    const right = StandInTracerOf({ ...base, hit: false, side: -1 });
    const offset = STAND_IN_MISS_OFFSET * 100;
    expect(left?.position[2]).toBeCloseTo((1000 + offset) / 2, 6);
    expect(left?.position[0]).toBeCloseTo(-(right?.position[0] ?? 0), 6);
    expect(Math.abs(left?.position[0] ?? 0)).toBeCloseTo(offset / 2, 6);
  });

  it('draws nothing when the ends meet', () => {
    expect(StandInTracerOf({ ...base, to: [0, 0, 0], hit: true })).toBeNull();
  });
});

describe('StandInDeathPop and StandInHitColor', () => {
  it('swells orange to white over the pop', () => {
    expect(StandInDeathPop(0)).toEqual({ scale: 1, color: STAND_IN_DEATH_COLOR });
    expect(StandInDeathPop(1)).toEqual({ scale: STAND_IN_DEATH_SCALE, color: [1, 1, 1] });
    expect(StandInDeathPop(2).scale).toBe(STAND_IN_DEATH_SCALE);
  });

  it('flashes white back to its colour', () => {
    expect(StandInHitColor([0.2, 0.4, 0.6], 0)).toEqual([1, 1, 1]);
    [0.2, 0.4, 0.6].forEach((channel, index) => expect(StandInHitColor([0.2, 0.4, 0.6], 1)[index]).toBeCloseTo(channel, 9));
  });
});

describe('StandInShots', () => {
  it('keeps tracers for their window, flashes hits, prunes and clears', () => {
    const shots = new StandInShots();
    shots.Add({ ship: 'a', target: 'b', at: 10, hit: true, side: 1, color: [1, 0, 0] });
    shots.Add({ ship: 'a', target: 'b', at: 10.1, hit: false, side: -1, color: [1, 0, 0] });
    expect(shots.Live(10.05)).toHaveLength(1);
    expect(shots.Live(10.15)).toHaveLength(2);
    expect(shots.FlashOf('b', 10.1)).toBeCloseTo(0.1 / STAND_IN_HIT_FLASH_SECONDS, 9);
    expect(shots.FlashOf('a', 10.1)).toBeNull();
    expect(shots.Live(10 + STAND_IN_TRACER_SECONDS + 0.01)).toHaveLength(1);
    expect(shots.size).toBe(1);
    shots.Live(11);
    expect(shots.size).toBe(0);
    shots.Add({ ship: 'a', target: 'b', at: 12, hit: true, side: 1, color: [1, 0, 0] });
    shots.Clear();
    expect(shots.Live(12)).toEqual([]);
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

describe('DrawsAsCube', () => {
  it('draws stand-ins and failed builds only', () => {
    expect(DrawsAsCube('stand-in')).toBe(true);
    expect(DrawsAsCube('failed')).toBe(true);
    for (const status of ['queued', 'building', 'ready', 'validated', 'destroyed']) expect(DrawsAsCube(status)).toBe(false);
  });
});
