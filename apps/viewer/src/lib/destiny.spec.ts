import { createRequire } from 'node:module';
import type { SceneShip, SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import { AttachShipCurves, DEFAULT_SHIP_PHYSICS, DestinyWorld, DocumentRotation, FIRST_SHIP_BALL_ID, ModeName, REFERENCE_BALL_ID, ShipPhysicsFromHull, type CurveHost } from './destiny';
import { CjsDestinyBall, CjsDestinyClientBall, quat, vec3, type Quat, type Vec3 } from './runtime-sim';

const FRAME_TICKS = Math.round(TICKS_PER_SECOND / 60);
const FRIGATE = { mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 30 };

type Placement = Pick<SceneShip, 'id' | 'position' | 'rotation'>;

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

describe('ShipPhysicsFromHull', () => {
  it('picks class defaults by SOF category, with the hull radius', () => {
    expect(ShipPhysicsFromHull({ category: 'Frigate', radius: 27.9 })).toEqual({ mass: 1.2e6, agility: 3.2, maxVelocity: 350, radius: 27.9 });
    expect(ShipPhysicsFromHull({ category: 'force auxiliary', radius: 2000 })).toMatchObject({ mass: 1.1e9, radius: 2000 });
  });

  it('falls back to radius bands for an unknown category', () => {
    expect(ShipPhysicsFromHull({ category: 'mystery', radius: 726 })).toEqual({ mass: 1e8, agility: 0.12, maxVelocity: 110, radius: 726 });
    expect(ShipPhysicsFromHull({ category: null, radius: 49 })).toMatchObject({ mass: 1.2e6, radius: 49 });
    expect(ShipPhysicsFromHull({ category: null, radius: 20000 })).toMatchObject({ mass: 2.4e9 });
  });

  it('uses cruiser defaults when the hull is unknown', () => {
    expect(ShipPhysicsFromHull(null)).toEqual(DEFAULT_SHIP_PHYSICS);
    expect(ShipPhysicsFromHull({ category: null, radius: null })).toEqual(DEFAULT_SHIP_PHYSICS);
  });

  it("applies the document's stat overrides", () => {
    expect(ShipPhysicsFromHull({ category: 'frigate', radius: 30 }, { mass: 5e6, maxVelocity: 420 })).toEqual({ mass: 5e6, agility: 3.2, maxVelocity: 420, radius: 30 });
    expect(ShipPhysicsFromHull(null, { agility: 0 })).toEqual(DEFAULT_SHIP_PHYSICS);
  });
});
