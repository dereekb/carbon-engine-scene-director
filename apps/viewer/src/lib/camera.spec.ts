import { describe, expect, it } from 'vitest';
import { CAMERA_GLIDE_SECONDS, CameraFollow, CHASE_PITCH, ChaseAngles, EaseAngle, FIT_MARGIN, OrbitFitDistance, PanMetresPerPixel, PickShip, ReframesAfterEdit, type FollowedView, type PickSphere } from './camera';
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
 * EveCamera's projection scale terms, as CalculateProjectionMatrix builds them: Carbon narrows the view above an
 * aspect of 1.6.
 */
function Projection(fov: number, width: number, height: number): number[] {
  const aspect = width / height;
  const clamp = aspect > 1.6 ? aspect / 1.6 : 1;
  const halfHeight = Math.tan((fov * DEGREES) / 2) / clamp;
  const matrix = new Array<number>(16).fill(0);
  matrix[0] = 1 / (aspect * halfHeight);
  matrix[5] = 1 / halfHeight;
  return matrix;
}

/**
 * The pixel a world point lands on, through the projection the pick inverts.
 */
function Project(view: number[], projection: number[], width: number, height: number, point: number[]): [number, number] {
  const camera = [0, 1, 2].map((row) => view[row] * point[0] + view[row + 4] * point[1] + view[row + 8] * point[2] + view[row + 12]);
  const across = (camera[0] / -camera[2]) * projection[0];
  const down = (camera[1] / -camera[2]) * projection[5];
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
  // 1600 x 900 is wider than 1.6, so Carbon's aspect clamp applies.
  const width = 1600;
  const height = 900;
  const projection = Projection(45, width, height);

  it('picks the ship drawn under the pointer, off centre, from any angle and at the field of view drawn', () => {
    // A narrow and the default field of view, on a clamped wide canvas and a portrait one.
    for (const [w, h] of [
      [width, height],
      [700, 1000]
    ]) {
      for (const fov of [45, 90]) {
        for (const [yaw, pitch] of [
          [0, 0],
          [200, -20],
          [-75, 40]
        ]) {
          const view = ViewMatrix([100, 0, 0], 3000, yaw, pitch);
          const drawn = Projection(fov, w, h);
          const spheres: PickSphere[] = [
            { id: 'a', centre: [100, 0, 0], radius: 60 },
            { id: 'b', centre: [700, 200, -300], radius: 60 },
            { id: 'c', centre: [-400, -250, 300], radius: 60 }
          ];
          for (const sphere of spheres) {
            const [x, y] = Project(view, drawn, w, h, Array.from(sphere.centre));
            expect(PickShip({ view, projection: drawn, width: w, height: h }, x, y, spheres)).toBe(sphere.id);
          }
        }
      }
    }
  });

  it('misses a ship off centre when the projection assumed is not the one drawn', () => {
    const view = ViewMatrix([0, 0, 0], 3000, 0, 0);
    const ship = { id: 'off', centre: [1500, 0, 0], radius: 60 };
    const [x, y] = Project(view, Projection(90, width, height), width, height, ship.centre);
    expect(PickShip({ view, projection: Projection(90, width, height), width, height }, x, y, [ship])).toBe('off');
    expect(PickShip({ view, projection: Projection(45, width, height), width, height }, x, y, [ship])).toBeNull();
  });

  it('takes the nearest of two ships on the ray, skips ships behind the eye and misses empty space', () => {
    const view = ViewMatrix([0, 0, 0], 1000, 0, 0);
    const near = { id: 'near', centre: [0, 0, 200], radius: 50 };
    const far = { id: 'far', centre: [0, 0, -500], radius: 300 };
    const behind = { id: 'behind', centre: [0, 0, 2000], radius: 50 };
    expect(PickShip({ view, projection, width, height }, width / 2, height / 2, [far, behind, near])).toBe('near');
    expect(PickShip({ view, projection, width, height }, 10, 10, [far, behind, near])).toBeNull();
  });

  it('gives a distant frigate a few pixels of slack', () => {
    const view = ViewMatrix([0, 0, 0], 100_000, 0, 0);
    const frigate = { id: 'frigate', centre: [0, 0, 0], radius: 40 };
    expect(PickShip({ view, projection, width, height }, width / 2 + 6, height / 2 - 5, [frigate])).toBe('frigate');
    expect(PickShip({ view, projection, width, height }, width / 2 + 30, height / 2, [frigate])).toBeNull();
  });
});

describe('OrbitFitDistance', () => {
  const ASPECTS = [0.7, 1, 1.6, 1960 / 1062, 2.4];

  it("puts a sphere's silhouette across 1 / FIT_MARGIN of the view's narrower extent at any fov and aspect", () => {
    const radius = 250;
    for (const fov of [20, 45, 90, 120]) {
      for (const aspect of ASPECTS) {
        const distance = OrbitFitDistance(radius, fov, aspect);
        const projection = Projection(fov, aspect * 1000, 1000);
        const narrower = Math.min(1 / projection[0], 1 / projection[5]);
        // The silhouette's half-angle a has sin a = radius / distance.
        const silhouette = Math.tan(Math.asin(radius / distance));
        expect(silhouette / narrower).toBeCloseTo(1 / FIT_MARGIN, 10);
      }
    }
  });

  it("fits the user's 1960 x 1062 canvas at 1.661 radii at 90 degrees and 3.355 at 45; a sphere under 1 m fits as 1 m", () => {
    expect(OrbitFitDistance(100, 90, 1960 / 1062) / 100).toBeCloseTo(1.661, 3);
    expect(OrbitFitDistance(100, 45, 1960 / 1062) / 100).toBeCloseTo(3.355, 3);
    expect(OrbitFitDistance(0.2, 90, 1.6)).toBe(OrbitFitDistance(1, 90, 1.6));
  });
});

describe('PanMetresPerPixel', () => {
  it('moves a point on the focus plane as many pixels as the pointer, along the view axes', () => {
    const focus = [400, -120, 900];
    const distance = 3000;
    for (const fov of [45, 90]) {
      for (const [width, height] of [
        [1600, 900],
        [1000, 1000],
        [2400, 1000],
        [700, 1000]
      ]) {
        const view = ViewMatrix(focus, distance, 30, -20);
        const projection = Projection(fov, width, height);
        const metres = PanMetresPerPixel(distance, fov, width / height, height);
        // The view matrix rows are the camera's right and up axes in world space.
        const right = [view[0], view[4], view[8]];
        const up = [view[1], view[5], view[9]];
        const [x, y] = Project(
          view,
          projection,
          width,
          height,
          [0, 1, 2].map((axis) => focus[axis] + right[axis] * 200 * metres)
        );
        expect(x).toBeCloseTo(width / 2 + 200, 3);
        expect(y).toBeCloseTo(height / 2, 3);
        const [upX, upY] = Project(
          view,
          projection,
          width,
          height,
          [0, 1, 2].map((axis) => focus[axis] + up[axis] * 120 * metres)
        );
        expect(upX).toBeCloseTo(width / 2, 3);
        expect(upY).toBeCloseTo(height / 2 - 120, 3);
      }
    }
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

describe('CameraFollow at any frame rate (sd-export)', () => {
  /**
   * The chase camera behind a ship turning at 20°/s while climbing, framed at `fps` for 12 s.
   *
   * @returns The yaw and pitch at each frame's clock.
   */
  function Chase(fps: number): Map<number, [number, number]> {
    const follow = new CameraFollow();
    follow.mode = 'chase';
    const view = View(0, -15);
    follow.Follow({ id: 's', position: [0, 0, 0] }, null, 0);
    const angles = new Map<number, [number, number]>();
    for (let index = 0; index <= 12 * fps; index++) {
      const now = Math.round((index * SECOND) / fps);
      const turn = (20 * DEGREES * now) / SECOND;
      follow.Frame(now, view, () => ({ position: [0, 0, 0], forward: [Math.cos(turn), 0.3 * Math.sin(turn / 3), Math.sin(turn)] }));
      angles.set(now, [view.yaw, view.pitch]);
    }
    return angles;
  }

  it('swings the chase on a turning ship within 0.2° at 30 and 60 fps', () => {
    const at30 = Chase(30);
    const at60 = Chase(60);
    let gap = 0;
    for (const [now, [yaw, pitch]] of at30) {
      const [yaw60, pitch60] = at60.get(now) ?? [NaN, NaN];
      gap = Math.max(gap, Math.abs(((((yaw - yaw60 + 540) % 360) + 360) % 360) - 180), Math.abs(pitch - pitch60));
    }
    if (process.env['SD_EXPORT_MEASURE']) console.log(`chase 30 vs 60 fps: ${gap.toFixed(4)}°`);
    expect(gap).toBeLessThan(0.2);
  });
});

describe('ReframesAfterEdit', () => {
  const edit = { restart: false, cameraChanged: false, following: 'fc', removed: [] as string[] };

  it('keeps a camera that follows a ship through edits that leave the ship and the camera alone', () => {
    expect(ReframesAfterEdit(edit)).toBe(false);
    expect(ReframesAfterEdit({ ...edit, removed: ['other'] })).toBe(false);
  });

  it('frames the document camera on a load, a camera change, or when the followed ship is removed', () => {
    expect(ReframesAfterEdit({ ...edit, restart: true })).toBe(true);
    expect(ReframesAfterEdit({ ...edit, cameraChanged: true })).toBe(true);
    expect(ReframesAfterEdit({ ...edit, removed: ['fc'] })).toBe(true);
  });

  it('re-fits on every edit while the camera follows no ship', () => {
    expect(ReframesAfterEdit({ ...edit, following: null })).toBe(true);
  });
});
