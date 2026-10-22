import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle } from '../cinema/vectors';
import { normalizeCameraShot } from '../cinema/shot';
import type { SceneVector } from '../scene';
import { measureWaypointPath, pathDistanceAt, pathPointAt, readWaypoints, resolveWaypoint, type WaypointAnchor, type WaypointContext } from './waypoints';

const DEGREES = Math.PI / 180;

function Close(actual: readonly number[] | null | undefined, expected: readonly number[], digits = 6): void {
  expect(actual).toBeTruthy();
  expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, digits));
}

const ANCHORS: Record<string, WaypointAnchor> = {
  // Facing +X (yaw 90): forward +X, starboard +Z.
  ship: { centre: [1000, 0, 0], rotation: quatFromAxisAngle([0, 1, 0], 90 * DEGREES), radius: 50 },
  // Rolled 90° about its forward (+Z).
  rolled: { centre: [0, 0, 0], rotation: quatFromAxisAngle([0, 0, 1], 90 * DEGREES), radius: 10 }
};
const CONTEXT: WaypointContext = { anchorOf: (ref) => ANCHORS[ref.ship ?? ref.object ?? ''] ?? null };

describe('resolveWaypoint', () => {
  it('resolves points in space and bare points in the world or a frame', () => {
    Close(resolveWaypoint({ position: [1, 2, 3] }, CONTEXT), [1, 2, 3]);
    Close(resolveWaypoint([1, 2, 3], CONTEXT), [1, 2, 3]);
    const frame = { centre: [10, 0, 0] as SceneVector, forward: [0, 0, 1] as SceneVector, starboard: [-1, 0, 0] as SceneVector, up: [0, 1, 0] as SceneVector };
    Close(resolveWaypoint([5, 2, 1], { ...CONTEXT, frame }), [8, 1, 5]);
  });

  it('rides on a hull in its heading frame, in metres or radii', () => {
    Close(resolveWaypoint({ ship: 'ship', offset: [100, 20, 10] }, CONTEXT), [1100, 10, 20]);
    Close(resolveWaypoint({ ship: 'ship', offset: [2, 0, 1], units: 'radii' }, CONTEXT), [1100, 50, 0]);
    Close(resolveWaypoint({ ship: 'ship' }, CONTEXT), [1000, 0, 0]);
  });

  it('stays level unless banked', () => {
    Close(resolveWaypoint({ ship: 'rolled', offset: [0, 0, 10] }, CONTEXT), [0, 10, 0]);
    Close(resolveWaypoint({ ship: 'rolled', offset: [0, 0, 10], bank: true }, CONTEXT), [-10, 0, 0]);
  });

  it('is null for a hull not in the scene', () => {
    expect(resolveWaypoint({ ship: 'gone' }, CONTEXT)).toBeNull();
    expect(resolveWaypoint({ object: 'gone' }, CONTEXT)).toBeNull();
  });
});

describe('readWaypoints', () => {
  it('reads each kind and reports every problem', () => {
    const problems: string[] = [];
    const warnings: string[] = [];
    const read = readWaypoints([[0, 0, 0], { position: [1, 0, 0], time: 2 }, { ship: 'a', offset: [1, 0, 0], units: 'radii', bank: true, colour: 'red' }], 'points', problems, warnings);
    expect(problems).toEqual([]);
    expect(read).toHaveLength(3);
    expect(warnings[0]).toMatch(/colour/u);
    const bad: string[] = [];
    readWaypoints(
      [
        { ship: 'a', object: 'b' },
        { position: [0, 0, 0], offset: [1, 0, 0] },
        { ship: 'a', units: 'feet' },
        { ship: 'a', time: 5 },
        { ship: 'a', time: 3 }
      ],
      'points',
      bad
    );
    expect(bad.join('\n')).toMatch(/exactly one of position/u);
    expect(bad.join('\n')).toMatch(/not a position/u);
    expect(bad.join('\n')).toMatch(/units/u);
    expect(bad.join('\n')).toMatch(/goes back/u);
    const short: string[] = [];
    readWaypoints([[0, 0, 0]], 'points', short);
    expect(short[0]).toMatch(/at least 2/u);
  });

  it('reads a path move of waypoints with a look and up on hulls', () => {
    const { shot, problems } = normalizeCameraShot({
      pose: { eye: [0, 0, -100], look: [0, 0, 0] },
      duration: 10,
      clearance: false,
      moves: [
        {
          type: 'path',
          points: [
            { ship: 'a', offset: [-1, 0, 0.5], units: 'radii' },
            { ship: 'a', offset: [1, 0, 0.5], units: 'radii' }
          ],
          look: { ship: 'b' },
          up: { ship: 'a' }
        }
      ]
    });
    expect(problems).toEqual([]);
    expect(shot?.clearance).toBe(false);
    expect(shot?.moves[0]).toMatchObject({ type: 'path', frame: 'world', look: { ship: 'b' }, up: { ship: 'a' } });
    expect(
      normalizeCameraShot({
        pose: { eye: [0, 0, -1], look: [0, 0, 0] },
        duration: 1,
        moves: [
          {
            type: 'path',
            points: [
              [0, 0, 0],
              [1, 0, 0]
            ],
            up: 'sideways'
          }
        ]
      }).problems[0]
    ).toMatch(/up must be/u);
  });
});

describe('waypoint paths', () => {
  const points: SceneVector[] = [
    [0, 0, 0],
    [100, 0, 0],
    [200, 0, 0],
    [300, 0, 0]
  ];

  it('measures arc length through the waypoints', () => {
    const path = measureWaypointPath(points);
    expect(path.total).toBeCloseTo(300, 3);
    path.knots.forEach((knot, index) => expect(knot).toBeCloseTo(index * 100, 3));
    Close(pathPointAt(path, 150), [150, 0, 0], 3);
  });

  it('passes timed waypoints at their times at steady speed between', () => {
    const path = measureWaypointPath(points);
    // Waypoint 1 at 6 s, the rest spaced: 0 at 0 s, 300 at 10 s.
    const times = [null, 6, null, null];
    expect(pathDistanceAt(path, times, 3, 10)).toBeCloseTo(50, 3);
    expect(pathDistanceAt(path, times, 6, 10)).toBeCloseTo(100, 3);
    expect(pathDistanceAt(path, times, 8, 10)).toBeCloseTo(200, 3);
    expect(pathDistanceAt(path, times, 12, 10)).toBeCloseTo(300, 3);
    // A first waypoint held until 2 s.
    expect(pathDistanceAt(path, [2, null, null, null], 1, 10)).toBe(0);
  });
});
