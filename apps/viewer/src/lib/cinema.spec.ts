import { describe, expect, it } from 'vitest';
import { catmullRom, distanceVec, poseRoll, quatFromAxisAngle, type CameraMove, type CameraPose, type CinemaScene, type CinemaShip, type SceneVector } from '@scene-director/scene';
import { CINEMA_RELEASE_SECONDS, CinemaReleases, CinemaRig, LetterboxRect } from './cinema';
import { Ease, EvaluateMoves, Noise, ShakeEnvelope, Smooth, type MoveContext } from './cinema-moves';
import { TICKS_PER_SECOND } from './clock';

const DEGREES = Math.PI / 180;
const BASE: CameraPose = { eye: [0, 0, -100], look: [0, 0, 0], up: [0, 1, 0], fov: 40 };
const CONTEXT: MoveContext = { subject: null, seed: 7, shotDuration: 4 };

function Close(actual: readonly number[], expected: readonly number[], digits = 5): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits));
}

function At(moves: CameraMove[], t: number, context: MoveContext = CONTEXT): CameraPose {
  return EvaluateMoves(BASE, moves, t, context);
}

describe('easing', () => {
  it('runs each curve from 0 to 1 through ½', () => {
    for (const easing of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) {
      expect(Ease(easing, 0)).toBe(0);
      expect(Ease(easing, 1)).toBe(1);
    }
    expect(Ease('ease-in-out', 0.5)).toBeCloseTo(0.5);
    expect(Ease('ease-in', 0.5)).toBeLessThan(0.5);
    expect(Ease('ease-out', 0.5)).toBeGreaterThan(0.5);
  });
});

describe('moves', () => {
  it('dollies along the view at 0, ½ and 1, eased', () => {
    const move: CameraMove = { type: 'dolly', distance: 50, duration: 2 };
    Close(At([move], 0).eye, [0, 0, -100]);
    Close(At([move], 1).eye, [0, 0, -75]);
    Close(At([move], 2).eye, [0, 0, -50]);
    Close(At([{ ...move, easing: 'ease-in' }], 1).eye, [0, 0, -100 + 50 * 0.125]);
  });

  it('trucks along the right and cranes along the up, moving the look too', () => {
    // Looking down +Z with up +Y, the camera's right is forward × up = -X.
    const truck = At([{ type: 'truck', distance: 10, duration: 1 }], 1);
    Close(truck.eye, [-10, 0, -100]);
    Close(truck.look, [-10, 0, 0]);
    Close(At([{ type: 'crane', distance: 10, duration: 1 }], 1).look, [0, 10, 0]);
  });

  it('pushes out by a factor and zooms the lens', () => {
    Close(At([{ type: 'push', factor: 2, duration: 2 }], 2).eye, [0, 0, -200]);
    expect(At([{ type: 'push', factor: 2, duration: 2 }], 1).eye[2]).toBeCloseTo(-100 * Math.SQRT2);
    expect(At([{ type: 'zoom', fov: 20, duration: 1 }], 1).fov).toBeCloseTo(20);
  });

  it('orbits at a rate around world up and by an angle around any axis', () => {
    const quarter = At([{ type: 'orbit', axis: 'up', rate: 90 }], 1);
    Close(quarter.eye, [-100, 0, 0]);
    Close(quarter.look, [0, 0, 0]);
    const around = At([{ type: 'orbit', axis: [1, 0, 0], angle: 90, duration: 2 }], 2);
    Close(around.eye, [0, 100, 0]);
    // Before it starts, nothing turns.
    Close(At([{ type: 'orbit', axis: 'up', rate: 90, at: 2 }], 1).eye, BASE.eye);
  });

  it('orbits around the subject up', () => {
    const tilted: MoveContext = { ...CONTEXT, subject: { centre: [0, 0, 0], radius: 50, forward: [0, 0, 1], up: [1, 0, 0], starboard: [0, 1, 0], velocity: [0, 0, 0], extents: { forward: [-50, 50], starboard: [-50, 50], up: [-50, 50] } } };
    Close(At([{ type: 'orbit', axis: 'subject-up', angle: 90, duration: 1 }], 1, tilted).eye, [0, 100, 0]);
  });

  it('rolls at a rate and spins the view about the eye', () => {
    expect(poseRoll(At([{ type: 'roll', rate: 15 }], 2))).toBeCloseTo(30);
    const spun = At([{ type: 'spin', axis: 'view-up', angle: 90, duration: 1 }], 1);
    Close(spun.eye, BASE.eye);
    Close(spun.look, [100, 0, -100]);
  });

  it('flies a path end to end at a steady speed', () => {
    const points: SceneVector[] = [
      [0, 0, 0],
      [1000, 0, 0],
      [1000, 0, 1000],
      [0, 0, 1000]
    ];
    const move: CameraMove = { type: 'path', points, frame: 'world', look: 'path', up: 'base', duration: 10 };
    Close(At([move], 0).eye, points[0], 3);
    Close(At([move], 10).eye, points[3], 3);
    const steps = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((second) => distanceVec(At([move], second).eye, At([move], second + 1).eye));
    for (const step of steps) expect(step / steps[0]).toBeCloseTo(1, 1);
    // Looking along the path: at the start it heads +X.
    const start = At([move], 0.01);
    expect(start.look[0] - start.eye[0]).toBeGreaterThan(0);
  });

  it('passes the centripetal spline through its points', () => {
    const points: SceneVector[] = [
      [0, 0, 0],
      [10, 5, 0],
      [20, 0, 0]
    ];
    Close(catmullRom(points, 0, 0), points[0]);
    Close(catmullRom(points, 0, 1), points[1]);
    Close(catmullRom(points, 1, 1), points[2]);
  });

  it('flies waypoints riding on a moving ship, in space, and looks at another ship', () => {
    const target = (z: number): CinemaShip => ({ ...Ship('target', [0, 0, z]), frameRadius: 200 });
    const scene = (z: number): CinemaScene => Scene([target(z), Ship('other', [5000, 0, z])]);
    // Along the target's hull, 0.6 radii above it, from stern to bow, then out to a point in space; looking at "other".
    const move: CameraMove = {
      type: 'path',
      points: [{ ship: 'target', offset: [-1.2, 0, 0.6], units: 'radii' }, { ship: 'target', offset: [1.2, 0, 0.6], units: 'radii' }, { position: [0, 2000, 4000] }],
      frame: 'world',
      look: { ship: 'other' },
      up: 'base',
      duration: 10
    };
    const start = EvaluateMoves(BASE, [move], 0, { ...CONTEXT, shotDuration: 10, scene: scene(0) });
    Close(start.eye, [0, 120, -240], 3);
    Close(start.look, [5000, 0, 0], 3);
    // The same instant with the hull 1 km further on: the eye rides with it.
    const moved = EvaluateMoves(BASE, [move], 0, { ...CONTEXT, shotDuration: 10, scene: scene(1000) });
    Close(moved.eye, [0, 120, 760], 3);
    Close(EvaluateMoves(BASE, [move], 10, { ...CONTEXT, shotDuration: 10, scene: scene(0) }).eye, [0, 2000, 4000], 3);
  });

  it('passes timed waypoints at their times', () => {
    const move: CameraMove = { type: 'path', points: [[0, 0, 0], { position: [100, 0, 0], time: 8 }, [200, 0, 0]], frame: 'world', look: 'subject', up: 'base', duration: 10 };
    expect(At([move], 8, { ...CONTEXT, shotDuration: 10 }).eye[0]).toBeCloseTo(100, 1);
    expect(At([move], 4, { ...CONTEXT, shotDuration: 10 }).eye[0]).toBeCloseTo(50, 0);
    expect(At([move], 9, { ...CONTEXT, shotDuration: 10 }).eye[0]).toBeCloseTo(150, 0);
  });

  it("takes a hull's banked up", () => {
    const rolled: CinemaShip = { ...Ship('rolled', [0, 0, 1000]), rotation: quatFromAxisAngle([0, 0, 1], 90 * DEGREES) };
    const move: CameraMove = {
      type: 'path',
      points: [
        [0, 0, -100],
        [0, 0, -50]
      ],
      frame: 'world',
      look: { ship: 'rolled' },
      up: { ship: 'rolled' },
      duration: 1
    };
    const pose = At([move], 1, { ...CONTEXT, scene: Scene([rolled]) });
    Close(pose.up, [-1, 0, 0]);
  });

  it('shakes deterministically and decays', () => {
    const move: CameraMove = { type: 'shake', amplitude: 2, frequency: 8, decay: 0.5 };
    const a = At([move], 0.3);
    const b = At([move], 0.3);
    expect(a.look).toEqual(b.look);
    expect(At([move], 0.3, { ...CONTEXT, seed: 8 }).look).not.toEqual(a.look);
    expect(ShakeEnvelope({ type: 'shake', amplitude: 2, frequency: 8, decay: 0.5 }, 0)).toBe(1);
    expect(ShakeEnvelope({ type: 'shake', amplitude: 2, frequency: 8, decay: 0.5 }, 2)).toBeLessThan(0.02);
    for (let x = 0; x < 20; x += 0.37) expect(Math.abs(Noise(3, 0, x))).toBeLessThanOrEqual(1);
  });

  it('lags toward a target on scene time and freezes at dt 0', () => {
    expect(Smooth([0, 0, 0], [10, 0, 0], 0, 1)).toEqual([0, 0, 0]);
    expect(Smooth([0, 0, 0], [10, 0, 0], 1, 1)[0]).toBeCloseTo(10 * (1 - Math.exp(-1)));
    expect(Smooth([0, 0, 0], [10, 0, 0], 0.5, 0)).toEqual([10, 0, 0]);
    let value: SceneVector = [0, 0, 0];
    for (let frame = 0; frame < 600; frame++) value = Smooth(value, [10, 0, 0], 1 / 60, 0.5);
    expect(value[0]).toBeCloseTo(10, 3);
  });
});

function Ship(id: string, position: SceneVector, velocity: SceneVector = [0, 0, 0]): CinemaShip {
  return { id, position, rotation: quatFromAxisAngle([0, 1, 0], 0 * DEGREES), velocity, frameCentre: position, frameRadius: 50 };
}

function Scene(ships: CinemaShip[], camera?: CameraPose): CinemaScene {
  return { ships, sunDirection: [0, 0, -1], aspect: 16 / 9, ...(camera ? { camera } : {}) };
}

const SECOND = TICKS_PER_SECOND;

describe('CinemaRig', () => {
  it('plays a shot, reports its progress on scene time, and releases at its end', () => {
    const rig = new CinemaRig();
    rig.Play({ hardpoint: { name: 'chase', ship: 'a' }, duration: 2 }, 0);
    const scene = Scene([Ship('a', [0, 0, 0])]);
    const frame = rig.Frame(0, () => scene);
    expect(frame?.toOrbit).toBe(0);
    expect(frame?.pose.eye[2]).toBeLessThan(0);
    rig.Frame(SECOND, () => scene);
    expect(rig.Report().shot?.progress).toBeCloseTo(0.5);
    expect(rig.Report().state).toBe('playing');
    // The release starts on the same frame, from the last cinematic pose.
    expect(rig.Frame(2 * SECOND, () => scene)?.toOrbit).toBe(0);
    expect(rig.Report().state).toBe('releasing');
    expect(rig.Report().note).toMatch(/finished/u);
    expect(rig.Frame(2 * SECOND + 0.25 * SECOND, () => scene)?.toOrbit).toBeCloseTo(0.5);
    expect(rig.Frame(2 * SECOND + CINEMA_RELEASE_SECONDS * SECOND, () => scene)).toBeNull();
    expect(rig.Report().state).toBe('idle');
  });

  it('holds still while the clock is paused', () => {
    const rig = new CinemaRig();
    rig.Play({ hardpoint: { name: 'chase', ship: 'a' }, lag: { eye: 1 }, moves: [{ type: 'orbit', rate: 30 }] }, 0);
    let scene = Scene([Ship('a', [0, 0, 0])]);
    rig.Frame(0, () => scene);
    scene = Scene([Ship('a', [0, 0, 500])]);
    const first = rig.Frame(SECOND, () => scene);
    const again = rig.Frame(SECOND, () => scene);
    expect(again?.pose.eye).toEqual(first?.pose.eye);
  });

  it('keeps the flyby eye fixed while the ship flies past', () => {
    const rig = new CinemaRig();
    rig.Play({ hardpoint: { name: 'flyby', ship: 'a' } }, 0);
    const first = rig.Frame(0, () => Scene([Ship('a', [0, 0, 0], [0, 0, 300])]));
    const later = rig.Frame(4 * SECOND, () => Scene([Ship('a', [0, 0, 1200], [0, 0, 300])]));
    expect(later?.pose.eye).toEqual(first?.pose.eye);
    expect(later?.pose.look[2]).toBeCloseTo(1200);
  });

  it('advances a sequence on each duration and blends between shots', () => {
    const rig = new CinemaRig();
    rig.Play(
      {
        shots: [
          { hardpoint: { name: 'chase', ship: 'a' }, duration: 1 },
          { hardpoint: { name: 'bow-on', ship: 'a' }, transition: { type: 'blend', duration: 2 } }
        ]
      },
      0
    );
    const scene = Scene([Ship('a', [0, 0, 0])]);
    const chase = rig.Frame(0.9 * SECOND, () => scene);
    expect(rig.Report().sequence).toMatchObject({ index: 0, count: 2 });
    const start = rig.Frame(SECOND, () => scene);
    expect(rig.Report().sequence).toMatchObject({ index: 1, count: 2 });
    // The blend starts on the chase pose and swings round to bow-on.
    expect(distanceVec(start?.pose.eye ?? [0, 0, 0], chase?.pose.eye ?? [0, 0, 0])).toBeLessThan(1);
    const end = rig.Frame(3 * SECOND, () => scene);
    expect(end?.pose.eye[2]).toBeGreaterThan(0);
  });

  it('blends a first shot in from the drawn camera', () => {
    const rig = new CinemaRig();
    const drawn: CameraPose = { eye: [0, 5000, 0], look: [0, 0, 0], up: [0, 0, 1], fov: 60 };
    rig.Play({ hardpoint: { name: 'chase', ship: 'a' }, transition: { type: 'blend', duration: 1 } }, 0);
    const frame = rig.Frame(0, () => Scene([Ship('a', [0, 0, 0])], drawn));
    expect(frame?.pose.eye[1]).toBeCloseTo(5000);
  });

  it('ends the shot when its subject leaves the scene', () => {
    const rig = new CinemaRig();
    rig.Play({ hardpoint: { name: 'chase', ship: 'a' } }, 0);
    rig.Frame(0, () => Scene([Ship('a', [0, 0, 0])]));
    expect(rig.Frame(SECOND / 10, () => Scene([]))?.toOrbit).toBe(0);
    expect(rig.Report().state).toBe('releasing');
    expect(rig.Report().note).toMatch(/no ship "a"/u);
  });

  it('adopts the cinematic eye into an orbit view on release', () => {
    const rig = new CinemaRig();
    rig.Play({ pose: { eye: [0, 0, -100], look: [0, 0, 0] } }, 0);
    rig.Frame(0, () => Scene([]));
    const view = rig.Release(SECOND, { adopt: true });
    expect(view?.distance).toBeCloseTo(100);
    expect(view?.pitch).toBeCloseTo(0);
    expect(Math.abs(view?.yaw ?? 0)).toBeCloseTo(180);
    expect(rig.Release(SECOND, { adopt: true })).toBeNull();
  });

  it('refuses an invalid shot with every problem', () => {
    expect(() => new CinemaRig().Play({ hardpoint: { name: 'warp-in' } }, 0)).toThrow(/Invalid camera shot/u);
  });

  it('keeps the eye out of hulls and the near plane in front of them', () => {
    const rig = new CinemaRig();
    rig.Play({ pose: { eye: [10, 0, 0], look: [100, 0, 0] } }, 0);
    const frame = rig.Frame(0, () => Scene([Ship('a', [0, 0, 0])]));
    expect(distanceVec(frame?.pose.eye ?? [0, 0, 0], [0, 0, 0])).toBeCloseTo(57.5);
    expect(frame?.near).toBeLessThan(5);
  });

  it("lets a path's eye inside the hull it rides on, but keeps it out of the others", () => {
    const long: CinemaShip = { ...Ship('long', [0, 0, 0]), frameRadius: 500 };
    const shot = (clearance?: false) => ({
      pose: { eye: [0, 50, -400], look: [0, 0, 0] },
      duration: 4,
      ...(clearance === false ? { clearance } : {}),
      moves: [
        {
          type: 'path',
          points: [
            { ship: 'long', offset: [-0.8, 0, 0.1], units: 'radii' },
            { ship: 'long', offset: [0.8, 0, 0.1], units: 'radii' }
          ],
          look: 'path'
        }
      ]
    });
    const rig = new CinemaRig();
    rig.Play(shot(), 0);
    const over = rig.Frame(0, () => Scene([long]));
    Close(over?.pose.eye ?? [], [0, 50, -400]);
    expect(over?.near).toBeCloseTo(0.5);
    // Another hull in the way still pushes the eye out.
    rig.Play(shot(), 0);
    const blocked = rig.Frame(0, () => Scene([long, Ship('in-the-way', [0, 50, -390])]));
    expect(distanceVec(blocked?.pose.eye ?? [0, 0, 0], [0, 50, -390])).toBeCloseTo(57.5);
    rig.Play(shot(false), 0);
    Close(rig.Frame(0, () => Scene([long, Ship('in-the-way', [0, 50, -390])]))?.pose.eye ?? [], [0, 50, -400]);
    expect(rig.Subjects()).toEqual(['long']);
  });

  it('cuts a stop and reports the shot presentation', () => {
    const rig = new CinemaRig();
    rig.Play({ pose: { eye: [0, 0, -100], look: [0, 0, 0] }, letterbox: 2.39, hud: false }, 0);
    expect(rig.Presentation()).toEqual({ letterbox: 2.39, hud: false });
    rig.Stop(0, { cut: true });
    expect(rig.Report().state).toBe('idle');
    expect(rig.Presentation()).toEqual({});
  });
});

describe('CinemaReleases', () => {
  it('cuts on a load, releases on a camera change or a removed subject, else keeps playing', () => {
    expect(CinemaReleases({ restart: true, cameraChanged: false, removed: [], subjects: ['a'] })).toBe('cut');
    expect(CinemaReleases({ restart: false, cameraChanged: true, removed: [], subjects: [] })).toBe('release');
    expect(CinemaReleases({ restart: false, cameraChanged: false, removed: ['a'], subjects: ['a'] })).toBe('release');
    expect(CinemaReleases({ restart: false, cameraChanged: false, removed: ['b'], subjects: ['a'] })).toBe('keep');
  });
});

describe('LetterboxRect', () => {
  it('letterboxes a narrow window and pillarboxes a wide one', () => {
    expect(LetterboxRect(1600, 900, 2.39)).toEqual({ left: 0, top: 115, width: 1600, height: 669 });
    expect(LetterboxRect(1600, 900, 1)).toEqual({ left: 350, top: 0, width: 900, height: 900 });
    expect(LetterboxRect(1600, 900, false)).toEqual({ left: 0, top: 0, width: 1600, height: 900 });
  });
});

describe('CinemaRig over MCP', () => {
  const moving = (z: number): CinemaScene => Scene([Ship('a', [0, 0, z], [0, 0, 100])]);
  const dolly = { hardpoint: { name: 'chase', ship: 'a' }, duration: 10, moves: [{ type: 'dolly', distance: 100 }] };

  it('pauses the shot clock while the hardpoint keeps tracking, and resumes with the same progress', () => {
    const rig = new CinemaRig();
    rig.Play(dolly, 0);
    rig.Frame(0, () => moving(0));
    const frozen = rig.Frame(2 * SECOND, () => moving(200))?.pose.eye ?? ([0, 0, 0] as SceneVector);
    rig.Pause(2 * SECOND);
    const eye = rig.Frame(4 * SECOND, () => moving(400))?.pose.eye ?? ([0, 0, 0] as SceneVector);
    expect(rig.Report().state).toBe('paused');
    expect(rig.Report().shot?.elapsed).toBeCloseTo(2);
    expect(rig.Report().driver).toBe('claude');
    // The dolly is frozen while the chase follows the ship 200 m on.
    expect(eye[2] - frozen[2]).toBeCloseTo(200, 3);
    rig.Resume(4 * SECOND);
    rig.Frame(5 * SECOND, () => moving(500));
    expect(rig.Report().shot?.elapsed).toBeCloseTo(3);
    expect(rig.Report().shot?.progress).toBeCloseTo(0.3);
  });

  it('rebases on a time-control jump: a playing shot keeps its progress, a paused one stays paused where it was', () => {
    const rig = new CinemaRig();
    rig.Play(dolly, 0);
    rig.Frame(0, () => moving(0));
    rig.Frame(4 * SECOND, () => moving(400));
    expect(rig.Report().shot?.elapsed).toBeCloseTo(4);
    // A jump back 10 s lands at -6 s: the shot runs on from 4 s.
    rig.Rebase(-10 * SECOND);
    rig.Frame(-6 * SECOND, () => moving(0));
    expect(rig.Report().shot?.elapsed).toBeCloseTo(4);
    rig.Frame(-5 * SECOND, () => moving(100));
    expect(rig.Report().shot?.elapsed).toBeCloseTo(5);
    expect(rig.Report().shot?.progress).toBeCloseTo(0.5);
    rig.Pause(-5 * SECOND);
    rig.Rebase(-3 * SECOND);
    rig.Frame(-7 * SECOND, () => moving(0));
    expect(rig.Report().state).toBe('paused');
    expect(rig.Report().shot?.elapsed).toBeCloseTo(5);
    rig.Resume(-7 * SECOND);
    rig.Frame(-6 * SECOND, () => moving(100));
    expect(rig.Report().shot?.elapsed).toBeCloseTo(6);
  });

  it('hands back on stop and replays from where it stopped, blending in from the drawn pose', () => {
    const rig = new CinemaRig();
    rig.Play(dolly, 0);
    rig.Frame(0, () => moving(0));
    rig.Frame(3 * SECOND, () => moving(0));
    rig.Release(3 * SECOND, { adopt: true });
    expect(rig.Report().driver).toBe('user');
    expect(rig.Report().resumable).toMatchObject({ index: 0, count: 1, elapsed: 3 });
    const drawn: CameraPose = { eye: [5000, 0, 0], look: [0, 0, 0], up: [0, 1, 0], fov: 60 };
    rig.Resume(10 * SECOND);
    expect(rig.Report().resumable).toBeNull();
    expect(rig.Report().driver).toBe('claude');
    const first = rig.Frame(10 * SECOND, () => Scene([Ship('a', [0, 0, 0])], drawn));
    expect(first?.pose.eye[0]).toBeCloseTo(5000);
    expect(rig.Report().shot?.elapsed).toBeCloseTo(3);
    const settled = rig.Frame(12 * SECOND, () => Scene([Ship('a', [0, 0, 0])], drawn));
    expect(Math.abs(settled?.pose.eye[0] ?? 1)).toBeLessThan(1);
  });

  it('forgets on a cut stop with forget, and refuses to resume nothing', () => {
    const rig = new CinemaRig();
    rig.Play(dolly, 0);
    rig.Frame(0, () => moving(0));
    rig.Stop(SECOND, { cut: true, forget: true });
    expect(rig.Report().state).toBe('idle');
    expect(rig.Report().resumable).toBeNull();
    expect(() => rig.Resume(2 * SECOND)).toThrow(/nothing to resume/u);
  });

  it('holds the last frame of a shot that ends with hold', () => {
    const rig = new CinemaRig();
    rig.Play({ ...dolly, duration: 1, end: 'hold' }, 0);
    const scene = Scene([Ship('a', [0, 0, 0])]);
    const start = rig.Frame(0, () => scene)?.pose.eye ?? ([0, 0, 0] as SceneVector);
    const end = rig.Frame(3 * SECOND, () => scene)?.pose.eye ?? ([0, 0, 0] as SceneVector);
    expect(rig.Report()).toMatchObject({ state: 'playing', shot: { progress: 1, holding: true, elapsed: 1 } });
    expect(distanceVec(start, end)).toBeCloseTo(100);
  });

  it('reports the director as the driver when it plays', () => {
    const rig = new CinemaRig();
    rig.Play(dolly, 0, 'director');
    expect(rig.Report().driver).toBe('director');
  });

  it('tracks a moving ship with a pose look and rides a hull without clearing it', () => {
    const rig = new CinemaRig();
    rig.Play({ pose: { eye: [1000, 0, 0], look: { ship: 'a' } } }, 0);
    rig.Frame(0, () => moving(0));
    expect(rig.Frame(SECOND, () => moving(500))?.pose.look).toEqual([0, 0, 500]);
    const deck = new CinemaRig();
    deck.Play({ pose: { eye: { ship: 'a', offset: [0, 0, 0.2], units: 'radii' }, look: [0, 0, 1000] } }, 0);
    expect(deck.Frame(0, () => moving(0))?.pose.eye).toEqual([0, 10, 0]);
    expect(deck.Subjects()).toEqual(['a']);
  });

  it('holds the warp-landing eye down the lane and cuts to a late anchor', () => {
    const warping = { value: false };
    const scene = (z: number): CinemaScene => ({ ...moving(z), warpOf: (id) => (warping.value && id === 'a' ? { phase: 'warping', landing: [0, 0, 1e6] } : null) });
    const rig = new CinemaRig();
    rig.Play({ hardpoint: { name: 'warp-landing', ship: 'a' }, lag: { eye: 2, look: 2 } }, 0);
    const before = rig.Frame(0, () => scene(0))?.pose.eye ?? ([0, 0, 0] as SceneVector);
    expect(before[2]).toBeLessThan(1e5);
    warping.value = true;
    const cut = rig.Frame(SECOND / 60, () => scene(10))?.pose.eye ?? ([0, 0, 0] as SceneVector);
    expect(cut[2]).toBeGreaterThan(1e6);
    const later = rig.Frame(SECOND, () => scene(5e5))?.pose.eye ?? ([0, 0, 0] as SceneVector);
    Close(later, cut, 3);
  });

  it('anchors warp-in on an arriving ship at once, clips for it once incoming, and releases other shots on it', () => {
    const landing: SceneVector = [0, 0, 0];
    const parked = Ship('a', [0, 0, -3e9]);
    const arriving = (ship: CinemaShip, incoming: boolean): CinemaScene => ({
      ...Scene([Ship('b', [0, 0, 5000])]),
      arriving: [ship],
      ...(incoming ? { incoming: [{ centre: ship.frameCentre, radius: ship.frameRadius }] } : {}),
      warpOf: (id) => (id === 'a' ? { phase: 'arriving', landing } : null)
    });
    const rig = new CinemaRig();
    rig.Play({ shot: 'warp-in', ship: 'a' }, 0);
    const first = rig.Frame(0, () => arriving(parked, false));
    // Downstream of the landing: the lane runs from the parked ship (-Z) to the landing (+Z).
    expect(first?.pose.eye[2]).toBeGreaterThan(0);
    expect(first?.far).toBeLessThan(1e6);
    const streaking = Ship('a', [0, 0, -1.5e6]);
    const frame = rig.Frame(SECOND, () => arriving(streaking, true));
    Close(frame?.pose.eye ?? [0, 0, 0], first?.pose.eye ?? [0, 0, 0], 3);
    expect(frame?.far).toBeGreaterThan(1.5e6);
    const chase = new CinemaRig();
    chase.Play({ hardpoint: { name: 'chase', ship: 'a' } }, 0);
    expect(chase.Frame(0, () => arriving(parked, false))).toBeNull();
    expect(chase.Report().note).toMatch(/still arriving by warp: play warp-in, or wait for it to land/u);
  });

  it('scales a radius path by the subject', () => {
    const subject = {
      centre: [0, 0, 0] as SceneVector,
      radius: 1000,
      forward: [0, 0, 1] as SceneVector,
      up: [0, 1, 0] as SceneVector,
      starboard: [-1, 0, 0] as SceneVector,
      velocity: [0, 0, 0] as SceneVector,
      extents: { forward: [-1000, 1000] as [number, number], starboard: [-1000, 1000] as [number, number], up: [-1000, 1000] as [number, number] }
    };
    const path: CameraMove = {
      type: 'path',
      points: [
        [0, 0, 1],
        [1, 0, 1]
      ],
      frame: 'subject',
      units: 'radii',
      look: 'subject',
      up: 'base',
      duration: 1
    };
    Close(At([path], 1, { ...CONTEXT, subject }).eye, [0, 1000, 1000]);
  });

  it('swings the hero toward the beam', () => {
    const rig = new CinemaRig();
    rig.Play({ shot: 'hero', ship: 'a', transition: 'cut', lag: { look: 0 } }, 0);
    const scene = Scene([Ship('a', [0, 0, 0])]);
    const start = rig.Frame(0, () => scene)?.pose.eye ?? ([0, 0, 0] as SceneVector);
    const end = rig.Frame(10 * SECOND, () => scene)?.pose.eye ?? ([0, 0, 0] as SceneVector);
    // Port is +X at yaw 0: the eye swings from the bow toward the port beam.
    expect(end[2] / distanceVec(end, [0, 0, 0])).toBeLessThan(start[2] / distanceVec(start, [0, 0, 0]));
    expect(end[0]).toBeGreaterThan(0);
  });

  it('returns the shots as played, library shots expanded', () => {
    const result = new CinemaRig().Play(
      {
        shots: [
          { shot: 'chase', ship: 'a', duration: 2 },
          { shot: 'flyby', ship: 'a' }
        ]
      },
      0
    );
    expect(result.shots.map((shot) => shot.library)).toEqual(['chase', 'flyby']);
  });
});
