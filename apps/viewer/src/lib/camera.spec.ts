import { describe, expect, it } from 'vitest';
import { CAMERA_GLIDE_SECONDS, CameraFollow, CHASE_PITCH, ChaseAngles, EaseAngle, PickShip, type FollowedView, type PickSphere } from './camera';
import { TICKS_PER_SECOND } from './clock';
import { quat, vec3 } from './runtime-sim';

const DEGREES = Math.PI / 180;

/**
 * Where EveCamera puts the eye: the focus plus (0, 0, distance) turned by fromYawPitchRoll(yaw, pitch, 0).
 */
function Eye(focus: number[], distance: number, yaw: number, pitch: number): number[] {
  const rotation = quat.fromYawPitchRoll(quat.create(), yaw * DEGREES, pitch * DEGREES, 0);
  const offset = vec3.transformQuat(vec3.create(), vec3.fromValues(0, 0, distance), rotation);
  return [0, 1, 2].map((axis) => focus[axis] + offset[axis]);
}

/**
 * EveCamera's view matrix: gl-matrix's lookAt (the runtime's mat4.lookAt) from the eye to the focus, with the
 * camera's own up.
 */
function ViewMatrix(focus: number[], distance: number, yaw: number, pitch: number): number[] {
  const eye = Eye(focus, distance, yaw, pitch);
  const rotation = quat.fromYawPitchRoll(quat.create(), yaw * DEGREES, pitch * DEGREES, 0);
  const up = Array.from(vec3.transformQuat(vec3.create(), vec3.fromValues(0, 1, 0), rotation));
  const z = Normalize([0, 1, 2].map((axis) => eye[axis] - focus[axis]));
  const x = Normalize(Cross(up, z));
  const y = Cross(z, x);
  const dot = (a: number[]): number => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x), -dot(y), -dot(z), 1];
}

function Cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function Normalize(a: number[]): number[] {
  const length = Math.hypot(a[0], a[1], a[2]);
  return a.map((value) => value / length);
}

/**
 * The pixel a world point lands on, through the same pinhole the pick inverts.
 */
function Project(view: number[], fov: number, width: number, height: number, point: number[]): [number, number] {
  const camera = [0, 1, 2].map((row) => view[row] * point[0] + view[row + 4] * point[1] + view[row + 8] * point[2] + view[row + 12]);
  const tanHalf = Math.tan((fov * DEGREES) / 2);
  const across = camera[0] / -camera[2] / tanHalf / (width / height);
  const down = camera[1] / -camera[2] / tanHalf;
  return [((across + 1) / 2) * width, ((1 - down) / 2) * height];
}

function View(yaw = 0, pitch = 0): FollowedView & { focus: number[] } {
  return { focus: [0, 0, 0], yaw, pitch };
}

const SECOND = TICKS_PER_SECOND;

describe('ChaseAngles', () => {
  it('puts the eye behind the heading, CHASE_PITCH above it', () => {
    for (const forward of [
      [1, 0, 0],
      [0, 0, 1],
      [-3, 0, 4],
      [0.6, 0.3, -0.7]
    ]) {
      const angles = ChaseAngles(forward);
      expect(angles).not.toBeNull();
      const eye = Normalize(Eye([0, 0, 0], 1, angles?.yaw ?? 0, (angles?.pitch ?? 0) - CHASE_PITCH));
      const back = Normalize(forward.map((value) => -value));
      for (let axis = 0; axis < 3; axis++) expect(eye[axis]).toBeCloseTo(back[axis], 5);
    }
  });

  it('a heading of yaw h gives a camera yaw of h + 180', () => {
    const heading = 70;
    const angles = ChaseAngles([Math.sin(heading * DEGREES), 0, Math.cos(heading * DEGREES)]);
    expect((((angles?.yaw ?? 0) % 360) + 360) % 360).toBeCloseTo(250, 5);
    expect(angles?.pitch).toBeCloseTo(CHASE_PITCH, 5);
  });

  it('has no angles for a zero vector', () => {
    expect(ChaseAngles([0, 0, 0])).toBeNull();
  });
});

describe('EaseAngle', () => {
  it('goes the short way round', () => {
    expect(EaseAngle(350, 10, 1, 0.3)).toBeGreaterThan(350);
    expect(EaseAngle(10, 350, 1, 0.3)).toBeLessThan(10);
    expect(EaseAngle(350, 10, 100, 0.3)).toBeCloseTo(370, 5);
  });
});

describe('PickShip', () => {
  const width = 1600;
  const height = 900;
  const fov = 45;

  it('picks the ship drawn under the pointer, off centre and from any angle', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [200, -20],
      [-75, 40]
    ]) {
      const view = ViewMatrix([100, 0, 0], 3000, yaw, pitch);
      const spheres: PickSphere[] = [
        { id: 'a', centre: [100, 0, 0], radius: 60 },
        { id: 'b', centre: [700, 200, -300], radius: 60 },
        { id: 'c', centre: [-400, -250, 300], radius: 60 }
      ];
      for (const sphere of spheres) {
        const [x, y] = Project(view, fov, width, height, Array.from(sphere.centre));
        expect(PickShip({ view, fov, width, height }, x, y, spheres)).toBe(sphere.id);
      }
    }
  });

  it('takes the nearest of two ships on the ray, skips ships behind the eye and misses empty space', () => {
    const view = ViewMatrix([0, 0, 0], 1000, 0, 0);
    const near = { id: 'near', centre: [0, 0, 200], radius: 50 };
    const far = { id: 'far', centre: [0, 0, -500], radius: 300 };
    const behind = { id: 'behind', centre: [0, 0, 2000], radius: 50 };
    expect(PickShip({ view, fov, width, height }, width / 2, height / 2, [far, behind, near])).toBe('near');
    expect(PickShip({ view, fov, width, height }, 10, 10, [far, behind, near])).toBeNull();
  });

  it('gives a distant frigate a few pixels of slack', () => {
    const view = ViewMatrix([0, 0, 0], 100_000, 0, 0);
    const frigate = { id: 'frigate', centre: [0, 0, 0], radius: 40 };
    expect(PickShip({ view, fov, width, height }, width / 2 + 6, height / 2 - 5, [frigate])).toBe('frigate');
    expect(PickShip({ view, fov, width, height }, width / 2 + 30, height / 2, [frigate])).toBeNull();
  });
});

describe('CameraFollow', () => {
  it('moves the focus with the ship and keeps a pan made meanwhile', () => {
    const follow = new CameraFollow();
    const view = View();
    follow.Follow({ id: 's', position: [0, 0, 0] }, null, 0);
    follow.Frame(0, view, () => ({ position: [10, 0, 0], forward: [1, 0, 0] }));
    expect(view.focus).toEqual([10, 0, 0]);
    view.focus[1] += 50;
    follow.Frame(SECOND / 60, view, () => ({ position: [25, 0, 5], forward: [1, 0, 0] }));
    expect(view.focus).toEqual([25, 50, 5]);
    follow.Follow(null, null, SECOND);
    follow.Frame(SECOND, view, () => ({ position: [1000, 0, 0], forward: [1, 0, 0] }));
    expect(view.focus).toEqual([25, 50, 5]);
  });

  it('orbit mode leaves the angles alone', () => {
    const follow = new CameraFollow();
    const view = View(33, -7);
    follow.Follow({ id: 's', position: [0, 0, 0] }, null, 0);
    for (let frame = 0; frame < 120; frame++) follow.Frame((frame * SECOND) / 60, view, () => ({ position: [frame, 0, 0], forward: [1, 0, 0] }));
    expect([view.yaw, view.pitch]).toEqual([33, -7]);
  });

  it('chase swings behind the heading, holds a drag and eases back once released', () => {
    const follow = new CameraFollow();
    follow.mode = 'chase';
    const view = View(0, -15);
    const heading = { position: [0, 0, 0], forward: [1, 0, 0] };
    follow.Follow({ id: 's', position: [0, 0, 0] }, null, 0);
    let now = 0;
    const run = (seconds: number): void => {
      for (let frame = 0; frame < seconds * 60; frame++) {
        now += SECOND / 60;
        follow.Frame(now, view, () => heading);
      }
    };
    run(3);
    // Behind a ship flying +X the eye sits at -X: yaw 270 (-90).
    expect(((view.yaw % 360) + 360) % 360).toBeCloseTo(270, 1);
    expect(view.pitch).toBeCloseTo(CHASE_PITCH, 1);

    follow.dragging = true;
    view.yaw += 40;
    run(2);
    expect(((view.yaw % 360) + 360) % 360).toBeCloseTo(310, 1);

    follow.dragging = false;
    run(5);
    expect(((view.yaw % 360) + 360) % 360).toBeCloseTo(270, 0);
  });

  it('glides the focus in from the old view on a retarget', () => {
    const follow = new CameraFollow();
    const view = View();
    follow.Follow({ id: 'b', position: [0, 0, 0] }, [-1000, 0, 0], 0);
    follow.Frame(0, view, () => ({ position: [0, 0, 0], forward: null }));
    expect(view.focus[0]).toBeCloseTo(-1000, 5);
    follow.Frame((CAMERA_GLIDE_SECONDS / 2) * SECOND, view, () => ({ position: [0, 0, 0], forward: null }));
    expect(view.focus[0]).toBeGreaterThan(-1000);
    expect(view.focus[0]).toBeLessThan(0);
    follow.Frame(CAMERA_GLIDE_SECONDS * SECOND, view, () => ({ position: [0, 0, 0], forward: null }));
    expect(view.focus[0]).toBeCloseTo(0, 5);
  });
});
