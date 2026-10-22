import { describe, expect, it } from 'vitest';
import type { SceneFleet } from '../fleets/fleet';
import type { SceneVector } from '../scene';
import {
  addVec,
  blendPoses,
  cameraClips,
  clearHulls,
  distanceVec,
  dotVec,
  fitDistance,
  fromOrbitView,
  hardpointKind,
  listHardpoints,
  normalizeCameraSequence,
  normalizeCameraShot,
  normalizeVec,
  poseFromViewMatrix,
  poseRoll,
  poseViewMatrix,
  quatFromAxisAngle,
  quatLookRotation,
  resolveHardpoint,
  rollPose,
  rotateVec,
  SHIP_HARDPOINT_NAMES,
  shipFrame,
  subVec,
  toOrbitView,
  viewHalfExtents,
  type CameraPose,
  type CinemaQuaternion,
  type CinemaScene,
  type CinemaShip
} from './index';

const DEGREES = Math.PI / 180;

function Ship(id: string, position: SceneVector, options: { yaw?: number; radius?: number; team?: string; velocity?: SceneVector; rotation?: CinemaQuaternion } = {}): CinemaShip {
  const rotation = options.rotation ?? quatFromAxisAngle([0, 1, 0], (options.yaw ?? 0) * DEGREES);
  return { id, position, rotation, velocity: options.velocity ?? [0, 0, 0], frameCentre: position, frameRadius: options.radius ?? 50, ...(options.team ? { team: options.team } : {}) };
}

function Scene(ships: CinemaShip[], extra: Partial<CinemaScene> = {}): CinemaScene {
  return { ships, sunDirection: [0, 0, -1], aspect: 16 / 9, ...extra };
}

function Forward(pose: CameraPose): SceneVector {
  return normalizeVec(subVec(pose.look, pose.eye)) ?? [0, 0, 0];
}

function ExpectVector(actual: readonly number[], expected: readonly number[], digits = 6): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], digits));
}

describe('vectors', () => {
  it('builds a look rotation whose axes are forward and up', () => {
    const q = quatLookRotation([1, 0, 0], [0, 1, 0]);
    ExpectVector(rotateVec(q, [0, 0, 1]), [1, 0, 0]);
    ExpectVector(rotateVec(q, [0, 1, 0]), [0, 1, 0]);
  });
});

describe('ship frames', () => {
  it('puts starboard at forward × up: -X facing +Z, +Z facing +X', () => {
    ExpectVector(shipFrame(Ship('a', [0, 0, 0])).starboard, [-1, 0, 0]);
    const turned = shipFrame(Ship('a', [0, 0, 0], { yaw: 90 }));
    ExpectVector(turned.forward, [1, 0, 0]);
    ExpectVector(turned.starboard, [0, 0, 1]);
  });

  it('stays level unless banked', () => {
    const roll = quatFromAxisAngle([0, 0, 1], 30 * DEGREES);
    const ship = Ship('a', [0, 0, 0], { rotation: roll });
    ExpectVector(shipFrame(ship).up, [0, 1, 0]);
    expect(shipFrame(ship, true).up[1]).toBeCloseTo(Math.cos(30 * DEGREES));
  });
});

describe('ship hardpoints', () => {
  const scene = Scene([Ship('a', [1000, 0, 0]), Ship('b', [1000, 0, 5000], { team: 'red' })]);

  it('resolves every ship hardpoint at yaw 0, eye outside the hull, looking near the hull', () => {
    for (const name of SHIP_HARDPOINT_NAMES) {
      const { pose, note } = resolveHardpoint({ name, ship: 'a' }, scene);
      expect(pose, `${name}: ${note}`).toBeTruthy();
      if (!pose) continue;
      expect(distanceVec(pose.eye, [1000, 0, 0])).toBeGreaterThan(50);
      if (name !== 'over-the-shoulder' && name !== 'chase') expect(distanceVec(pose.look, [1000, 0, 0])).toBeLessThan(1);
    }
  });

  it('places chase behind, bow-on ahead, broadsides to their sides', () => {
    const at = (name: string): SceneVector => subVec(resolveHardpoint({ name, ship: 'a' }, scene).pose?.eye ?? [0, 0, 0], [1000, 0, 0]);
    expect(at('chase')[2]).toBeLessThan(0);
    expect(at('bow-on')[2]).toBeGreaterThan(0);
    expect(at('broadside-starboard')[0]).toBeLessThan(0);
    expect(at('broadside-port')[0]).toBeGreaterThan(0);
    expect(at('rear-quarter-starboard-high')[0]).toBeLessThan(0);
    expect(at('rear-quarter-starboard-high')[1]).toBeGreaterThan(0);
    expect(at('rear-quarter-port-low')[1]).toBeLessThan(0);
    expect(at('belly')[1]).toBeLessThan(0);
  });

  it('turns with the heading', () => {
    const turned = Scene([Ship('a', [0, 0, 0], { yaw: 90 })]);
    const eye = resolveHardpoint({ name: 'chase', ship: 'a' }, turned).pose?.eye ?? [0, 0, 0];
    expect(eye[0]).toBeLessThan(0);
    expect(Math.abs(eye[2])).toBeLessThan(1e-6);
  });

  it('scales distances with the hull radius', () => {
    const small = resolveHardpoint({ name: 'hero-port', ship: 'a' }, Scene([Ship('a', [0, 0, 0], { radius: 40 })])).pose;
    const large = resolveHardpoint({ name: 'hero-port', ship: 'a' }, Scene([Ship('a', [0, 0, 0], { radius: 400 })])).pose;
    expect(distanceVec(large?.eye ?? [0, 0, 0], [0, 0, 0]) / distanceVec(small?.eye ?? [0, 0, 0], [0, 0, 0])).toBeCloseTo(10, 6);
  });

  it('looks straight down on top-down with the bow up the frame', () => {
    const pose = resolveHardpoint({ name: 'top-down', ship: 'a' }, scene).pose;
    ExpectVector(Forward(pose as CameraPose), [0, -1, 0]);
    ExpectVector(pose?.up ?? [], [0, 0, 1]);
  });

  it('looks over the shoulder at the named target, else the nearest enemy', () => {
    const named = resolveHardpoint({ name: 'over-the-shoulder', ship: 'a', target: 'b' }, scene).pose;
    ExpectVector(named?.look ?? [], [1000, 0, 5000]);
    const nearest = resolveHardpoint({ name: 'over-the-shoulder', ship: 'a' }, scene);
    ExpectVector(nearest.pose?.look ?? [], [1000, 0, 5000]);
    expect(nearest.note).toContain('b');
    const eye = nearest.pose?.eye ?? [0, 0, 0];
    expect(eye[2]).toBeLessThan(0);
  });

  it('anchors the flyby eye while the look follows the ship', () => {
    const moving = (z: number): CinemaScene => Scene([Ship('a', [0, 0, z], { velocity: [0, 0, 500] })]);
    const first = resolveHardpoint({ name: 'flyby', ship: 'a' }, moving(0));
    expect(first.anchor?.[2]).toBeCloseTo(2000);
    const later = resolveHardpoint({ name: 'flyby', ship: 'a' }, moving(1500), first.anchor);
    ExpectVector(later.pose?.eye ?? [], first.pose?.eye ?? []);
    ExpectVector(later.pose?.look ?? [], [0, 0, 1500]);
  });

  it('reports a missing ship', () => {
    expect(resolveHardpoint({ name: 'chase', ship: 'nope' }, scene).note).toContain('nope');
  });
});

describe('group and engagement hardpoints', () => {
  const fleets: SceneFleet[] = [{ id: 'blue', commander: 'fc', wings: [{ id: 'main', commander: 'wc', squads: [{ id: 's1', role: 'dps', members: ['m1', 'm2'] }] }] }];
  const ships = [Ship('fc', [0, 0, 0], { team: 'blue' }), Ship('wc', [0, 0, -500], { team: 'blue' }), Ship('m1', [800, 0, -1000], { team: 'blue' }), Ship('m2', [-800, 0, -1000], { team: 'blue' }), Ship('r1', [0, 0, 20_000], { team: 'red' }), Ship('r2', [500, 0, 20_000], { team: 'red' })];
  const scene = Scene(ships, { fleets, sunDirection: [1, 0, 0] });

  it('picks the group kind from fleet or ships', () => {
    expect(hardpointKind({ name: 'top-down', fleet: 'blue' })).toBe('group');
    expect(hardpointKind({ name: 'top-down' })).toBe('ship');
    expect(hardpointKind({ name: 'overlook' })).toBe('engagement');
  });

  it('puts behind-fc behind the rear, looking at the enemy centroid', () => {
    const pose = resolveHardpoint({ name: 'behind-fc', fleet: 'blue' }, scene).pose;
    expect(pose?.eye[2]).toBeLessThan(-1000);
    ExpectVector(pose?.look ?? [], [250, 0, 20_000]);
  });

  it('frames a wing tighter than the fleet', () => {
    const fleet = resolveHardpoint({ name: 'flank-starboard', fleet: 'blue' }, scene).pose;
    const squad = resolveHardpoint({ name: 'flank-starboard', fleet: 'blue', squad: 's1' }, scene).pose;
    expect(fleet?.eye[0]).toBeLessThan(0);
    expect(distanceVec(squad?.eye ?? [0, 0, 0], squad?.look ?? [0, 0, 0])).toBeLessThan(distanceVec(fleet?.eye ?? [0, 0, 0], fleet?.look ?? [0, 0, 0]));
  });

  it('looks down on the formation with the heading up the frame, and back from the leading edge', () => {
    const top = resolveHardpoint({ name: 'top-down', fleet: 'blue' }, scene).pose;
    ExpectVector(Forward(top as CameraPose), [0, -1, 0]);
    ExpectVector(top?.up ?? [], [0, 0, 1]);
    const lead = resolveHardpoint({ name: 'leading-edge', fleet: 'blue' }, scene).pose;
    expect(lead?.eye[2]).toBeGreaterThan(0);
    expect(Forward(lead as CameraPose)[2]).toBeLessThan(0);
  });

  it('fits every ship in the overlook', () => {
    const pose = resolveHardpoint({ name: 'overlook' }, scene).pose as CameraPose;
    const { halfHeight } = viewHalfExtents(pose.fov, 16 / 9);
    const forward = Forward(pose);
    for (const ship of ships) {
      const offset = subVec(ship.frameCentre, pose.eye);
      const along = dotVec(offset, forward);
      const off = Math.sqrt(Math.max(0, dotVec(offset, offset) - along * along));
      expect(along).toBeGreaterThan(0);
      expect((off + ship.frameRadius) / along).toBeLessThan(halfHeight * 1.05);
    }
    expect(pose.eye[1]).toBeGreaterThan(0);
  });

  it('puts the into-sun eye on the +sunDirection side, looking toward the sun', () => {
    const pose = resolveHardpoint({ name: 'into-sun' }, scene).pose as CameraPose;
    const centre = pose.look;
    expect(pose.eye[0] - centre[0]).toBeGreaterThan(0);
    ExpectVector(Forward(pose), [-1, 0, 0]);
  });

  it('looks into a named celestial', () => {
    const located = Scene(ships, { celestials: [{ id: 40_000_001, name: 'Jita IV', kind: 'planet', position: [0, 0, 1e9], radius: 5e6 }] });
    const pose = resolveHardpoint({ name: 'into-celestial', celestial: 'jita iv' }, located).pose as CameraPose;
    expect(Forward(pose)[2]).toBeGreaterThan(0.99);
    expect(resolveHardpoint({ name: 'into-celestial', celestial: 'celestial:40000001' }, located).pose).toBeTruthy();
    expect(resolveHardpoint({ name: 'into-celestial', celestial: 'Amarr' }, located).note).toContain('Amarr');
  });

  it('lists the hardpoints of each kind', () => {
    expect(listHardpoints({ ship: 'fc' }, scene).every((entry) => entry.pose)).toBe(true);
    expect(listHardpoints({ fleet: 'blue', wing: 'main' }, scene).map((entry) => entry.name)).toContain('behind-fc');
    expect(listHardpoints({}, scene).map((entry) => entry.name)).toEqual(['overlook', 'into-sun', 'into-celestial']);
  });
});

describe('poses', () => {
  const a: CameraPose = { eye: [0, 0, -100], look: [0, 0, 0], up: [0, 1, 0], fov: 40 };
  const b: CameraPose = { eye: [100, 0, 0], look: [0, 0, 0], up: [0, 1, 0], fov: 60 };

  it('blends to each end and swings round the look point', () => {
    const start = blendPoses(a, b, 0);
    const end = blendPoses(a, b, 1);
    ExpectVector(start.eye, a.eye);
    ExpectVector(end.eye, b.eye);
    expect(start.fov).toBeCloseTo(40);
    expect(end.fov).toBeCloseTo(60);
    const middle = blendPoses(a, b, 0.5);
    expect(distanceVec(middle.eye, [0, 0, 0])).toBeCloseTo(100);
  });

  it('slerps the roll', () => {
    const rolled = rollPose(a, 40);
    expect(poseRoll(rolled)).toBeCloseTo(40);
    expect(poseRoll(blendPoses(a, rolled, 0.5))).toBeCloseTo(20);
  });

  it('round-trips through the orbit view', () => {
    const view = toOrbitView({ eye: [300, 200, -400], look: [10, 20, 30], up: [0, 1, 0], fov: 45 });
    const pose = fromOrbitView(view, 45);
    ExpectVector(pose.eye, [300, 200, -400], 4);
    expect(view.pitch).toBeLessThan(0);
  });

  it('round-trips through the view matrix', () => {
    const pose: CameraPose = { eye: [5, 6, 7], look: [100, -20, 40], up: [0, 1, 0], fov: 45 };
    const back = poseFromViewMatrix(poseViewMatrix(pose), distanceVec(pose.eye, pose.look), 45);
    ExpectVector(back.eye, pose.eye);
    ExpectVector(back.look, pose.look);
  });
});

describe('framing', () => {
  it("applies Carbon's 1.6 aspect clamp", () => {
    const narrow = viewHalfExtents(60, 1.5);
    expect(narrow.halfHeight).toBeCloseTo(Math.tan(30 * DEGREES));
    const wide = viewHalfExtents(60, 3.2);
    expect(wide.halfWidth).toBeCloseTo(1.6 * Math.tan(30 * DEGREES));
    expect(wide.halfHeight).toBeCloseTo(Math.tan(30 * DEGREES) / 2);
  });

  it('fits a sphere at the distance that makes it span the fill', () => {
    const distance = fitDistance(100, 60, 1, 1);
    expect(100 / distance).toBeCloseTo(Math.sin(30 * DEGREES));
    expect(fitDistance(100, 60, 1, 0.5)).toBeGreaterThan(distance);
  });

  it('pushes the eye out of hulls', () => {
    const eye = clearHulls([10, 0, 0], [{ centre: [0, 0, 0], radius: 100 }]);
    ExpectVector(eye, [115, 0, 0]);
    ExpectVector(clearHulls([500, 0, 0], [{ centre: [0, 0, 0], radius: 100 }]), [500, 0, 0]);
  });

  it('holds the near plane in front of the nearest hull and the far plane past the farthest', () => {
    const clips = cameraClips({
      eye: [0, 0, 0],
      spheres: [
        { centre: [0, 0, 60], radius: 50 },
        { centre: [0, 0, 300_000], radius: 100 }
      ]
    });
    expect(clips.near).toBeCloseTo(5);
    expect(clips.far).toBeGreaterThan(300_100);
    const reach = cameraClips({ eye: [0, 0, 0], spheres: [], reach: 5e6 });
    expect(reach.far).toBeGreaterThan(5e6);
    expect(reach.near).toBeGreaterThanOrEqual(reach.far / 2e6);
    expect(addVec([1, 2, 3], [1, 1, 1])).toEqual([2, 3, 4]);
  });
});

describe('normalizeCameraShot', () => {
  it('fills the defaults', () => {
    const { shot, problems } = normalizeCameraShot({ hardpoint: { name: 'chase', ship: 'a' } });
    expect(problems).toEqual([]);
    expect(shot?.transition).toEqual({ type: 'cut' });
    expect(shot?.lag).toEqual({ eye: 0, look: 0 });
    expect(shot?.moves).toEqual([]);
  });

  it('reads moves, blends and presentation', () => {
    const { shot, problems } = normalizeCameraShot({
      pose: { eye: [0, 0, -100], look: [0, 0, 0] },
      duration: 8,
      transition: { type: 'blend', duration: 2 },
      moves: [
        { type: 'push', factor: 2, easing: 'ease-out' },
        { type: 'orbit', rate: 20 },
        { type: 'roll', angle: 30, duration: 2 },
        { type: 'shake', amplitude: 1 }
      ],
      letterbox: 2.39,
      hud: false
    });
    expect(problems).toEqual([]);
    expect(shot?.transition).toEqual({ type: 'blend', duration: 2, easing: 'ease-in-out' });
    expect(shot?.moves[1]).toEqual({ type: 'orbit', axis: 'subject-up', rate: 20 });
    expect(shot?.moves[3]).toEqual({ type: 'shake', amplitude: 1, frequency: 8 });
    expect(shot?.letterbox).toBe(2.39);
  });

  it('reports every problem', () => {
    const { shot, problems } = normalizeCameraShot({ hardpoint: { name: 'chase' }, pose: { eye: [0, 0, 0], look: [0, 0, 0] }, moves: [{ type: 'orbit' }, { type: 'warp' }, { type: 'path', points: [[0, 0, 0]] }], letterbox: 9 });
    expect(shot).toBeNull();
    expect(problems.join('\n')).toMatch(/exactly one of hardpoint/u);
    expect(problems.join('\n')).toMatch(/needs ship/u);
    expect(problems.join('\n')).toMatch(/eye and look must differ/u);
    expect(problems.join('\n')).toMatch(/exactly one of rate/u);
    expect(problems.join('\n')).toMatch(/moves\[1\]\.type/u);
    expect(problems.join('\n')).toMatch(/at least 2 waypoints/u);
    expect(problems.join('\n')).toMatch(/letterbox/u);
  });

  it('refuses a group name on a ship and names the kinds', () => {
    const { problems } = normalizeCameraShot({ hardpoint: { name: 'behind-fc', ship: 'a' } });
    expect(problems[0]).toMatch(/not a ship hardpoint.*take fleet or ships/u);
  });

  it('warns about unknown keys', () => {
    expect(normalizeCameraShot({ hardpoint: { name: 'overlook', colour: 'red' } }).warnings[0]).toMatch(/colour/u);
  });

  it('needs a duration on every sequence shot but the last', () => {
    const shot = { hardpoint: { name: 'overlook' } };
    expect(normalizeCameraSequence([shot, shot]).problems[0]).toMatch(/shots\[0\] needs a duration/u);
    expect(normalizeCameraSequence({ shots: [{ ...shot, duration: 2 }, shot] }).sequence?.shots).toHaveLength(2);
  });
});
