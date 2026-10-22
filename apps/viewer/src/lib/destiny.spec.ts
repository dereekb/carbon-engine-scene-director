import type { Maybe } from '@dereekb/util';
import { createRequire } from 'node:module';
import { toFollowTolerance, type SceneShip, type SceneVector, type ShipOrder } from '@scene-director/scene';
import { describe, expect, it, vi } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { AttachShipCurves, CycleEnd, DEFAULT_SHIP_PHYSICS, DestinyWorld, DocumentRotation, FIRST_SHIP_BALL_ID, ModeName, REFERENCE_BALL_ID, type CurveHost, type ShipFollow, type ShipMotion, type ShipPhysics, type ShipWarp, type WarpEvent, type PropModEvent } from './destiny';
import { ResolveFlight, type PublishedHull, type ShipFlight } from './flight';
import { ResolveShipPropMod } from './prop-mods';
import { CjsDestinyBall, CjsDestinyClientBall, quat, vec3, type Quat, type Vec3 } from './runtime-sim';
import { FleetFrame, FramePoint, WarpFrame } from './steering';
import { WarpExitTime } from './warp';

const FRAME_TICKS = Math.round(TICKS_PER_SECOND / 60);
const FRIGATE = { mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 30 };

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5 } };
const GUARDIAN: PublishedHull = { typeID: 11987, name: 'Guardian', published: { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70, radius: 80, warpSpeedMultiplier: 4 } };
const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250, warpSpeedMultiplier: 3 } };

type Placement = Pick<SceneShip, 'id' | 'position' | 'rotation'>;

/**
 * The max-skills Ship-stats numbers of a fixture hull.
 */
function Fly(hull: PublishedHull): ShipFlight {
  return ResolveFlight({ published: hull, hull: null, overrides: null });
}

interface Sample {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly rotation: Quat;
}

/**
 * A world driven the way the page drives it: one clock, the parks evolved to it, then every curve sampled at it.
 */
class Harness {
  readonly world = new DestinyWorld();
  now = CLOCK_EPOCH_TICKS;
  private readonly samples = new Map<string, Sample>();

  Run(seconds: number, onFrame?: () => void): void {
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
      this.now += FRAME_TICKS;
      this.world.Tick(this.now);
      for (const id of this.samples.keys()) this.Sample(id);
      onFrame?.();
    }
  }

  Sample(id: string): Sample {
    const curves = this.world.Curves(id);
    if (!curves) throw new Error(`no curves for ${id}`);
    const sample = {
      position: curves.translation.Update__Ticks(this.now, vec3.create()),
      velocity: curves.translation.GetValueDotAt__Ticks(this.now, vec3.create()),
      rotation: curves.rotation.Update__Ticks(this.now, quat.create())
    };
    this.samples.set(id, sample);
    return sample;
  }
}

function Ship(id: string, position: SceneVector, rotation: SceneVector = [0, 0, 0]): Placement {
  return { id, position, rotation };
}

function RequireMotion(world: DestinyWorld, id: string): ShipMotion {
  const motion = world.Motion(id);
  if (!motion) throw new Error(`no motion for ${id}`);
  return motion;
}

/**
 * Runs frames until the world has evolved `count` more ticks, calling back after each one.
 */
function RunTicks(harness: Harness, count: number, onTick?: () => void): void {
  const end = harness.world.tick + count;
  let tick = harness.world.tick;
  while (harness.world.tick < end) {
    harness.Run(1 / 60);
    if (harness.world.tick !== tick) {
      tick = harness.world.tick;
      onTick?.();
    }
  }
}

function ExpectLockstep(world: DestinyWorld, balls: number): void {
  expect(world.master.currentTime).toBe(world.replica.currentTime);
  const state = (ball: CjsDestinyBall | null): number[] => (ball ? [ball.x, ball.y, ball.z, ball.vx, ball.vy, ball.vz, ball.mode, ball.mNewYaw, ball.mNewPitch, ball.mass, ball.maxVelocity, ball.agility] : []);
  for (let id = FIRST_SHIP_BALL_ID; id < FIRST_SHIP_BALL_ID + balls; id++) expect(state(world.replica.GetBall(id))).toEqual(state(world.master.GetBall(id)));
}

function ExpectSameRotation(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-6): void {
  const dot = Math.abs(actual[0] * expected[0] + actual[1] * expected[1] + actual[2] * expected[2] + actual[3] * expected[3]);
  expect(1 - dot).toBeLessThan(tolerance);
}

function Forward(rotation: Quat): Vec3 {
  return vec3.transformQuat(vec3.create(), [0, 0, 1], rotation);
}

describe('DestinyWorld', () => {
  it('pairs a master park of Balls with a replica park of ClientBalls around a fixed origin ego', () => {
    const { world } = new Harness();
    world.AddShip(Ship('a', [10, 20, 30]));
    expect(world.master.isMaster).toBe(true);
    expect(world.replica.isMaster).toBe(false);
    expect(world.replica.GetBall(FIRST_SHIP_BALL_ID)).toBeInstanceOf(CjsDestinyClientBall);
    const master = world.master.GetBall(FIRST_SHIP_BALL_ID);
    expect(master).toBeInstanceOf(CjsDestinyBall);
    expect(master).not.toBeInstanceOf(CjsDestinyClientBall);
    expect(world.replica.ego).toBe(BigInt(REFERENCE_BALL_ID));
    expect(world.replica.GetBall(REFERENCE_BALL_ID)?.isFree).toBe(false);
    expect(world.Curves('a')?.translation).toBe(world.replica.GetBall(FIRST_SHIP_BALL_ID));
  });

  it('holds a ship exactly at its document placement, before and after ticks', () => {
    const harness = new Harness();
    const ships = [Ship('rolled', [3000, -250, 500], [90, 10, 30]), Ship('over', [-1200, 40, 7], [0, 120, 0]), Ship('level', [0, 0, 0])];
    for (const ship of ships) harness.world.AddShip(ship, FRIGATE);
    const check = (): void => {
      for (const ship of ships) {
        const sample = harness.Sample(ship.id);
        expect(Array.from(sample.position)).toEqual(ship.position);
        expect(Array.from(sample.velocity)).toEqual([0, 0, 0]);
        ExpectSameRotation(sample.rotation, DocumentRotation(ship.rotation));
        expect(harness.world.Motion(ship.id)).toMatchObject({ position: ship.position, velocity: [0, 0, 0], speed: 0, mode: 'stop' });
      }
    };
    check();
    harness.Run(3);
    check();
  });

  it('applies a direction order at the next tick boundary, then flies the ship along it', () => {
    const harness = new Harness();
    harness.world.AddShip(Ship('a', [3000, 0, 500], [90, 10, 0]), FRIGATE);
    harness.Sample('a');
    harness.Run(1.5);
    const tick = harness.world.tick;
    expect(harness.world.Order('a', { type: 'direction', direction: [0, 0, 5], speed: 1 })).toBe(true);
    expect(harness.world.Motion('a')?.mode).toBe('stop');
    let modeAtBoundary: string | undefined;
    harness.Run(1.1, () => {
      if (harness.world.tick === tick) expect(harness.world.Motion('a')?.mode).toBe('stop');
      else modeAtBoundary ??= harness.world.Motion('a')?.mode;
    });
    expect(modeAtBoundary).toBe('goto');

    harness.Run(5);
    const sample = harness.Sample('a');
    expect(sample.position[2]).toBeGreaterThan(600);
    expect(sample.position[0]).toBeCloseTo(3000, 3);
    expect(sample.velocity[2]).toBeGreaterThan(50);
    expect(vec3.dot(Forward(sample.rotation), [0, 0, 1])).toBeGreaterThan(0.9);
    const motion = harness.world.Motion('a');
    expect(motion?.position[2]).toBeGreaterThan(sample.position[2]);
    expect(motion?.speed).toBeGreaterThan(100);
    expect(motion?.speed).toBeLessThanOrEqual(FRIGATE.maxVelocity);
  });

  it('decelerates on stop', () => {
    const harness = new Harness();
    harness.world.AddShip(Ship('a', [0, 0, 0]), FRIGATE);
    harness.world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 0.5 });
    harness.Run(8);
    const cruising = harness.world.Motion('a')?.speed ?? 0;
    expect(cruising).toBeGreaterThan(100);
    expect(cruising).toBeLessThanOrEqual(FRIGATE.maxVelocity * 0.5 + 0.1);
    harness.world.Order('a', { type: 'stop' });
    harness.Run(4);
    expect(harness.world.Motion('a')?.mode).toBe('stop');
    expect(harness.world.Motion('a')?.speed).toBeLessThan(cruising / 2);
  });

  it('teleports a flying ship to a new placement, at rest with its new heading', () => {
    const harness = new Harness();
    harness.world.AddShip(Ship('a', [0, 0, 0]), FRIGATE);
    harness.Sample('a');
    harness.world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    harness.Run(5);
    const placed = Ship('a', [-500, 25, 1000], [180, -20, 15]);
    const forward = Forward(DocumentRotation(placed.rotation));
    harness.world.PlaceShip(placed);
    expect(harness.world.Motion('a')).toMatchObject({ position: placed.position, speed: 0, mode: 'stop' });
    const atRest = (): Sample => {
      const sample = harness.Sample('a');
      expect(Array.from(sample.position)).toEqual(placed.position);
      expect(Array.from(sample.velocity)).toEqual([0, 0, 0]);
      expect(vec3.dot(Forward(sample.rotation), forward)).toBeGreaterThan(1 - 1e-6);
      return sample;
    };
    // The ClientBall caches its last sample per time, so the teleport shows from the next frame on.
    harness.Run(1 / 60);
    atRest();
    harness.Run(3);
    atRest();
    // Destiny's heading snap keeps the ClientBall's banking roll, which levels out like the client's.
    harness.Run(10);
    ExpectSameRotation(atRest().rotation, DocumentRotation(placed.rotation));
  });

  it('teleports a ship mid-tick without sliding on or swinging back toward its old heading', () => {
    const harness = new Harness();
    harness.world.AddShip(Ship('a', [0, 0, 0]), FRIGATE);
    harness.Sample('a');
    harness.world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    // Full speed, then half way through a tick: a placement there used to slide on along the old thrust.
    RunTicks(harness, 5);
    harness.Run(0.5);
    const placed = Ship('a', [-500, 25, 1000], [45, 0, 0]);
    const forward = Forward(DocumentRotation(placed.rotation));
    harness.world.PlaceShip(placed);
    let slid = 0;
    let turned = 0;
    harness.Run(2.5, () => {
      const sample = harness.Sample('a');
      slid = Math.max(slid, vec3.distance(sample.position, placed.position));
      turned = Math.max(turned, Math.acos(Math.min(1, vec3.dot(Forward(sample.rotation), forward))));
    });
    expect(slid).toBeLessThan(0.01);
    expect(turned).toBeLessThan(1e-3);
    ExpectLockstep(harness.world, 1);
  });

  it('drops an order queued before a placement edit', () => {
    const harness = new Harness();
    harness.world.AddShip(Ship('a', [0, 0, 0]), FRIGATE);
    harness.world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    harness.world.PlaceShip(Ship('a', [100, 0, 0]));
    harness.Run(3);
    expect(harness.world.Motion('a')).toMatchObject({ position: [100, 0, 0], speed: 0 });
  });

  it('sets physics on both parks and refuses values Destiny cannot evolve', () => {
    const { world } = new Harness();
    world.AddShip(Ship('a', [0, 0, 0]));
    expect(world.Motion('a')?.physics).toEqual(DEFAULT_SHIP_PHYSICS);
    world.SetPhysics('a', { mass: 2e6, agility: 2, maxVelocity: 400, radius: 40 });
    for (const park of [world.master, world.replica]) {
      expect(park.GetBall(FIRST_SHIP_BALL_ID)).toMatchObject({ mass: 2e6, agility: 2, maxVelocity: 400, radius: 40 });
    }
    expect(world.Motion('a')?.physics).toEqual({ mass: 2e6, agility: 2, maxVelocity: 400, radius: 40 });
    expect(() => world.SetPhysics('a', { ...DEFAULT_SHIP_PHYSICS, mass: 0 })).toThrow(/mass/);
    expect(() => world.SetPhysics('a', { ...DEFAULT_SHIP_PHYSICS, agility: Number.NaN })).toThrow(/agility/);
    expect(() => world.AddShip(Ship('b', [0, 0, 0]), { ...DEFAULT_SHIP_PHYSICS, maxVelocity: Infinity })).toThrow(/maxVelocity/);
    expect(world.Curves('b')).toBeNull();
  });

  it('removes a ship from both parks', () => {
    const harness = new Harness();
    harness.world.AddShip(Ship('a', [0, 0, 0]));
    harness.world.AddShip(Ship('b', [500, 0, 0]));
    harness.world.RemoveShip('a');
    harness.Run(0.1);
    for (const park of [harness.world.master, harness.world.replica]) {
      expect(park.GetBall(FIRST_SHIP_BALL_ID)).toBeNull();
      expect(park.GetBall(FIRST_SHIP_BALL_ID + 1)).not.toBeNull();
    }
    expect(harness.world.Curves('a')).toBeNull();
    expect(harness.world.Motion('a')).toBeNull();
    expect(harness.world.Order('a', { type: 'stop' })).toBe(false);
    // A re-added id gets a fresh ball.
    harness.world.AddShip(Ship('a', [0, 0, 0]));
    expect(harness.world.replica.GetBall(FIRST_SHIP_BALL_ID + 2)).toBeInstanceOf(CjsDestinyClientBall);
  });

  it('keeps the master and the replica in lockstep', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0], [30, 0, 0]), FRIGATE);
    world.AddShip(Ship('b', [2000, 100, -400], [0, 45, 0]));
    harness.Sample('a');
    harness.Sample('b');
    world.Order('a', { type: 'direction', direction: [1, 1, 0], speed: 0.8 });
    harness.Run(3.3);
    world.Order('b', { type: 'direction', direction: [0, 0, -1], speed: 1 });
    world.SetPhysics('b', { mass: 1e8, agility: 0.12, maxVelocity: 110, radius: 400 });
    harness.Run(2.7);
    world.Order('a', { type: 'stop' });
    world.PlaceShip(Ship('b', [0, 0, 5000], [270, 0, 0]));
    harness.Run(4.4);
    expect(world.master.currentTime).toBe(world.replica.currentTime);
    expect(world.master.time).toBe(world.replica.time);
    for (const id of [FIRST_SHIP_BALL_ID, FIRST_SHIP_BALL_ID + 1]) {
      const master = world.master.GetBall(id);
      const replica = world.replica.GetBall(id);
      const state = (ball: CjsDestinyBall | null): number[] => (ball ? [ball.x, ball.y, ball.z, ball.vx, ball.vy, ball.vz, ball.mode] : []);
      expect(state(replica)).toEqual(state(master));
      expect(state(master)).toHaveLength(7);
    }
  });

  it('attaches the ball curves to a ship', () => {
    const { world } = new Harness();
    world.AddShip(Ship('a', [0, 0, 0]));
    const host: CurveHost = { translationCurve: null, rotationCurve: null };
    const curves = world.Curves('a');
    if (!curves) throw new Error('no curves');
    AttachShipCurves(host, curves);
    expect(host.translationCurve).toBe(curves.translation);
    expect(host.rotationCurve).toBe(curves.rotation);
  });

  it('names ball modes', () => {
    expect(ModeName(CjsDestinyBall.DSTBALLMODE['DSTBALL_STOP'])).toBe('stop');
    expect(ModeName(CjsDestinyBall.DSTBALLMODE['DSTBALL_GOTO'])).toBe('goto');
    expect(ModeName(99)).toBe('mode 99');
  });

  it('loads the same runtime files the server does', () => {
    const require = createRequire(import.meta.url);
    const serverRequire = createRequire(require.resolve('@carbonenginejs/server/destiny'));
    for (const specifier of ['@carbonenginejs/runtime/schema', '@carbonenginejs/runtime/math/vec3', '@carbonenginejs/runtime/blue']) {
      expect(serverRequire.resolve(specifier)).toBe(require.resolve(specifier));
    }
  });
});

describe('DestinyWorld orders at Ship-stats speeds', () => {
  const rifter = Fly(RIFTER);
  const guardian = Fly(GUARDIAN);

  function OrbitRun(speed: number): { distances: number[]; speeds: number[]; motion: ShipMotion; world: DestinyWorld } {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [10000, 0, 0]), rifter);
    world.AddShip(Ship('t', [0, 0, 0]), guardian);
    const order: ShipOrder = { type: 'orbit', target: 't', range: 5000, speed };
    expect(world.Order('a', order)).toBe(true);
    expect(RequireMotion(world, 'a').pendingOrder).toEqual(order);
    harness.Run(60);
    const distances: number[] = [];
    const speeds: number[] = [];
    harness.Run(30, () => {
      const motion = RequireMotion(world, 'a');
      distances.push(motion.targetDistance ?? Number.NaN);
      speeds.push(motion.speed);
    });
    const motion = RequireMotion(world, 'a');
    expect(motion).toMatchObject({ mode: 'orbit', order });
    expect(motion.pendingOrder).toBeUndefined();
    return { distances, speeds, motion, world };
  }

  it("settles an orbit near its range at the hull's speed", () => {
    const { distances, speeds, world } = OrbitRun(1);
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(5000);
    expect(Math.max(...distances)).toBeLessThanOrEqual(5500);
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(10);
    expect(Math.min(...speeds)).toBeGreaterThanOrEqual(0.95 * rifter.maxVelocity);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(rifter.maxVelocity + 0.1);
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID)?.followRange).toBe(Math.fround(5000));
    ExpectLockstep(world, 2);
  });

  it('orbits at a speed fraction', () => {
    const { distances, speeds } = OrbitRun(0.5);
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(5000);
    expect(Math.max(...distances)).toBeLessThanOrEqual(5500);
    expect(Math.min(...speeds)).toBeGreaterThanOrEqual(0.95 * 0.5 * rifter.maxVelocity);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(0.5 * rifter.maxVelocity + 0.1);
  });

  it('holds a keep-at-range distance from outside and from inside', () => {
    for (const [start, seconds] of [
      [10000, 90],
      [500 + 31 + 80, 60]
    ] as const) {
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('a', [start, 0, 0]), rifter);
      world.AddShip(Ship('t', [0, 0, 0]), guardian);
      world.Order('a', { type: 'keep-at-range', target: 't', range: 2500, speed: 1 });
      harness.Run(seconds);
      const motion = RequireMotion(world, 'a');
      expect(motion.mode).toBe('follow');
      expect(Math.abs((motion.targetDistance ?? 0) - 2500)).toBeLessThanOrEqual(150);
      if (start > 1000) expect(motion.speed).toBeLessThan(2);
    }
  });

  it('keeps range on a moving target, matching its speed', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('t', [0, 0, 0]), guardian);
    world.AddShip(Ship('a', [-6000, 0, 3000]), rifter);
    world.Order('t', { type: 'direction', direction: [1, 0, 0], speed: 0.5 });
    world.Order('a', { type: 'keep-at-range', target: 't', range: 1000, speed: 1 });
    harness.Run(120);
    const follower = RequireMotion(world, 'a');
    const target = RequireMotion(world, 't');
    expect(Math.abs(follower.speed - target.speed) / target.speed).toBeLessThan(0.05);
    expect(follower.targetDistance).toBeGreaterThanOrEqual(1000);
    expect(follower.targetDistance).toBeLessThanOrEqual(1500);
    ExpectLockstep(world, 2);
  });

  it('closes in on an approach', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [10000, 0, 0]), rifter);
    world.AddShip(Ship('t', [0, 0, 0]), guardian);
    world.Order('a', { type: 'approach', target: 't', speed: 1 });
    const distances: number[] = [];
    RunTicks(harness, 40, () => distances.push(RequireMotion(world, 'a').targetDistance ?? Number.NaN));
    const closing = distances.slice(0, 21);
    for (let index = 1; index < closing.length; index++) expect(closing[index]).toBeLessThan(closing[index - 1]);
    expect(Math.min(...distances)).toBeLessThan(100);
    harness.Run(50);
    const motion = RequireMotion(world, 'a');
    expect(Math.abs(motion.targetDistance ?? Infinity)).toBeLessThan(100);
    expect(motion.mode).toBe('follow');
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID)?.followRange).toBe(50);
  });

  it('flies to a goto point and slows to a halt near it', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.Order('a', { type: 'goto', point: [3000, 400, -4000], speed: 1 });
    harness.Run(90);
    const motion = RequireMotion(world, 'a');
    expect(vec3.distance(motion.position, [3000, 400, -4000])).toBeLessThan(150);
    expect(motion.speed).toBeLessThan(2);
    expect(motion.mode).toBe('goto');
    expect(motion.targetDistance).toBeUndefined();
  });

  it('aligns in the Ship-stats align time, to the whole tick', () => {
    for (const hull of [RIFTER, GUARDIAN, TFI]) {
      const flight = Fly(hull);
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('a', [0, 0, 0]), flight);
      harness.Run(1.5);
      const start = world.tick;
      world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
      const ball = (): CjsDestinyBall | null => world.master.GetBall(FIRST_SHIP_BALL_ID);
      const speed = (): number => Math.hypot(ball()?.vx ?? 0, ball()?.vy ?? 0, ball()?.vz ?? 0);
      for (let frame = 0; frame < 60 * 30 && speed() < 0.75 * flight.maxVelocity; frame++) harness.Run(1 / 60);
      expect({ hull: hull.name, ticks: world.tick - start }).toEqual({ hull: hull.name, ticks: Math.ceil(flight.alignTime) });
    }
  });

  it('stops every follower of a removed ship, pending ones included', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('t', [0, 0, 0]), guardian);
    world.AddShip(Ship('o', [8000, 0, 0]), rifter);
    world.AddShip(Ship('k', [0, 0, 8000]), rifter);
    world.AddShip(Ship('c', [-8000, 0, 0]), rifter);
    world.AddShip(Ship('p', [0, 0, -8000]), rifter);
    world.AddShip(Ship('x', [0, 5000, 0]), rifter);
    world.AddShip(Ship('u', [0, 9000, 0]), guardian);
    world.Order('o', { type: 'orbit', target: 't', range: 3000, speed: 1 });
    world.Order('k', { type: 'keep-at-range', target: 't', range: 2000, speed: 1 });
    world.Order('c', { type: 'approach', target: 't', speed: 1 });
    world.Order('x', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    harness.Run(5);
    const before = new Map(['o', 'k', 'c'].map((id) => [id, RequireMotion(world, id).speed]));
    world.Order('p', { type: 'orbit', target: 't', range: 1000, speed: 1 });
    const keep: ShipOrder = { type: 'keep-at-range', target: 'u', range: 500, speed: 1 };
    world.Order('x', keep);
    expect(world.RemoveShip('t')).toEqual(['o', 'k', 'c', 'p']);
    for (const id of ['o', 'k', 'c', 'p']) {
      const motion = RequireMotion(world, id);
      expect(motion).toMatchObject({ order: { type: 'stop' }, orderNote: 'stopped: target "t" was removed', mode: 'stop' });
      expect(motion.pendingOrder).toBeUndefined();
    }
    expect(RequireMotion(world, 'x').pendingOrder).toEqual(keep);
    harness.Run(5);
    expect(RequireMotion(world, 'x')).toMatchObject({ order: keep, mode: 'follow' });
    for (const [id, speed] of before) expect(RequireMotion(world, id).speed).toBeLessThan(speed);
    ExpectLockstep(world, 7);
  });

  it('stops a ship on both parks when Destiny refuses its order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('a', [5000, 0, 0]), rifter);
      world.AddShip(Ship('t', [0, 0, 0]), guardian);
      world.Order('a', { type: 'orbit', target: 't', range: 1000, speed: 1 });
      // Breaks lockstep on purpose: the replica's Orbit finds no target and keeps the old order.
      world.replica.RemoveBall(FIRST_SHIP_BALL_ID + 1);
      harness.Run(1.5);
      expect(RequireMotion(world, 'a')).toMatchObject({ order: { type: 'stop' }, orderNote: 'stopped: Destiny refused the orbit order', mode: 'stop' });
      expect(ModeName(world.replica.GetBall(FIRST_SHIP_BALL_ID)?.mode ?? -1)).toBe('stop');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('ship a');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses orders on the ship itself or a ship that does not exist', () => {
    const { world } = new Harness();
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    expect(world.Order('a', { type: 'approach', target: 'a', speed: 1 })).toBe(false);
    expect(world.Order('a', { type: 'orbit', target: 'nobody', range: 100, speed: 1 })).toBe(false);
    expect(world.Order('nobody', { type: 'stop' })).toBe(false);
    expect(RequireMotion(world, 'a').pendingOrder).toBeUndefined();
  });

  it("ends a follower's order on its placement, and keeps it on its target's", () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('t', [0, 0, 0]), guardian);
    world.AddShip(Ship('k', [6000, 0, 0]), rifter);
    const keep: ShipOrder = { type: 'keep-at-range', target: 't', range: 1000, speed: 1 };
    world.Order('k', keep);
    harness.Run(3);
    world.PlaceShip(Ship('k', [6000, 0, 0]));
    const placed = RequireMotion(world, 'k');
    expect(placed).toMatchObject({ order: { type: 'stop' }, mode: 'stop' });
    expect(placed.orderNote).toBeUndefined();
    world.Order('k', keep);
    harness.Run(3);
    world.PlaceShip(Ship('t', [0, 0, 20000]));
    const chasing = RequireMotion(world, 'k');
    expect(chasing).toMatchObject({ order: keep, mode: 'follow' });
    harness.Run(30);
    expect(RequireMotion(world, 'k').targetDistance).toBeLessThan(chasing.targetDistance ?? 0);
  });

  it('keeps the parks in lockstep through every order, a retune and a removal', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0], [30, 0, 0]), rifter);
    world.AddShip(Ship('b', [2000, 100, -400], [0, 45, 0]), guardian);
    world.AddShip(Ship('c', [-3000, 0, 4000]), Fly(TFI));
    world.AddShip(Ship('d', [500, -600, 9000]), rifter);
    world.Order('a', { type: 'goto', point: [4000, 0, 4000], speed: 0.8 });
    world.Order('b', { type: 'direction', direction: [0, 0, -1], speed: 1 });
    harness.Run(3.3);
    world.Order('c', { type: 'orbit', target: 'b', range: 2000, speed: 1 });
    world.Order('d', { type: 'keep-at-range', target: 'b', range: 1500, speed: 0.7 });
    world.Order('a', { type: 'approach', target: 'c', speed: 1 });
    harness.Run(6.4);
    world.SetPhysics('c', { ...Fly(TFI), maxVelocity: 300 });
    harness.Run(4.1);
    expect(world.RemoveShip('b')).toEqual(['c', 'd']);
    harness.Run(5.2);
    ExpectLockstep(world, 4);
  });

  it('accepts a zero max velocity and keeps such a ship in place', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [1000, 0, 0]), rifter);
    world.AddShip(Ship('t', [0, 0, 0]), guardian);
    world.SetPhysics('a', { ...rifter, maxVelocity: 0 });
    world.Order('a', { type: 'orbit', target: 't', range: 300, speed: 1 });
    harness.Run(10);
    const motion = RequireMotion(world, 'a');
    expect(motion.position).toEqual([1000, 0, 0]);
    expect(JSON.stringify(motion)).not.toMatch(/NaN|null/);
    expect([...motion.position, ...motion.velocity, motion.speed, motion.targetDistance].every(Number.isFinite)).toBe(true);
  });
});

describe('DestinyWorld fleet following', () => {
  const tfi = Fly(TFI);
  const rifter = Fly(RIFTER);
  const guardian = Fly(GUARDIAN);
  const BATTLESHIP: ShipPhysics = { mass: 1e8, agility: 0.12, maxVelocity: 105, radius: 400 };
  const DIRECTIONS: SceneVector[] = [
    [0, 0, -1],
    [0.6, 0, -0.8],
    [-0.6, 0, -0.8],
    [0, 0.6, -0.8]
  ];

  function SlotPoint(anchor: ArrayLike<number>, yawDegrees: number, direction: SceneVector, reach: number): SceneVector {
    const yaw = (yawDegrees * Math.PI) / 180;
    const [x, y, z] = direction;
    return [anchor[0] + (x * Math.cos(yaw) + z * Math.sin(yaw)) * reach, anchor[1] + y * reach, anchor[2] + (-x * Math.sin(yaw) + z * Math.cos(yaw)) * reach];
  }

  function FollowOf(anchor: string, direction: SceneVector, slotRange = 1000, frame = 'fc'): ShipFollow {
    return { anchor, range: slotRange, frame, direction, slotRange, speed: 1 };
  }

  interface FleetSetup {
    readonly harness: Harness;
    readonly world: DestinyWorld;
    readonly members: string[];
  }

  /**
   * An FC at the origin facing +Z and members on it at 1 km, in their slots or scattered (facing +X).
   */
  function MakeFleet(input: { readonly fc: ShipPhysics; readonly member: ShipPhysics; readonly count?: number; readonly scatter?: boolean }): FleetSetup {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), input.fc);
    const members = DIRECTIONS.slice(0, input.count ?? DIRECTIONS.length).map((direction, index) => {
      const id = `m${index}`;
      const at = input.scatter ? ([2000 + 1500 * index, 300 * index, 9000 - 2500 * index] as SceneVector) : SlotPoint([0, 0, 0], 0, direction, 1000 + input.fc.radius + input.member.radius);
      world.AddShip(Ship(id, at, input.scatter ? [90, 0, 0] : [0, 0, 0]), input.member);
      expect(world.Follow(id, FollowOf('fc', direction))).toBe(true);
      return id;
    });
    return { harness, world, members };
  }

  function YawGap(a: number, b: number): number {
    const gap = Math.abs(a - b) % 360;
    return Math.min(gap, 360 - gap);
  }

  function Angle(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
    return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
  }

  it('settles a member placed exactly in its slot on the first tick, and it holds still facing the fleet heading', () => {
    const { harness, world, members } = MakeFleet({ fc: tfi, member: guardian });
    const before = members.map((id) => RequireMotion(world, id).position);
    RunTicks(harness, 1);
    harness.Run(20);
    for (const [index, id] of members.entries()) {
      const motion = RequireMotion(world, id);
      expect(motion).toMatchObject({ mode: 'stop', speed: 0, heading: [0, 0], order: { type: 'keep-at-range', target: 'fc', range: 1000, speed: 1 } });
      for (let axis = 0; axis < 3; axis++) expect(Math.abs(motion.position[axis] - before[index][axis])).toBeLessThanOrEqual(0.01);
      expect(motion.slotError).toBe(0);
    }
    ExpectLockstep(world, 5);
  });

  it('forms scattered members up on a stationary FC and turns them smoothly to its heading', () => {
    const { harness, world, members } = MakeFleet({ fc: tfi, member: guardian, scatter: true });
    for (const id of members) harness.Sample(id);
    const forwards = new Map(members.map((id) => [id, Forward(harness.Sample(id).rotation)]));
    let maxStep = 0;
    let settledAt = Number.NaN;
    const track = (): void => {
      for (const id of members) {
        const forward = Forward(harness.Sample(id).rotation);
        // A fresh park's first ticks hold the drawn rotation (the ClientBall's two-tick delay has no history yet),
        // whatever the ship flies; only steps after them count.
        if (world.tick >= 4) maxStep = Math.max(maxStep, Angle(forward, forwards.get(id)!));
        forwards.set(id, forward);
      }
    };
    for (let second = 0; second < 120 && Number.isNaN(settledAt); second++) {
      harness.Run(1, track);
      if (members.every((id) => RequireMotion(world, id).mode === 'stop')) settledAt = second;
    }
    expect(settledAt).toBeLessThan(120);
    harness.Run(20, track);
    for (const id of members) {
      expect(YawGap(RequireMotion(world, id).heading[0], 0), id).toBeLessThanOrEqual(1);
      expect(Angle(Forward(harness.Sample(id).rotation), [0, 0, 1]), id).toBeLessThanOrEqual(2);
      const motion = RequireMotion(world, id);
      expect(motion.slotError).toBeLessThanOrEqual(toFollowTolerance({ slotRange: 1000, anchorSpeed: 0 }));
    }
    expect(maxStep).toBeLessThanOrEqual(2);
    ExpectLockstep(world, 5);
  });

  it('keeps faster members in their slots behind an FC at full speed, while a slower one trails at its own speed', () => {
    const { harness, world, members } = MakeFleet({ fc: tfi, member: rifter, count: 3 });
    world.AddShip(Ship('bs', SlotPoint([0, 0, 0], 0, DIRECTIONS[3], 1000 + tfi.radius + BATTLESHIP.radius)), BATTLESHIP);
    world.Follow('bs', FollowOf('fc', DIRECTIONS[3]));
    world.Order('fc', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    harness.Run(60);
    const fc = RequireMotion(world, 'fc');
    for (const id of members) {
      const motion = RequireMotion(world, id);
      expect(motion.slotError, id).toBeLessThan(50);
      expect(YawGap(motion.heading[0], fc.heading[0]), id).toBeLessThanOrEqual(1);
      expect(motion.mode).toBe('goto');
    }
    const bs = RequireMotion(world, 'bs');
    expect(bs.slotError).toBeGreaterThan(1000);
    expect(Math.abs(bs.speed - BATTLESHIP.maxVelocity) / BATTLESHIP.maxVelocity).toBeLessThanOrEqual(0.01);
    ExpectLockstep(world, 5);
  });

  it('converges same-hull members behind an FC at 0.9', () => {
    const { harness, world, members } = MakeFleet({ fc: tfi, member: tfi, count: 3 });
    world.Order('fc', { type: 'direction', direction: [0, 0, 1], speed: 0.9 });
    harness.Run(120);
    for (const id of members) expect(RequireMotion(world, id).slotError, id).toBeLessThan(60);
  });

  it('swings the formation round an FC turning 90 degrees', () => {
    const { harness, world, members } = MakeFleet({ fc: tfi, member: rifter });
    world.Order('fc', { type: 'direction', direction: [0, 0, 1], speed: 0.5 });
    harness.Run(30);
    world.Order('fc', { type: 'direction', direction: [1, 0, 0], speed: 0.5 });
    harness.Run(45);
    expect(YawGap(RequireMotion(world, 'fc').heading[0], 90)).toBeLessThanOrEqual(1);
    for (const id of members) expect(RequireMotion(world, id).slotError, id).toBeLessThan(100);
    ExpectLockstep(world, 5);
  });

  it("slots a chained member on its own anchor in the FC's frame", () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    world.AddShip(Ship('lead', [3000, 0, -4000]), guardian);
    world.AddShip(Ship('member', [-2000, 0, -2000]), guardian);
    expect(world.Follow('lead', FollowOf('fc', [0, 0, -1], 5000))).toBe(true);
    expect(world.Follow('member', FollowOf('lead', [0.6, 0, -0.8]))).toBe(true);
    world.Order('fc', { type: 'direction', direction: [0, 0, 1], speed: 0.7 });
    harness.Run(120);
    const lead = RequireMotion(world, 'lead');
    expect(lead.slotError).toBeLessThan(100);
    expect(RequireMotion(world, 'member').slotError).toBeLessThanOrEqual(toFollowTolerance({ slotRange: 1000, anchorSpeed: lead.speed }));
    ExpectLockstep(world, 3);
  });

  it('hands a ship between its own orders and following', () => {
    const { harness, world, members } = MakeFleet({ fc: tfi, member: guardian, count: 2, scatter: true });
    const [a, b] = members;
    const follow = FollowOf('fc', DIRECTIONS[0]);
    expect(RequireMotion(world, a).pendingOrder).toEqual({ type: 'keep-at-range', target: 'fc', range: 1000, speed: 1 });
    RunTicks(harness, 1);
    const following = RequireMotion(world, a);
    expect(following.pendingOrder).toBeUndefined();
    expect(following.order).toEqual({ type: 'keep-at-range', target: 'fc', range: 1000, speed: 1 });
    expect(following.targetDistance).toBeGreaterThan(0);
    expect(following.slotError).toBeGreaterThan(0);
    expect(following.heading).toHaveLength(2);

    const stop: ShipOrder = { type: 'stop' };
    expect(world.Order(a, stop)).toBe(true);
    expect(world.Following(a)).toBeNull();
    RunTicks(harness, 1);
    expect(RequireMotion(world, a)).toMatchObject({ order: stop, mode: 'stop' });
    expect(RequireMotion(world, a).slotError).toBeUndefined();

    world.Order(a, { type: 'direction', direction: [1, 0, 0], speed: 1 });
    expect(world.Follow(a, follow)).toBe(true);
    expect(RequireMotion(world, a).pendingOrder).toEqual({ type: 'keep-at-range', target: 'fc', range: 1000, speed: 1 });
    expect(world.Follow(a, { ...follow, anchor: a })).toBe(false);
    expect(world.Follow(a, { ...follow, anchor: 'ghost' })).toBe(false);
    expect(world.Follow('ghost', follow)).toBe(false);

    expect(world.Unfollow(b, 'stopped: test')).toBe(true);
    expect(world.Unfollow(b, 'stopped: test')).toBe(false);
    expect(world.Following(b)).toBeNull();
    expect(RequireMotion(world, b)).toMatchObject({ order: stop, orderNote: 'stopped: test' });

    harness.Run(90);
    world.PlaceShip(Ship(a, [8000, 0, 8000]));
    expect(world.Following(a)).toEqual(follow);
    RunTicks(harness, 1);
    expect(RequireMotion(world, a).mode).toBe('goto');
    harness.Run(90);
    expect(RequireMotion(world, a).slotError).toBeLessThanOrEqual(toFollowTolerance({ slotRange: 1000, anchorSpeed: 0 }));
    ExpectLockstep(world, 3);
  });

  it('leaves the followers of a removed anchor to the caller, and halts the ones it does not re-point', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    world.AddShip(Ship('lead', [0, 0, -5000]), guardian);
    world.AddShip(Ship('kept', [500, 0, -6000]), guardian);
    world.AddShip(Ship('lost', [-500, 0, -6000]), guardian);
    world.Follow('lead', FollowOf('fc', [0, 0, -1], 5000));
    world.Follow('kept', FollowOf('lead', [0.6, 0, -0.8]));
    world.Follow('lost', FollowOf('lead', [-0.6, 0, -0.8]));
    harness.Run(5);
    expect(world.RemoveShip('lead')).toEqual([]);
    expect(world.Follow('kept', FollowOf('fc', [0.6, 0, -0.8], 5000))).toBe(true);
    RunTicks(harness, 1);
    expect(world.Following('lost')).toBeNull();
    expect(RequireMotion(world, 'lost')).toMatchObject({ order: { type: 'stop' }, orderNote: 'stopped: anchor "lead" was removed' });
    expect(RequireMotion(world, 'kept')).toMatchObject({ mode: 'goto', order: { type: 'keep-at-range', target: 'fc', range: 5000 } });
    ExpectLockstep(world, 4);
  });
});

describe('DestinyWorld warp', () => {
  const rifter = Fly(RIFTER);
  const guardian = Fly(GUARDIAN);
  const tfi = Fly(TFI);
  const AU = 149_597_870_700;
  const AHEAD: SceneVector = [0, 0, 300_000];

  function WarpOf(world: DestinyWorld, id: string): Maybe<ShipWarp> {
    return RequireMotion(world, id).warp ?? null;
  }

  function Gap(a: ArrayLike<number>, b: ArrayLike<number>): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /**
   * Runs ticks until `done`, failing after `limit` of them.
   */
  function RunUntil(harness: Harness, done: () => boolean, limit: number, onTick?: () => void): void {
    for (let tick = 0; !done(); tick++) {
      if (tick >= limit) throw new Error(`not done after ${limit} ticks`);
      RunTicks(harness, 1, onTick);
    }
  }

  function Landed(world: DestinyWorld, id: string): boolean {
    return WarpOf(world, id)?.phase === 'landed';
  }

  function InWarp(world: DestinyWorld, id: string): boolean {
    const phase = WarpOf(world, id)?.phase;
    return phase === 'warping' || phase === 'exiting';
  }

  it("aligns, warps and lands at the ship's warp speed, in lockstep", () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    expect(RequireMotion(world, 'a').warp).toBeUndefined();
    expect(world.Order('a', { type: 'warp', point: AHEAD, range: 0 })).toBe(true);
    expect(RequireMotion(world, 'a').pendingOrder).toEqual({ type: 'warp', point: AHEAD, range: 0 });
    const phases: string[] = [];
    let alignTicks = -1;
    let progress = 0;
    let landsIn = Infinity;
    let topSpeed = 0;
    RunUntil(
      harness,
      () => Landed(world, 'a'),
      40,
      () => {
        ExpectLockstep(world, 1);
        const motion = RequireMotion(world, 'a');
        const warp = motion.warp;
        if (!warp) throw new Error('no warp report');
        if (phases.at(-1) !== warp.phase) phases.push(warp.phase);
        expect(warp.warpSpeed).toBe(5);
        topSpeed = Math.max(topSpeed, motion.speed);
        if (warp.phase === 'aligning') {
          expect(motion.mode).toBe('warp');
          expect(warp).toMatchObject({ progress: 0, landing: AHEAD });
          expect(warp.alignTicks).toBeGreaterThan(alignTicks);
          alignTicks = warp.alignTicks ?? 0;
        } else if (warp.phase !== 'landed') {
          expect(motion.mode).toBe('warp');
          expect(warp.progress).toBeGreaterThanOrEqual(progress);
          expect(warp.landsIn).toBeLessThanOrEqual(landsIn);
          expect(warp.distance).toBeGreaterThan(290_000);
          progress = warp.progress;
          landsIn = warp.landsIn ?? 0;
          expect(world.master.GetBall(FIRST_SHIP_BALL_ID)?.ownerId).toBe(5000n);
          expect(world.replica.GetBall(FIRST_SHIP_BALL_ID)?.ownerId).toBe(5000n);
        }
      }
    );
    expect(phases).toEqual(['aligning', 'warping', 'exiting', 'landed']);
    expect(topSpeed).toBeGreaterThan(100_000);
    RunTicks(harness, 10);
    const motion = RequireMotion(world, 'a');
    expect(motion).toMatchObject({ mode: 'stop', order: { type: 'warp', point: AHEAD }, warp: { phase: 'landed', progress: 1, landing: AHEAD } });
    expect(motion.warp?.landsIn).toBeUndefined();
    expect(Gap(motion.position, AHEAD)).toBeLessThan(2000);
    expect(motion.warp?.remaining).toBe(Math.round(Gap(motion.position, AHEAD)));
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID)?.isMassive).toBe(false);
    expect(world.replica.GetBall(FIRST_SHIP_BALL_ID)?.isMassive).toBe(false);
    ExpectLockstep(world, 1);
    world.Order('a', { type: 'stop' });
    RunTicks(harness, 1);
    expect(RequireMotion(world, 'a').warp).toBeUndefined();
  });

  it("lands a faster warp sooner, on Destiny's profile", () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('slow', [-5000, 0, 0]), { ...rifter, warpSpeed: 3 });
    world.AddShip(Ship('fast', [5000, 0, 0]), rifter);
    const events: WarpEvent[] = [];
    world.OnWarp((event) => events.push(event));
    world.Order('slow', { type: 'warp', point: [-5000, 0, 10 * AU], range: 0 });
    world.Order('fast', { type: 'warp', point: [5000, 0, 10 * AU], range: 0 });
    RunUntil(
      harness,
      () => Landed(world, 'slow') && Landed(world, 'fast'),
      80,
      () => ExpectLockstep(world, 2)
    );
    const exits = events.filter((event) => event.kind === 'exit').map((event) => event.id);
    expect(exits).toEqual(['fast', 'slow']);
    for (const id of ['slow', 'fast']) {
      const enter = events.find((event) => event.id === id && event.kind === 'enter');
      const exit = events.find((event) => event.id === id && event.kind === 'exit');
      const distance = WarpOf(world, id)?.distance ?? 0;
      const profile = world.master.SetupWarpConstants(id === 'slow' ? 3000 : 5000, distance, {});
      expect((exit?.tick ?? 0) - (enter?.tick ?? 0)).toBe(WarpExitTime(profile, rifter.maxVelocity));
    }
  });

  it('warps to a ship at a range, surface to surface, and flies on when the target goes', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.AddShip(Ship('t', [0, 0, 400_000]), guardian);
    world.Order('a', { type: 'warp', target: 't', range: 10_000 });
    RunUntil(harness, () => Landed(world, 'a'), 40);
    const landing = WarpOf(world, 'a')?.landing ?? [0, 0, 0];
    expect(Gap(landing, [0, 0, 400_000])).toBeCloseTo(10_000 + rifter.radius + guardian.radius, 1);
    expect(Gap(RequireMotion(world, 'a').position, landing)).toBeLessThan(2000);

    world.AddShip(Ship('b', [0, 0, 0]), rifter);
    world.Order('b', { type: 'warp', target: 'a', range: 0 });
    RunUntil(harness, () => InWarp(world, 'b'), 20);
    expect(world.RemoveShip('a')).toEqual([]);
    RunUntil(harness, () => Landed(world, 'b'), 40);
    expect(RequireMotion(world, 'b').orderNote).toBeUndefined();

    world.AddShip(Ship('c', [0, 0, -500_000]), rifter);
    world.Order('c', { type: 'warp', target: 't', range: 0 });
    expect(world.RemoveShip('t')).toEqual(['c']);
    RunTicks(harness, 1);
    expect(RequireMotion(world, 'c')).toMatchObject({ order: { type: 'stop' }, orderNote: 'stopped: target "t" was removed', mode: 'stop' });
  });

  it('refuses a short warp, a ship that cannot move, a target in warp and any order in warp', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.AddShip(Ship('near', [0, 0, 120_000]), guardian);
    world.AddShip(Ship('still', [1000, 0, 0]), { ...FRIGATE, maxVelocity: 0 });
    world.AddShip(Ship('b', [-1000, 0, 0]), rifter);
    expect(world.OrderRefusal('a', { type: 'warp', point: [0, 0, 100_000], range: 0 })).toBe('ship "a" would land 100 km away; EVE warps only 150 km or more, so use goto');
    expect(world.OrderRefusal('a', { type: 'warp', point: AHEAD, range: 200_000 })).toBe('ship "a" would land 100 km away; EVE warps only 150 km or more, so use goto');
    expect(world.OrderRefusal('a', { type: 'warp', target: 'near', range: 0 })).toMatch(/^ship "a" would land 119\.9 km away/);
    expect(world.Order('a', { type: 'warp', target: 'near', range: 0 })).toBe(false);
    expect(world.OrderRefusal('still', { type: 'warp', point: AHEAD, range: 0 })).toBe('ship "still" cannot warp: its max velocity is 0');
    expect(world.OrderRefusal('a', { type: 'warp', target: 'nobody', range: 0 })).toBe('ship "a" or its target has no Destiny ball');
    expect(world.OrderRefusal('a', { type: 'warp', point: AHEAD, range: 0 })).toBeNull();

    world.Order('a', { type: 'warp', point: AHEAD, range: 0 });
    RunUntil(harness, () => InWarp(world, 'a'), 20);
    expect(world.OrderRefusal('b', { type: 'warp', target: 'a', range: 0 })).toBe('target "a" is in warp');
    const orders: ShipOrder[] = [{ type: 'stop' }, { type: 'goto', point: [0, 0, 0], speed: 1 }, { type: 'orbit', target: 'b', range: 1000, speed: 1 }, { type: 'warp', point: [0, 0, -AU], range: 0 }];
    for (const order of orders) {
      expect(world.OrderRefusal('a', order)).toMatch(/^ship "a" is in warp; it takes orders again once it lands, in about \d+ s$/);
      expect(world.Order('a', order)).toBe(false);
    }
    expect(RequireMotion(world, 'a').pendingOrder).toBeUndefined();
    RunUntil(harness, () => Landed(world, 'a'), 40);
    expect(world.Order('a', { type: 'stop' })).toBe(true);
  });

  it('cancels a warp for an order while aligning, keeping the align counter only for the same destination', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), tfi);
    world.Order('a', { type: 'warp', point: AHEAD, range: 0 });
    RunTicks(harness, 2);
    expect(WarpOf(world, 'a')).toMatchObject({ phase: 'aligning', alignTicks: 2 });
    world.Order('a', { type: 'warp', point: AHEAD, range: 0 });
    RunTicks(harness, 1);
    expect(WarpOf(world, 'a')?.alignTicks).toBe(3);
    world.Order('a', { type: 'warp', point: [0, 0, 400_000], range: 0 });
    RunTicks(harness, 1);
    expect(WarpOf(world, 'a')).toMatchObject({ phase: 'aligning', alignTicks: 1, landing: [0, 0, 400_000] });
    world.Order('a', { type: 'stop' });
    RunTicks(harness, 1);
    expect(RequireMotion(world, 'a')).toMatchObject({ mode: 'stop', order: { type: 'stop' } });
    expect(RequireMotion(world, 'a').warp).toBeUndefined();
    ExpectLockstep(world, 1);
  });

  it('stops the ship on both parks when Destiny refuses the warp', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('a', [0, 0, 0]), rifter);
      world.Order('a', { type: 'warp', point: AHEAD, range: 0 });
      // Breaks lockstep on purpose: within 100 km of the point, the replica's WarpTo becomes a GotoPoint.
      world.replica.SetBallPosition(FIRST_SHIP_BALL_ID, 0, 0, 250_000);
      RunTicks(harness, 1);
      expect(RequireMotion(world, 'a')).toMatchObject({ order: { type: 'stop' }, orderNote: 'stopped: Destiny refused the warp order', mode: 'stop' });
      expect(RequireMotion(world, 'a').warp).toBeUndefined();
      expect(ModeName(world.replica.GetBall(FIRST_SHIP_BALL_ID)?.mode ?? -1)).toBe('stop');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('ends a warp on a placement, at rest and with no exit event', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    const events: WarpEvent[] = [];
    world.OnWarp((event) => events.push(event));
    world.Order('a', { type: 'warp', point: [0, 0, AU], range: 0 });
    RunUntil(harness, () => InWarp(world, 'a'), 20);
    RunTicks(harness, 2);
    world.PlaceShip(Ship('a', [100, 200, 300]));
    RunTicks(harness, 2);
    const motion = RequireMotion(world, 'a');
    expect(motion).toMatchObject({ position: [100, 200, 300], speed: 0, mode: 'stop', order: { type: 'stop' } });
    expect(motion.warp).toBeUndefined();
    expect(events.map((event) => event.kind)).toEqual(['enter']);
    ExpectLockstep(world, 1);
  });

  it('reports entering and leaving warp to every listener, after the tick', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('a', [0, 0, 0]), rifter);
      const events: WarpEvent[] = [];
      world.OnWarp(() => {
        throw new Error('listener failure');
      });
      const off = world.OnWarp((event) => {
        expect(event.tick).toBe(world.tick);
        events.push(event);
      });
      world.Order('a', { type: 'warp', point: AHEAD, range: 0 });
      RunUntil(harness, () => Landed(world, 'a'), 40);
      expect(events.map((event) => event.kind)).toEqual(['enter', 'exit']);
      const [enter, exit] = events;
      expect(enter).toMatchObject({ id: 'a', landing: AHEAD, warpSpeed: 5 });
      expect(enter.direction[2]).toBeCloseTo(1, 6);
      expect(Math.hypot(enter.position[0], enter.position[1])).toBeLessThan(1);
      expect(enter.position[2]).toBeLessThan(5000);
      expect(exit.tick).toBeGreaterThan(enter.tick);
      expect(Gap(exit.position, AHEAD)).toBeLessThan(2000);
      expect(error).toHaveBeenCalledTimes(2);
      off();
      world.Order('a', { type: 'warp', point: [0, 0, 0], range: 0 });
      RunUntil(harness, () => Landed(world, 'a'), 40);
      expect(events).toHaveLength(2);
    } finally {
      error.mockRestore();
    }
  });

  it('retunes the warp speed while aligning, not in warp', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), tfi);
    world.Order('a', { type: 'warp', point: AHEAD, range: 0 });
    RunTicks(harness, 1);
    world.SetPhysics('a', { ...tfi, warpSpeed: 4 });
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID)?.ownerId).toBe(4000n);
    expect(world.replica.GetBall(FIRST_SHIP_BALL_ID)?.ownerId).toBe(4000n);
    expect(WarpOf(world, 'a')?.warpSpeed).toBe(4);
    RunUntil(harness, () => InWarp(world, 'a'), 40);
    world.SetPhysics('a', { ...tfi, warpSpeed: 2 });
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID)?.ownerId).toBe(4000n);
    expect(world.replica.GetBall(FIRST_SHIP_BALL_ID)?.ownerId).toBe(4000n);
    expect(() => world.SetPhysics('a', { ...tfi, warpSpeed: 0 })).toThrow(/warpSpeed/);
  });

  it('holds a fleet while its FC is in warp, then flies it to the landing', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    const directions: SceneVector[] = [
      [0, 0, -1],
      [0.6, 0, -0.8]
    ];
    directions.forEach((direction, index) => {
      world.AddShip(Ship(`m${index}`, [direction[0] * 1400, 0, direction[2] * 1400]), rifter);
      world.Follow(`m${index}`, { anchor: 'fc', range: 1000, frame: 'fc', direction, slotRange: 1000, speed: 1 });
    });
    RunTicks(harness, 3);
    world.Order('fc', { type: 'warp', point: AHEAD, range: 0 });
    let held = 0;
    let warpTicks = 0;
    RunUntil(
      harness,
      () => Landed(world, 'fc'),
      60,
      () => {
        ExpectLockstep(world, 3);
        if (!InWarp(world, 'fc')) return;
        if (warpTicks++ === 0) return;
        for (const id of ['m0', 'm1']) {
          expect(RequireMotion(world, id).mode).toBe('stop');
          expect(world.FollowHold(id)).toBe('fc');
          held += 1;
        }
      }
    );
    expect(held).toBeGreaterThan(4);
    RunTicks(harness, 2);
    const errors = ['m0', 'm1'].map((id) => RequireMotion(world, id).slotError ?? 0);
    RunTicks(harness, 5, () => ExpectLockstep(world, 3));
    ['m0', 'm1'].forEach((id, index) => {
      const motion = RequireMotion(world, id);
      expect(motion.mode).toBe('goto');
      expect(world.FollowHold(id)).toBeNull();
      expect(motion.slotError ?? 0).toBeLessThan(errors[index]);
    });
  });

  it('lets a ship told to follow while in warp finish its warp first', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    world.AddShip(Ship('x', [5000, 0, 0]), rifter);
    world.Order('x', { type: 'warp', point: [5000, 0, 300_000], range: 0 });
    RunUntil(harness, () => InWarp(world, 'x'), 20);
    expect(world.Follow('x', { anchor: 'fc', range: 1000, frame: 'fc', direction: [0, 0, -1], slotRange: 1000, speed: 1 })).toBe(true);
    RunUntil(
      harness,
      () => Landed(world, 'x'),
      40,
      () => {
        if (InWarp(world, 'x')) expect(RequireMotion(world, 'x').mode).toBe('warp');
      }
    );
    RunTicks(harness, 1);
    const motion = RequireMotion(world, 'x');
    expect(motion).toMatchObject({ mode: 'goto', order: { type: 'keep-at-range', target: 'fc' } });
    expect(motion.warp).toBeUndefined();
  });
});

describe('DestinyWorld prop mods', () => {
  const TFI_SIZED: PublishedHull = { ...TFI, published: { ...TFI.published, rigSize: 3 } };
  const GUARDIAN_SIZED: PublishedHull = { ...GUARDIAN, published: { ...GUARDIAN.published, rigSize: 2 } };
  const tfi = ResolveFlight({ published: TFI_SIZED, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 3, answer: null }) });
  const guardianAb = ResolveFlight({ published: GUARDIAN_SIZED, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'ab', rigSize: 2, answer: null }) });
  const MWD_MASS = 153_300_000;
  const MWD_SPEED = Math.fround(tfi.propMod?.maxVelocity ?? 0);
  const BASE_SPEED = Math.fround(tfi.maxVelocity);

  function Cruising(physics: ShipPhysics = tfi): { harness: Harness; world: DestinyWorld; events: PropModEvent[] } {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), physics);
    world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    RunTicks(harness, 30);
    const events: PropModEvent[] = [];
    world.OnPropMod((event) => events.push(event));
    return { harness, world, events };
  }

  function Ball(world: DestinyWorld, park: 'master' | 'replica' = 'master'): CjsDestinyBall {
    const ball = world[park].GetBall(FIRST_SHIP_BALL_ID);
    if (!ball) throw new Error('no ball');
    return ball;
  }

  it('makes a delayed switch that many ticks late, and a new switch or the document state replaces it', () => {
    const { harness, world, events } = Cruising();
    const boundary = world.tick;
    expect(world.SwitchPropMod('a', true, { delay: 3 })).toEqual({ state: 'off', respondsIn: 3 });
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'off', queued: { on: true, respondsIn: 3 } });
    RunTicks(harness, 3);
    expect(events).toEqual([]);
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'off', queued: { on: true, respondsIn: 0 } });
    RunTicks(harness, 1);
    expect(events).toEqual([{ kind: 'on', id: 'a', tick: boundary + 3, cause: 'switch' }]);
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'active', since: boundary + 3 });
    expect(RequireMotion(world, 'a').propMod.queued).toBeUndefined();
    expect(Ball(world, 'replica').maxVelocity).toBe(MWD_SPEED);

    world.SwitchPropMod('a', false, { delay: 5 });
    expect(world.SwitchPropMod('a', false)).toMatchObject({ state: 'stopping' });
    expect(RequireMotion(world, 'a').propMod.queued).toBeUndefined();
    world.SwitchPropMod('a', true, { delay: 2 });
    world.SetPropModActive('a', false);
    expect(RequireMotion(world, 'a').propMod.queued).toBeUndefined();
    ExpectLockstep(world, 1);
  });

  it('switches on at the next tick boundary: both parks fly the MWD numbers and the ship speeds up', () => {
    const { harness, world, events } = Cruising();
    expect(RequireMotion(world, 'a').speed).toBeGreaterThan(BASE_SPEED * 0.95);
    const boundary = world.tick;
    expect(world.SwitchPropMod('a', true)).toEqual({ state: 'activating', at: boundary });
    expect(RequireMotion(world, 'a').propMod).toEqual({ state: 'activating', running: false, cycleTime: 10, at: boundary });
    expect(Ball(world).maxVelocity).toBe(BASE_SPEED);
    RunTicks(harness, 1);
    expect(events).toEqual([{ kind: 'on', id: 'a', tick: boundary, cause: 'switch' }]);
    expect(RequireMotion(world, 'a').propMod).toEqual({ state: 'active', running: true, cycleTime: 10, since: boundary });
    for (const park of ['master', 'replica'] as const) {
      expect(Ball(world, park).mass).toBe(MWD_MASS);
      expect(Ball(world, park).maxVelocity).toBe(MWD_SPEED);
    }
    let passed = Number.NaN;
    RunTicks(harness, 30, () => {
      if (Number.isNaN(passed) && RequireMotion(world, 'a').speed > 1000) passed = world.tick - boundary;
    });
    expect(passed).toBeLessThanOrEqual(30);
    ExpectLockstep(world, 1);
  });

  it('a prop mod change shows on the drawn ship from the frame its event is delivered, so its sound needs no wait', () => {
    const { harness, world, events } = Cruising();
    world.SwitchPropMod('a', true);
    let delivered = Number.NaN;
    let deliveredTick = Number.NaN;
    let drawn = Number.NaN;
    for (let frame = 0; frame < 60 * 10 && Number.isNaN(drawn); frame++) {
      harness.Run(1 / 60);
      if (Number.isNaN(delivered) && events.length) {
        delivered = harness.now;
        deliveredTick = world.tick;
      }
      const velocity = harness.Sample('a').velocity;
      // The drawn ClientBall trails the master by one tick, interpolating toward it: it leaves cruise at once.
      if (Math.hypot(velocity[0], velocity[1], velocity[2]) > BASE_SPEED * 1.005 + 0.5) drawn = harness.now;
    }
    expect(deliveredTick - (events[0]?.tick ?? Number.NaN)).toBe(1);
    expect((drawn - delivered) / TICKS_PER_SECOND).toBeGreaterThanOrEqual(0);
    expect((drawn - delivered) / TICKS_PER_SECOND).toBeLessThan(0.1);
  });

  it('switches off at the end of the running cycle, rounded up to a tick, and slows to base speed', () => {
    const { harness, world, events } = Cruising();
    world.SwitchPropMod('a', true);
    RunTicks(harness, 1);
    const since = RequireMotion(world, 'a').propMod.since ?? 0;
    expect(world.SwitchPropMod('a', false)).toEqual({ state: 'stopping', stopsAt: since + 10, stopsIn: 9 });
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'stopping', running: true, stopsIn: 9 });
    RunTicks(harness, 8);
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'stopping', stopsIn: 1 });
    RunTicks(harness, 1);
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'stopping', stopsIn: 0 });
    RunTicks(harness, 1);
    expect(events.map((event) => [event.kind, event.tick])).toEqual([
      ['on', since],
      ['off', since + 10]
    ]);
    expect(RequireMotion(world, 'a').propMod).toEqual({ state: 'off', running: false, cycleTime: 10 });
    expect(Ball(world).maxVelocity).toBe(BASE_SPEED);
    expect(Ball(world).mass).toBe(TFI.published.mass);
    const fast = RequireMotion(world, 'a').speed;
    RunTicks(harness, 30);
    expect(RequireMotion(world, 'a').speed).toBeLessThan(fast / 3);
    ExpectLockstep(world, 1);
  });

  it('rounds a 7.5 s afterburner cycle up to a tick', () => {
    expect(CycleEnd({ since: 100, boundary: 101, cycle: 10 })).toBe(110);
    expect(CycleEnd({ since: 100, boundary: 111, cycle: 10 })).toBe(120);
    expect(CycleEnd({ since: 100, boundary: 110, cycle: 10 })).toBe(110);
    expect(CycleEnd({ since: 100, boundary: 100, cycle: 10 })).toBe(110);
    expect(CycleEnd({ since: 100, boundary: 101, cycle: 7.5 })).toBe(108);
    const { harness, world } = Cruising(guardianAb);
    world.SwitchPropMod('a', true);
    RunTicks(harness, 1);
    const since = RequireMotion(world, 'a').propMod.since ?? 0;
    expect(world.SwitchPropMod('a', false)).toMatchObject({ stopsAt: since + 8 });
    RunTicks(harness, 8);
    expect(RequireMotion(world, 'a').propMod.state).toBe('off');
  });

  it('keeps running when switched on while stopping, and cancels an activation switched off, without events', () => {
    const { harness, world, events } = Cruising();
    world.SwitchPropMod('a', true);
    RunTicks(harness, 1);
    world.SwitchPropMod('a', false);
    RunTicks(harness, 3);
    expect(world.SwitchPropMod('a', true)).toEqual({ state: 'active' });
    RunTicks(harness, 15);
    expect(RequireMotion(world, 'a').propMod.state).toBe('active');
    expect(world.SwitchPropMod('a', true)).toEqual({ state: 'active' });
    const fresh = Cruising();
    expect(fresh.world.SwitchPropMod('a', true)?.state).toBe('activating');
    expect(fresh.world.SwitchPropMod('a', false)).toEqual({ state: 'off' });
    expect(fresh.world.SwitchPropMod('a', false)).toEqual({ state: 'off' });
    RunTicks(fresh.harness, 2);
    expect(fresh.events).toEqual([]);
    expect(events.map((event) => event.kind)).toEqual(['on']);
    expect(world.SwitchPropMod('ghost', true)).toBeNull();
    expect(world.PropModRefusal('ghost', true)).toBe('ship "ghost" has no Destiny ball');
  });

  it('sets the document state at once, with its events before the call returns', () => {
    const { world, events } = Cruising();
    world.SetPropModActive('a', true);
    expect(events).toEqual([{ kind: 'on', id: 'a', tick: world.tick, cause: 'document' }]);
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'active', running: true, since: world.tick });
    expect(Ball(world, 'replica').maxVelocity).toBe(MWD_SPEED);
    world.SetPropModActive('a', true);
    world.SetPropModActive('a', false);
    world.SetPropModActive('a', false);
    expect(events.map((event) => [event.kind, event.cause])).toEqual([
      ['on', 'document'],
      ['off', 'document']
    ]);
    expect(Ball(world).maxVelocity).toBe(BASE_SPEED);
    ExpectLockstep(world, 1);
  });

  it('allows a switch while aligning (a slower align), switches off entering warp and refuses to switch on in warp', () => {
    const align = (on: boolean): { ticks: number; world: DestinyWorld; events: PropModEvent[] } => {
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('a', [0, 0, 0]), tfi);
      const events: PropModEvent[] = [];
      world.OnPropMod((event) => events.push(event));
      if (on) world.SetPropModActive('a', true);
      world.Order('a', { type: 'warp', point: [0, 0, 1e9], range: 0 });
      let ticks = 0;
      while (RequireMotion(world, 'a').warp?.phase === undefined || RequireMotion(world, 'a').warp?.phase === 'aligning') {
        RunTicks(harness, 1);
        if (++ticks > 200) throw new Error('never entered warp');
      }
      ExpectLockstep(world, 1);
      return { ticks, world, events };
    };
    const off = align(false);
    const on = align(true);
    expect(on.ticks).toBeGreaterThan(off.ticks);
    expect(RequireMotion(on.world, 'a').propMod).toEqual({ state: 'off', running: false, cycleTime: 10, note: 'off: entered warp' });
    expect(on.events.map((event) => [event.kind, event.cause])).toEqual([
      ['on', 'document'],
      ['off', 'warp']
    ]);
    expect(Ball(on.world).maxVelocity).toBe(BASE_SPEED);
    expect(on.world.SwitchPropMod('a', true)).toBeNull();
    expect(on.world.PropModRefusal('a', true)).toMatch(/^ship "a" is in warp; switch its prop mod on once it lands, in about \d+ s$/u);
    expect(on.world.PropModRefusal('a', false)).toBeNull();
    on.world.SetPropModActive('a', true);
    expect(RequireMotion(on.world, 'a').propMod).toMatchObject({ state: 'off', note: 'not switched on: in warp' });
  });

  it('flies the new running numbers on a retune, base numbers without a prop mod, and refuses a bad one', () => {
    const { world } = Cruising();
    world.SetPropModActive('a', true);
    const faster = { ...tfi, propMod: { ...(tfi.propMod as NonNullable<typeof tfi.propMod>), maxVelocity: 2000 } };
    world.SetPhysics('a', faster);
    expect(Ball(world).maxVelocity).toBe(2000);
    expect(Ball(world, 'replica').maxVelocity).toBe(2000);
    const { propMod: _dropped, ...bare } = tfi;
    world.SetPhysics('a', bare);
    expect(Ball(world).maxVelocity).toBe(BASE_SPEED);
    expect(RequireMotion(world, 'a').propMod).toEqual({ state: 'active', running: false, since: world.tick });
    expect(() => world.SetPhysics('a', { ...tfi, propMod: { mass: 0, maxVelocity: 1, cycleTime: Number.NaN } })).toThrow(/propMod\.mass, propMod\.cycleTime/u);
    ExpectLockstep(world, 1);
  });

  it('logs a throwing listener and still calls the rest', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { world, events } = Cruising();
      world.OnPropMod(() => {
        throw new Error('boom');
      });
      const seen: string[] = [];
      const off = world.OnPropMod((event) => seen.push(event.kind));
      world.SetPropModActive('a', true);
      off();
      world.SetPropModActive('a', false);
      expect(events).toHaveLength(2);
      expect(seen).toEqual(['on']);
      expect(error).toHaveBeenCalledWith("an OnPropMod listener failed on ship a's prop mod on", expect.any(Error));
    } finally {
      error.mockRestore();
    }
  });

  it('keeps a fleet in formation at MWD speeds, and members off their MWDs trail at their own speed', () => {
    const DIRECTIONS: SceneVector[] = [
      [0, 0, -1],
      [0.6, 0, -0.8],
      [-0.6, 0, -0.8]
    ];
    const fleet = (membersOn: boolean): { harness: Harness; world: DestinyWorld; members: string[] } => {
      const harness = new Harness();
      const { world } = harness;
      world.AddShip(Ship('fc', [0, 0, 0]), tfi);
      const members = DIRECTIONS.map((direction, index) => {
        const id = `m${index}`;
        const reach = 1000 + 2 * tfi.radius;
        world.AddShip(Ship(id, [direction[0] * reach, direction[1] * reach, direction[2] * reach]), tfi);
        world.Follow(id, { anchor: 'fc', range: 1000, frame: 'fc', direction, slotRange: 1000, speed: 1 });
        return id;
      });
      RunTicks(harness, 3);
      world.SetPropModActive('fc', true);
      if (membersOn) for (const id of members) world.SetPropModActive(id, true);
      world.Order('fc', { type: 'direction', direction: [0, 0, 1], speed: 1 });
      RunTicks(harness, 60);
      return { harness, world, members };
    };
    const together = fleet(true);
    expect(RequireMotion(together.world, 'fc').speed).toBeGreaterThan(1000);
    for (const id of together.members) {
      const motion = RequireMotion(together.world, id);
      expect(motion.speed, id).toBeGreaterThan(1000);
      expect(motion.slotError, id).toBeLessThanOrEqual(toFollowTolerance({ slotRange: 1000, anchorSpeed: RequireMotion(together.world, 'fc').speed }));
    }
    ExpectLockstep(together.world, 4);
    together.world.Order('fc', { type: 'stop' });
    let settledAfter = 0;
    while (!together.members.every((id) => RequireMotion(together.world, id).mode === 'stop')) {
      RunTicks(together.harness, 1);
      if (++settledAfter > 600) break;
    }
    expect(settledAfter).toBeLessThanOrEqual(240);
    RunTicks(together.harness, 30);
    for (const id of together.members) {
      const motion = RequireMotion(together.world, id);
      expect(motion.mode, id).toBe('stop');
      expect(Math.min(Math.abs(motion.heading[0]), 360 - motion.heading[0]), id).toBeLessThanOrEqual(1);
    }
    ExpectLockstep(together.world, 4);

    const trailing = fleet(false);
    for (const id of trailing.members) {
      const motion = RequireMotion(trailing.world, id);
      expect(motion.speed, id).toBeLessThanOrEqual(BASE_SPEED + 0.1);
      expect(motion.slotError, id).toBeGreaterThan(5000);
    }
  });
});

describe('DestinyWorld formation warp', () => {
  const rifter = Fly(RIFTER);
  const guardian = Fly(GUARDIAN);
  const tfi = Fly(TFI);
  const AWAY: SceneVector = [300_000, 0, 300_000];
  const MEMBERS = [
    { id: 'm0', physics: rifter, direction: [0, 0, -1] as SceneVector },
    { id: 'm1', physics: guardian, direction: [0.6, 0, -0.8] as SceneVector }
  ];

  interface Group {
    readonly harness: Harness;
    readonly world: DestinyWorld;
    readonly offsets: Map<string, SceneVector>;
  }

  function FollowOf(direction: SceneVector): ShipFollow {
    return { anchor: 'fc', range: 1000, frame: 'fc', direction, slotRange: 1000, speed: 1 };
  }

  /**
   * The FC (a TFI) at the origin facing +Z, a Rifter and a Guardian following it in their 1 km slots, three ticks on.
   */
  function MakeGroup(): Group {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    const offsets = new Map<string, SceneVector>();
    for (const { id, physics, direction } of MEMBERS) {
      const reach = 1000 + tfi.radius + physics.radius;
      const offset: SceneVector = [direction[0] * reach, direction[1] * reach, direction[2] * reach];
      world.AddShip(Ship(id, offset), physics);
      expect(world.Follow(id, FollowOf(direction))).toBe(true);
      offsets.set(id, offset);
    }
    RunTicks(harness, 3);
    return { harness, world, offsets };
  }

  function Gap(a: ArrayLike<number>, b: ArrayLike<number>): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function RunUntil(harness: Harness, done: () => boolean, limit: number, onTick?: () => void): void {
    for (let tick = 0; !done(); tick++) {
      if (tick >= limit) throw new Error(`not done after ${limit} ticks`);
      RunTicks(harness, 1, onTick);
    }
  }

  function Landed(world: DestinyWorld, id: string): boolean {
    return RequireMotion(world, id).warp?.phase === 'landed';
  }

  function WarpTogether(group: Group, point: SceneVector = AWAY): void {
    expect(group.world.Order('fc', { type: 'warp', point, range: 0 })).toBe(true);
    for (const [id, offset] of group.offsets) expect(group.world.WarpInFormation(id, { leader: 'fc', offset })).toBe(true);
  }

  it("warps members to their slots around the leader's landing at their own warp speeds, and they follow once the group has landed", () => {
    const group = MakeGroup();
    const { harness, world, offsets } = group;
    const ids = ['fc', ...offsets.keys()];
    WarpTogether(group);
    expect(RequireMotion(world, 'm0').formationWarp).toEqual({ leader: 'fc', pending: true });
    RunTicks(harness, 1);
    for (const id of ids) expect(RequireMotion(world, id).mode, id).toBe('warp');
    ExpectLockstep(world, 3);
    expect(ids.map((id) => RequireMotion(world, id).warp?.warpSpeed)).toEqual([3, 5, 4]);
    expect(RequireMotion(world, 'm0').formationWarp).toEqual({ leader: 'fc', pending: false });
    const frame = WarpFrame([0, 0, 0], AWAY);
    const slots = new Map([...offsets].map(([id, offset]) => [id, FramePoint({ origin: AWAY, frame, offset })]));
    for (const [id, slot] of slots) expect(Gap(RequireMotion(world, id).warp!.landing, slot), id).toBeLessThanOrEqual(1);

    let rifterLanding: Maybe<SceneVector> = null;
    let heldTicks = 0;
    RunUntil(
      harness,
      () => ids.every((id) => Landed(world, id)),
      120,
      () => {
        ExpectLockstep(world, 3);
        const m0 = RequireMotion(world, 'm0');
        if (!rifterLanding && m0.warp?.phase === 'landed') rifterLanding = m0.position;
        if (rifterLanding && !Landed(world, 'fc')) {
          heldTicks++;
          expect(m0.mode).toBe('stop');
          expect(m0.formationWarp).toEqual({ leader: 'fc', pending: false });
          expect(Gap(m0.position, rifterLanding)).toBeLessThan(1000);
        }
      }
    );
    expect(heldTicks).toBeGreaterThan(3);
    for (const [id, slot] of slots) expect(Gap(RequireMotion(world, id).warp!.landing, slot), id).toBeLessThanOrEqual(1);

    RunTicks(harness, 2);
    for (const id of offsets.keys()) {
      const motion = RequireMotion(world, id);
      expect(motion.order, id).toEqual({ type: 'keep-at-range', target: 'fc', range: 1000, speed: 1 });
      expect(motion.warp).toBeUndefined();
      expect(motion.formationWarp).toBeUndefined();
    }
    RunUntil(
      harness,
      () => [...offsets.keys()].every((id) => (RequireMotion(world, id).slotError ?? Infinity) <= toFollowTolerance({ slotRange: 1000, anchorSpeed: RequireMotion(world, 'fc').speed })),
      30,
      () => ExpectLockstep(world, 3)
    );
    for (let ball = FIRST_SHIP_BALL_ID; ball < FIRST_SHIP_BALL_ID + 3; ball++) {
      expect(world.master.GetBall(ball)?.isMassive).toBe(false);
      expect(world.replica.GetBall(ball)?.isMassive).toBe(false);
    }
  });

  it('drops a formation warp whose slot is under 150 km away or whose leader does not warp, and the ship keeps following', () => {
    const near = MakeGroup();
    expect(near.world.WarpInFormation('m0', { leader: 'fc', offset: near.offsets.get('m0')! })).toBe(true);
    RunTicks(near.harness, 1);
    const dropped = RequireMotion(near.world, 'm0');
    expect(dropped.orderNote).toMatch(/^dropped: its formation warp \(ship "m0" would land 0 km away; EVE warps only 150 km or more/u);
    expect(dropped.formationWarp).toBeUndefined();
    expect(dropped.mode).not.toBe('warp');
    expect(near.world.Following('m0')).not.toBeNull();

    const refused = MakeGroup();
    refused.world.AddShip(Ship('t', [0, 0, 500_000]), tfi);
    expect(refused.world.Order('fc', { type: 'warp', target: 't', range: 0 })).toBe(true);
    for (const [id, offset] of refused.offsets) expect(refused.world.WarpInFormation(id, { leader: 'fc', offset })).toBe(true);
    refused.world.RemoveShip('t');
    RunTicks(refused.harness, 1);
    expect(RequireMotion(refused.world, 'fc').orderNote).toBe('stopped: target "t" was removed');
    for (const id of refused.offsets.keys()) {
      const motion = RequireMotion(refused.world, id);
      expect(motion.orderNote, id).toMatch(/^dropped: its formation warp/u);
      expect(motion.mode, id).not.toBe('warp');
      expect(refused.world.Following(id)).not.toBeNull();
    }
    ExpectLockstep(refused.world, 4);
  });

  it('keeps a formation warp through a re-plan and ends it on an explicit order or a placement', () => {
    const group = MakeGroup();
    const { harness, world } = group;
    WarpTogether(group);
    RunTicks(harness, 1);
    expect(RequireMotion(world, 'm0').warp?.phase).toBe('aligning');
    expect(world.Follow('m1', FollowOf(MEMBERS[1].direction))).toBe(true);
    expect(world.Order('m0', { type: 'stop' })).toBe(true);
    expect(world.FormationWarpOf('m0')).toBeNull();
    expect(world.Following('m0')).toBeNull();
    RunTicks(harness, 1);
    expect(RequireMotion(world, 'm0')).toMatchObject({ mode: 'stop', order: { type: 'stop' } });
    expect(RequireMotion(world, 'm1')).toMatchObject({ mode: 'warp', formationWarp: { leader: 'fc', pending: false } });

    world.PlaceShip(Ship('m1', [5000, 0, 0]));
    expect(world.FormationWarpOf('m1')).toBeNull();
    RunTicks(harness, 2);
    expect(RequireMotion(world, 'm1')).toMatchObject({ mode: 'goto', order: { type: 'keep-at-range', target: 'fc' } });
    expect(RequireMotion(world, 'm1').warp).toBeUndefined();
    ExpectLockstep(world, 3);
  });

  it("warps to its slot in its leader's heading frame when the leader is not warping", () => {
    const { harness, world, offsets } = MakeGroup();
    const offset = offsets.get('m0')!;
    world.PlaceShip(Ship('m0', [0, 0, -300_000]));
    expect(world.WarpInFormation('m0', { leader: 'fc', offset })).toBe(true);
    RunTicks(harness, 1);
    const slot = FramePoint({ origin: RequireMotion(world, 'fc').position, frame: FleetFrame(0, 0), offset });
    expect(RequireMotion(world, 'm0').mode).toBe('warp');
    expect(Gap(RequireMotion(world, 'm0').warp!.landing, slot)).toBeLessThanOrEqual(1);
    RunUntil(harness, () => Landed(world, 'm0'), 60);
    const settled = (): boolean => {
      const motion = RequireMotion(world, 'm0');
      return motion.order.type === 'keep-at-range' && motion.mode === 'stop' && (motion.slotError ?? Infinity) <= toFollowTolerance({ slotRange: 1000, anchorSpeed: 0 });
    };
    RunUntil(harness, settled, 60);
    expect(RequireMotion(world, 'm0').warp).toBeUndefined();
    ExpectLockstep(world, 3);
  });

  it("applies a delayed order that many ticks late, and a delayed formation warp after its own delay and its leader's order", () => {
    const { harness, world, offsets } = MakeGroup();
    expect(world.Order('fc', { type: 'warp', point: AWAY, range: 0 }, { delay: 3 })).toBe(true);
    expect(world.WarpInFormation('m0', { leader: 'fc', offset: offsets.get('m0')!, delay: 1 })).toBe(true);
    expect(world.WarpInFormation('m1', { leader: 'fc', offset: offsets.get('m1')!, delay: 5 })).toBe(true);
    expect(world.FormationWarpOf('m1')?.delay).toBe(5);
    RunTicks(harness, 1);
    expect(RequireMotion(world, 'fc')).toMatchObject({ mode: 'stop', respondsIn: 2, pendingOrder: { type: 'warp' } });
    expect(RequireMotion(world, 'm0').formationWarp).toEqual({ leader: 'fc', pending: true });
    RunTicks(harness, 3);
    expect(RequireMotion(world, 'fc').mode).toBe('warp');
    expect(RequireMotion(world, 'fc').respondsIn).toBeUndefined();
    expect(RequireMotion(world, 'm0')).toMatchObject({ mode: 'warp', formationWarp: { leader: 'fc', pending: false } });
    expect(RequireMotion(world, 'm1')).toMatchObject({ formationWarp: { leader: 'fc', pending: true, respondsIn: 1 } });
    RunTicks(harness, 2);
    expect(RequireMotion(world, 'm1')).toMatchObject({ mode: 'warp', formationWarp: { pending: false } });
    RunUntil(
      harness,
      () => ['fc', 'm0', 'm1'].every((id) => Landed(world, id)),
      120,
      () => ExpectLockstep(world, 3)
    );
    RunTicks(harness, 2);
    for (const id of offsets.keys()) expect(RequireMotion(world, id).order.type, id).toBe('keep-at-range');
  });

  it('refuses WarpInFormation for a ship that does not follow, a self or unknown leader, or a ship in warp', () => {
    const group = MakeGroup();
    const { harness, world, offsets } = group;
    expect(world.WarpInFormation('fc', { leader: 'm0', offset: [0, 0, 0] })).toBe(false);
    expect(world.WarpInFormation('m0', { leader: 'm0', offset: [0, 0, 0] })).toBe(false);
    expect(world.WarpInFormation('m0', { leader: 'nobody', offset: [0, 0, 0] })).toBe(false);
    expect(world.WarpInFormation('nobody', { leader: 'fc', offset: [0, 0, 0] })).toBe(false);
    WarpTogether(group);
    RunUntil(harness, () => ['warping', 'exiting'].includes(RequireMotion(world, 'm0').warp?.phase ?? ''), 20);
    expect(world.WarpInFormation('m0', { leader: 'fc', offset: offsets.get('m0')! })).toBe(false);
  });
});

describe('DestinyWorld objects', () => {
  function WithObject(radius = 20000, position: SceneVector = [0, 0, 30000 + 20000 + 31]): Harness {
    const harness = new Harness();
    harness.world.AddShip(Ship('rifter', [0, 0, 0]), Fly(RIFTER));
    harness.world.AddObject({ id: 'astra', position }, radius);
    harness.Run(1);
    return harness;
  }

  it('adds a static, non-free ball on both parks from the ship counter, in lockstep', () => {
    const { world } = WithObject();
    const master = world.master.GetBall(FIRST_SHIP_BALL_ID + 1);
    expect(master).toMatchObject({ radius: 20000, maxVelocity: 0, isFree: false });
    expect(world.replica.GetBall(FIRST_SHIP_BALL_ID + 1)?.radius).toBe(20000);
    expect(world.ObjectBall('astra')).toEqual({ position: [0, 0, 50031], radius: 20000 });
    expect(world.HasObject('astra') && world.ObjectIds()).toEqual(['astra']);
    world.AddShip(Ship('other', [0, 0, -5000]), Fly(RIFTER));
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID + 2)).not.toBeNull();
    ExpectLockstep(world, 3);
  });

  it('is approached, kept at range on and orbited, surface to surface', () => {
    const harness = WithObject();
    const { world } = harness;
    expect(world.Order('rifter', { type: 'approach', target: 'astra', speed: 1 })).toBe(true);
    harness.Run(240);
    expect(RequireMotion(world, 'rifter')).toMatchObject({ mode: 'follow' });
    expect(RequireMotion(world, 'rifter').targetDistance).toBeLessThanOrEqual(150);
    world.Order('rifter', { type: 'keep-at-range', target: 'astra', range: 10000, speed: 1 });
    harness.Run(120);
    expect(Math.abs((RequireMotion(world, 'rifter').targetDistance ?? 0) - 10000)).toBeLessThanOrEqual(toFollowTolerance({ slotRange: 10000, anchorSpeed: 0 }));
    world.Order('rifter', { type: 'orbit', target: 'astra', range: 5000, speed: 1 });
    harness.Run(240);
    const orbit = RequireMotion(world, 'rifter');
    expect(orbit.mode).toBe('orbit');
    expect(orbit.targetDistance).toBeGreaterThanOrEqual(4500);
    expect(orbit.targetDistance).toBeLessThanOrEqual(6500);
    ExpectLockstep(world, 2);
  });

  it('is a warp target, landing about the radii short', () => {
    const harness = WithObject(20000, [0, 0, 1_000_000]);
    const { world } = harness;
    expect(world.Order('rifter', { type: 'warp', target: 'astra', range: 0 })).toBe(true);
    harness.Run(120);
    const motion = RequireMotion(world, 'rifter');
    const astra = world.ObjectBall('astra');
    expect(motion.warp?.phase).toBe('landed');
    expect(astra).not.toBeNull();
    const centres = Math.hypot(...motion.position.map((value, axis) => value - (astra?.position[axis] ?? 0)));
    expect(Math.abs(centres - 31 - 20000)).toBeLessThan(2000);
  });

  it('halts an orbiter and drops a pending approach when removed', () => {
    const harness = WithObject();
    const { world } = harness;
    world.AddShip(Ship('second', [0, 0, -2000]), Fly(RIFTER));
    world.Order('rifter', { type: 'orbit', target: 'astra', range: 5000, speed: 1 });
    harness.Run(5);
    world.Order('second', { type: 'approach', target: 'astra', speed: 1 });
    expect(world.RemoveObject('astra')).toEqual(['rifter', 'second']);
    const motion = RequireMotion(world, 'rifter');
    expect(motion.orderNote).toBe('stopped: target "astra" was removed');
    expect(motion.pendingOrder ?? motion.order).toEqual({ type: 'stop' });
    expect(world.HasObject('astra')).toBe(false);
    expect(world.master.GetBall(FIRST_SHIP_BALL_ID + 1)).toBeNull();
    expect(world.RemoveObject('astra')).toEqual([]);
  });

  it('is chased when moved, and resized on both parks', () => {
    const harness = WithObject();
    const { world } = harness;
    world.Order('rifter', { type: 'approach', target: 'astra', speed: 1 });
    harness.Run(3);
    const before = RequireMotion(world, 'rifter').targetDistance ?? 0;
    world.SetObjectRadius('astra', 25000);
    harness.Run(1);
    expect((RequireMotion(world, 'rifter').targetDistance ?? 0) - before).toBeLessThan(-4000);
    world.PlaceObject({ id: 'astra', position: [100000, 0, 0] });
    harness.Run(60);
    const motion = RequireMotion(world, 'rifter');
    expect(motion.position[0]).toBeGreaterThan(1000);
    expect(world.replica.GetBall(FIRST_SHIP_BALL_ID + 1)?.radius).toBe(25000);
    ExpectLockstep(world, 2);
  });

  it('refuses a target in another bubble, keeping the parks identical', () => {
    const harness = WithObject(20000, [0, 0, 20_000_000]);
    const { world } = harness;
    expect(world.OrderRefusal('rifter', { type: 'approach', target: 'astra', speed: 1 })).toBe('target "astra" is 20,000 km away, in another Destiny bubble; warp to it first');
    expect(world.Order('rifter', { type: 'orbit', target: 'astra', range: 5000, speed: 1 })).toBe(false);
    harness.Run(3);
    ExpectLockstep(world, 2);
  });

  it('refuses a ship id and a radius of 0', () => {
    const { world } = WithObject();
    expect(() => world.AddObject({ id: 'rifter', position: [0, 0, 0] }, 1000)).toThrow(/a ship holds that id/u);
    expect(() => world.AddObject({ id: 'other', position: [0, 0, 0] }, 0)).toThrow(/radius must be/u);
  });
});
