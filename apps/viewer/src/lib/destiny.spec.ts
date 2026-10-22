import { createRequire } from 'node:module';
import type { SceneShip, SceneVector, ShipOrder } from '@scene-director/scene';
import { describe, expect, it, vi } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { AttachShipCurves, DEFAULT_SHIP_PHYSICS, DestinyWorld, DocumentRotation, FIRST_SHIP_BALL_ID, ModeName, REFERENCE_BALL_ID, type CurveHost, type ShipMotion } from './destiny';
import { ResolveFlight, type PublishedHull, type ShipFlight } from './flight';
import { CjsDestinyBall, CjsDestinyClientBall, quat, vec3, type Quat, type Vec3 } from './runtime-sim';

const FRAME_TICKS = Math.round(TICKS_PER_SECOND / 60);
const FRIGATE = { mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 30 };

// Published values (EVE typeDogma via ESI, 2026-10-21), the Ship-stats spec fixtures.
const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31 } };
const GUARDIAN: PublishedHull = { typeID: 11987, name: 'Guardian', published: { mass: 11_980_000, maxVelocity: 209, agility: 0.61, signatureRadius: 70, radius: 80 } };
const TFI: PublishedHull = { typeID: 17732, name: 'Tempest Fleet Issue', published: { mass: 103_300_000, maxVelocity: 130, agility: 0.115, signatureRadius: 350, radius: 250 } };

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
  const state = (ball: CjsDestinyBall | null): number[] => (ball ? [ball.x, ball.y, ball.z, ball.vx, ball.vy, ball.vz, ball.mode] : []);
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
