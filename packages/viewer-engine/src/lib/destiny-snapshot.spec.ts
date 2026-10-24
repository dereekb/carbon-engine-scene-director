import type { SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { TICKS_PER_MS } from './clock';
import type { DestinyWorld, MissileLaunch, MissilePhysics, WarpPhase } from './destiny';
import { CaptureScalars, CapturePark, ParkSnapshotBytes, RestorePark, WARMUP_SAMPLES_PER_TICK, WARMUP_TICKS } from './destiny-snapshot';
import { Fly, Harness, RIFTER, Ship, TFI } from './destiny.spec-helper';
import { ResolveFlight } from './flight';
import { ResolveShipPropMod } from './prop-mods';
import { CjsBallparkController, type Quat } from './runtime-sim';
import { EstimateBytes } from './state-capture';

const rifter = Fly(RIFTER);
const mwdRifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 1, answer: null }) });
const tfi = Fly(TFI);
const HEAVY: MissilePhysics = { mass: 1000, agility: 0.0001, maxVelocity: 9675, radius: 300 };
const AUDIT_TICKS = 30;

/**
 * Ball fields the audit cannot compare by value: object references (compared through ids below) and the bubble ids
 * (compared as equality classes).
 */
const AUDIT_BALL_SKIP: ReadonlySet<string> = new Set(['mPark', 'mFollowPtr', 'mFollowers', 'mMiniBalls', 'mMiniCapsules', 'mMiniBoxes', 'mSensor', 'mCollisions', 'mTrackingPtr', 'mBoxes', 'mMyBox', 'mNewBubble', 'mOldBubble']);
const AUDIT_PARK_SKIP: ReadonlySet<string> = new Set(['mBubbleId']);

function ById(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Everything a park holds that the simulation can read: every scalar of the park and of every ball (the structural
 * partition fields included), the ball order, follow links, bubble classes, the free registry and every registry's
 * size.
 */
function DumpPark(park: CjsBallparkController): unknown {
  const fields = park as unknown as Record<string, unknown>;
  const classes = new Map<unknown, number>();
  const classOf = (bubble: unknown): number => {
    if (!classes.has(bubble)) classes.set(bubble, classes.size);
    return classes.get(bubble) as number;
  };
  const balls = [...park.balls.values()].map((ball) => {
    const b = ball as unknown as Record<string, unknown>;
    return {
      scalars: CaptureScalars(ball, AUDIT_BALL_SKIP),
      follow: (b['mFollowPtr'] as Maybe<{ readonly mId: bigint }>)?.mId ?? null,
      followers: [...(b['mFollowers'] as Set<bigint>)].sort(ById),
      bubble: classOf(b['mNewBubble']),
      oldBubble: classOf(b['mOldBubble']),
      boxes: (b['mBoxes'] as unknown[]).length,
      collisions: (b['mCollisions'] as unknown[]).length
    };
  });
  const sizes: Record<string, number> = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value instanceof Map || value instanceof Set) sizes[key] = value.size;
  }
  return { park: CaptureScalars(park, AUDIT_PARK_SKIP), ids: [...park.balls.keys()], balls, free: [...(fields['mFreeBalls'] as Map<bigint, unknown>).keys()], sizes };
}

type Maybe<T> = T | null;

/**
 * The world's full state at a tick: both parks, its own fields and entries, and the drawn curves sampled now.
 */
function Dump(harness: Harness): unknown {
  const { world } = harness;
  const { fields, ships } = world.Snapshot();
  const drawn = ships.map(({ entry }) => {
    const curves = world.Curves(entry.id);
    return curves ? [entry.id, [...curves.translation.GetValueAt__Ticks(harness.now, new Float32Array(3))], [...curves.rotation.value]] : [entry.id];
  });
  return { tick: world.tick, now: harness.now, master: DumpPark(world.master), replica: DumpPark(world.replica), fields, ships, drawn };
}

function Lockstep(world: DestinyWorld): void {
  const rows = (park: CjsBallparkController): unknown[] => [...park.balls.values()].map((b) => [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.mode, b.mNewYaw, b.mNewPitch, b.mass, b.maxVelocity, b.agility, b.effectStamp]);
  expect(rows(world.replica)).toEqual(rows(world.master));
}

interface Scenario {
  /**
   * Adds the ships, objects and their first orders.
   */
  readonly setup: (harness: Harness) => void;
  /**
   * Runs the world to the snapshot, giving commands between ticks.
   */
  readonly prepare: (harness: Harness) => void;
  /**
   * Commands at boundaries, on both runs (the tape's stand-in).
   */
  readonly script?: (world: DestinyWorld, boundary: number) => void;
  /**
   * Checks the state at the snapshot is the one the scenario is about.
   */
  readonly check?: (world: DestinyWorld) => void;
  /**
   * Ships whose curves are not sampled every frame (the script removes them).
   */
  readonly untracked?: readonly string[];
}

/**
 * Runs a scenario, snapshots it, records AUDIT_TICKS ticks of full dumps, restores the snapshot into the same world,
 * re-runs, and requires every tick's dump to be equal. Every ship's curves are sampled every frame on both runs.
 */
function Audit(scenario: Scenario): void {
  const harness = new Harness();
  const { world } = harness;
  world.SetSceneEpoch(0);
  scenario.setup(harness);
  world.OnBeforeBoundary((boundary) => scenario.script?.(world, boundary));
  for (const { entry } of world.Snapshot().ships) if (!scenario.untracked?.includes(entry.id)) harness.Sample(entry.id);
  scenario.prepare(harness);
  scenario.check?.(world);
  const snapshot = world.Snapshot();
  const now = harness.now;
  const first: unknown[] = [Dump(harness)];
  harness.Ticks(AUDIT_TICKS, () => first.push(Dump(harness)));
  const curves = world.Curves(snapshot.ships[0].entry.id);
  world.Restore(snapshot);
  harness.now = now;
  expect(world.Curves(snapshot.ships[0].entry.id)).not.toBe(curves);
  Lockstep(world);
  const second: unknown[] = [Dump(harness)];
  harness.Ticks(AUDIT_TICKS, () => second.push(Dump(harness)));
  Lockstep(world);
  expect(second.length).toBe(first.length);
  for (let i = 0; i < first.length; i++) expect(second[i], `tick ${i} after the snapshot`).toEqual(first[i]);
}

function WarpPhaseOf(world: DestinyWorld, id: string): Maybe<WarpPhase> {
  return world.Motion(id)?.warp?.phase ?? null;
}

/**
 * The first tick a single Rifter's warp shows each phase, from a dry run.
 */
function WarpPhaseTicks(): Map<WarpPhase, number> {
  const harness = new Harness();
  harness.world.AddShip(Ship('w', [0, 0, 0]), rifter);
  harness.Ticks(2);
  harness.world.Order('w', { type: 'warp', point: [0, 0, 1_500_000], range: 0 });
  const ticks = new Map<WarpPhase, number>();
  harness.Until(
    () => ticks.has('landed'),
    400,
    () => {
      const phase = WarpPhaseOf(harness.world, 'w');
      if (phase && !ticks.has(phase)) ticks.set(phase, harness.world.tick);
    }
  );
  return ticks;
}

describe('Destiny snapshots: the audit', () => {
  it('(a) a fleet behind a turning FC, and followers settled at rest', () => {
    Audit({
      setup: ({ world }) => {
        world.AddShip(Ship('fc', [0, 0, 0]), tfi);
        world.AddShip(Ship('m0', [0, 0, -1281]), rifter);
        world.AddShip(Ship('m1', [1500, 0, -800]), rifter);
        world.AddShip(Ship('rest', [0, 0, 30_000]), tfi);
        world.AddShip(Ship('r0', [0, 0, 30_000 - 1281]), rifter);
        world.Follow('m0', { anchor: 'fc', range: 1000, frame: 'fc', direction: [0, 0, -1], slotRange: 1000, speed: 1 });
        world.Follow('m1', { anchor: 'fc', range: 1000, frame: 'fc', direction: [1, 0, 0], slotRange: 1000, speed: 1 });
        world.Follow('r0', { anchor: 'rest', range: 1000, frame: 'rest', direction: [0, 0, -1], slotRange: 1000, speed: 1 });
      },
      prepare: (harness) => {
        harness.Ticks(3);
        harness.world.Order('fc', { type: 'direction', direction: [1, 0, 0.2], speed: 1 });
        harness.Ticks(12);
      },
      script: (world, boundary) => {
        if (boundary === 22) world.Order('fc', { type: 'direction', direction: [-1, 0.3, 0], speed: 1 });
      },
      check: (world) => expect(world.Motion('r0')?.mode).toBe('stop')
    });
  });

  it('(b) orbit, keep-at-range, approach, and a goto creeping in', () => {
    Audit({
      setup: ({ world }) => {
        world.AddShip(Ship('c', [0, 0, 0]), tfi);
        world.AddShip(Ship('o', [3000, 0, 0]), rifter);
        world.AddShip(Ship('k', [-6000, 0, 0]), rifter);
        world.AddShip(Ship('p', [0, 0, 12_000]), rifter);
        world.AddShip(Ship('g', [0, 5000, 0]), rifter);
        world.Order('o', { type: 'orbit', target: 'c', range: 2500, speed: 1 });
        world.Order('k', { type: 'keep-at-range', target: 'c', range: 5000, speed: 1 });
        world.Order('p', { type: 'approach', target: 'c', speed: 1 });
        world.Order('g', { type: 'goto', point: [0, 5600, 0], speed: 1 });
        world.Order('c', { type: 'direction', direction: [0, 0, 1], speed: 0.3 });
      },
      prepare: (harness) => harness.Ticks(10)
    });
  });

  for (const phase of ['aligning', 'warping', 'exiting', 'landed'] as const) {
    it(`(c) a warp ${phase}`, () => {
      const at = WarpPhaseTicks().get(phase);
      expect(at, `a dry run reaches ${phase}`).toBeDefined();
      Audit({
        setup: ({ world }) => {
          world.AddShip(Ship('w', [0, 0, 0]), rifter);
          world.AddShip(Ship('x', [2000, 0, 0]), rifter);
        },
        prepare: (harness) => {
          harness.Ticks(2);
          harness.world.Order('w', { type: 'warp', point: [0, 0, 1_500_000], range: 0 });
          harness.Until(() => harness.world.tick >= (at as number), 400);
        },
        check: (world) => expect(WarpPhaseOf(world, 'w')).toBe(phase)
      });
    });
  }

  it('(d) arrivals parked, scheduled and warping', () => {
    const from = (x: number): SceneVector => [x, 0, -2_000_000];
    Audit({
      setup: ({ world }) => {
        world.AddShip(Ship('anchor', [0, 0, 5000]), tfi);
        for (const id of ['parked', 'scheduled', 'warping']) world.AddShip(Ship(id, [0, 0, 1000]), rifter);
      },
      prepare: (harness) => {
        const { world } = harness;
        harness.Ticks(2);
        expect(world.Arrive('parked', { from: from(0), landing: [0, 0, 0], at: null })).toBe(true);
        expect(world.Arrive('scheduled', { from: from(3000), landing: [3000, 0, 0], at: world.tick + 12 })).toBe(true);
        expect(world.Arrive('warping', { from: from(-3000), landing: [-3000, 0, 0], at: world.tick + 2, leader: 'anchor', roll: 10 })).toBe(true);
        harness.Ticks(5);
      },
      check: (world) => expect(['parked', 'scheduled', 'warping'].map((id) => world.ArrivalOf(id)?.state)).toEqual(['parked', 'scheduled', 'warping'])
    });
  });

  it('(e) missiles flying, lost, and done and lingering', () => {
    const launch = (world: DestinyWorld, id: string, target: string, flight: number): MissileLaunch => ({ id, owner: 'a', target, physics: HEAVY, launchedAt: world.tick, expiresAt: world.tick + flight });
    Audit({
      setup: ({ world }) => {
        world.AddShip(Ship('a', [0, 0, 0]), rifter);
        world.AddShip(Ship('far', [0, 0, 150_000]), rifter);
        world.AddShip(Ship('near', [0, 0, 15_000]), rifter);
        world.AddShip(Ship('lost', [20_000, 0, 60_000]), rifter);
        world.Order('far', { type: 'direction', direction: [1, 0, 0], speed: 1 });
      },
      prepare: (harness) => {
        const { world } = harness;
        harness.Ticks(2);
        expect(world.LaunchMissile(launch(world, 'm-far', 'far', 25))).toBeNull();
        expect(world.LaunchMissile(launch(world, 'm-near', 'near', 25))).toBeNull();
        expect(world.LaunchMissile(launch(world, 'm-lost', 'lost', 25))).toBeNull();
        harness.Ticks(2);
        expect(world.LoseMissileTargets('lost', 'the target left')).toEqual(['m-lost']);
        harness.Until(() => world.Missile('m-near')?.state === 'done', 20);
      },
      script: (world, boundary) => {
        if (boundary === 12) world.LaunchMissile(launch(world, 'm-late', 'near', 10));
      },
      check: (world) => expect(['m-far', 'm-near', 'm-lost'].map((id) => world.Missile(id)?.state)).toEqual(['flying', 'done', 'lost'])
    });
  });

  it('(f) prop mods activating, active, stopping and queued', () => {
    Audit({
      setup: ({ world }) => {
        for (const [i, id] of ['activating', 'active', 'stopping', 'queued'].entries()) {
          world.AddShip(Ship(id, [i * 3000, 0, 0]), mwdRifter);
          world.Order(id, { type: 'direction', direction: [0, 0, 1], speed: 1 });
        }
      },
      prepare: (harness) => {
        const { world } = harness;
        harness.Ticks(2);
        world.SwitchPropMod('active', true);
        world.SwitchPropMod('stopping', true);
        harness.Ticks(4);
        world.SwitchPropMod('stopping', false);
        world.SwitchPropMod('queued', true, { delay: 4 });
        world.SwitchPropMod('activating', true);
      },
      script: (world, boundary) => {
        if (boundary === 15) world.SwitchPropMod('active', false);
      },
      check: (world) => {
        expect(['activating', 'active', 'stopping'].map((id) => world.Motion(id)?.propMod.state)).toEqual(['activating', 'active', 'stopping']);
        expect(world.Motion('queued')?.propMod.queued).toBeDefined();
      }
    });
  });

  it('(g) a destroyed ship lingering, and a ship removed after the snapshot (the restore brings it back)', () => {
    Audit({
      setup: ({ world }) => {
        world.AddShip(Ship('a', [0, 0, 0]), rifter);
        world.AddShip(Ship('dead', [3000, 0, 0]), rifter);
        world.AddShip(Ship('gone', [-3000, 0, 0]), rifter);
        world.AddShip(Ship('orbiter', [0, 0, 4000]), rifter);
        world.Order('dead', { type: 'direction', direction: [0, 0, 1], speed: 1 });
        world.Order('orbiter', { type: 'orbit', target: 'gone', range: 2000, speed: 1 });
      },
      prepare: (harness) => {
        harness.Ticks(4);
        expect(harness.world.Destroy('dead')).toEqual([]);
        harness.Ticks(2);
      },
      script: (world, boundary) => {
        if (boundary === 10) world.RemoveShip('gone');
        if (boundary === 14) world.RemoveShip('dead');
      },
      check: (world) => expect(world.IsDestroyed('dead')).toBe(true),
      untracked: ['dead', 'gone']
    });
  });

  it('(h) objects, with a ship orbiting one', () => {
    Audit({
      setup: ({ world }) => {
        world.AddObject({ id: 'astra', position: [0, 0, 20_000] }, 5000);
        world.AddObject({ id: 'gate', position: [40_000, 0, 0] }, 2500);
        world.AddShip(Ship('o', [0, 0, 10_000]), rifter);
        world.AddShip(Ship('p', [0, 0, -5000]), rifter);
        world.Order('o', { type: 'orbit', target: 'astra', range: 3000, speed: 1 });
        world.Order('p', { type: 'approach', target: 'gate', speed: 1 });
      },
      prepare: (harness) => harness.Ticks(8),
      script: (world, boundary) => {
        if (boundary === 16) world.SetObjectRadius('gate', 3000);
      }
    });
  });
});

describe('Destiny snapshots: determinism', () => {
  it('a world with steering, orders, warps and missiles replays from a snapshot identical to its first run', () => {
    const harness = new Harness();
    const { world } = harness;
    world.SetSceneEpoch(0);
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    world.AddShip(Ship('m0', [0, 0, -1281]), rifter);
    world.AddShip(Ship('mwd', [5000, 0, 0]), mwdRifter);
    world.AddShip(Ship('warper', [0, 5000, 0]), rifter);
    world.AddShip(Ship('shooter', [-5000, 0, 0]), rifter);
    world.Follow('m0', { anchor: 'fc', range: 1000, frame: 'fc', direction: [0, 0, -1], slotRange: 1000, speed: 1 });
    world.OnBeforeBoundary((boundary) => {
      if (boundary === 2) world.Order('fc', { type: 'direction', direction: [1, 0, 0.2], speed: 1 });
      if (boundary === 4) world.SwitchPropMod('mwd', true);
      if (boundary === 6) world.Order('warper', { type: 'warp', point: [0, 5000, 800_000], range: 0 });
      if (boundary === 8 || boundary === 20) world.LaunchMissile({ id: `m${boundary}`, owner: 'shooter', target: 'mwd', physics: HEAVY, launchedAt: boundary, expiresAt: boundary + 30 });
      if (boundary === 14) world.Order('fc', { type: 'direction', direction: [-1, 0.3, 0], speed: 1 });
      if (boundary === 18) world.Order('shooter', { type: 'orbit', target: 'fc', range: 3000, speed: 1 }, { delay: 3 });
    });
    const report = (): unknown => [world.tick, ['fc', 'm0', 'mwd', 'warper', 'shooter'].map((id) => world.Motion(id)), world.MissileIds().map((id) => world.Missile(id))];
    harness.Ticks(10);
    const snapshot = world.Snapshot();
    const now = harness.now;
    const first: unknown[] = [];
    harness.Ticks(40, () => first.push(report()));
    world.Restore(snapshot);
    harness.now = now;
    const second: unknown[] = [];
    harness.Ticks(40, () => second.push(report()));
    expect(second).toEqual(first);
  });
});

describe('Destiny snapshots: the ClientBall warm-up', () => {
  /**
   * A turning FC's drawn rotation, as [yaw, pitch, roll] degrees.
   */
  function Angles(rotation: Quat): number[] {
    const q = rotation;
    const yaw = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[0] * q[0]));
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q[3] * q[0] - q[2] * q[1]))));
    const roll = Math.atan2(2 * (q[3] * q[2] + q[0] * q[1]), 1 - 2 * (q[0] * q[0] + q[2] * q[2]));
    return [yaw, pitch, roll].map((r) => (r * 180) / Math.PI);
  }

  function AngleGap(a: readonly number[], b: readonly number[]): number {
    return Math.max(...a.map((value, i) => Math.abs(((((value - b[i] + 540) % 360) + 360) % 360) - 180)));
  }

  /**
   * A jump from a snapshot `ahead` ticks back: re-simulated tick by tick on the boundaries without sampling, the last
   * `warm` ticks sampled WARMUP_SAMPLES_PER_TICK times each, then the frames from the target compared with the first
   * run's drawn rotation at the same times.
   */
  function Jump(warm: number, perTick = WARMUP_SAMPLES_PER_TICK): number {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('fc', [0, 0, 0]), rifter);
    world.OnBeforeBoundary((boundary) => {
      if (boundary === 3) world.Order('fc', { type: 'direction', direction: [1, 0, 0.3], speed: 1 });
      if (boundary === 16) world.Order('fc', { type: 'direction', direction: [-0.4, 0.5, -1], speed: 1 });
    });
    harness.Sample('fc');
    harness.Ticks(10);
    const snapshot = world.Snapshot();
    const tickTicks = world.master.tickInterval * TICKS_PER_MS;
    harness.Ticks(8);
    const target = harness.now;
    const drawn: { readonly now: number; readonly angles: number[] }[] = [];
    harness.Ticks(10, undefined, () => drawn.push({ now: harness.now, angles: Angles(harness.Sample('fc').rotation) }));
    world.Restore(snapshot);
    const boundaries: number[] = [];
    for (let time = Number(world.master.time) + tickTicks; time <= target; time += tickTicks) boundaries.push(time);
    for (const [i, boundary] of boundaries.entries()) {
      if (i >= boundaries.length - warm) {
        for (let sample = 1; sample <= perTick; sample++) world.SampleCurves(boundary - tickTicks + Math.round((sample * tickTicks) / perTick));
      }
      world.Tick(boundary);
    }
    world.Tick(target);
    harness.now = target;
    let gap = 0;
    harness.Ticks(10, undefined, () => {
      const angles = Angles(harness.Sample('fc').rotation);
      const twin = drawn.find((sample) => sample.now === harness.now);
      if (twin) gap = Math.max(gap, AngleGap(angles, twin.angles));
    });
    return gap;
  }

  it(`stays within 0.5° of the first run's drawn rotation after ${WARMUP_TICKS} warm ticks`, () => {
    expect(Jump(WARMUP_TICKS)).toBeLessThan(0.5);
    // The controls, documented rather than asserted: with no warm-up the drawn rotation swings from the snapshot's
    // cached one (48.6° here); at 4 samples a tick it is 3.6° off, since the ClientBall's damping is implicit Euler per
    // sample and the first run sampled at 60 fps.
    expect(Jump(0)).toBeGreaterThan(Jump(WARMUP_TICKS));
    expect(Jump(WARMUP_TICKS, 4)).toBeGreaterThan(Jump(WARMUP_TICKS));
  });
});

describe('Destiny snapshots: restore safety', () => {
  it('a failed park restore (truncated bytes) changes nothing', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    harness.Ticks(4);
    const snapshot = world.Snapshot();
    const broken = { ...snapshot, replica: { ...snapshot.replica, stream: snapshot.replica.stream.slice(0, snapshot.replica.stream.length - 9) } };
    const master = world.master;
    const curves = world.Curves('a');
    harness.Ticks(2);
    const before = Dump(harness);
    expect(() => world.Restore(broken)).toThrow();
    expect(world.master).toBe(master);
    expect(world.Curves('a')).toBe(curves);
    expect(Dump(harness)).toEqual(before);
  });

  it('RestorePark refuses a snapshot whose balls do not read back', () => {
    const park = new CjsBallparkController();
    park.AddBall(1, 1, 0, 0, false, false, false, false, false, 0, 0, 0, 0, 0, 0, 1, 0);
    const snapshot = CapturePark(park);
    expect(() => RestorePark({ ...snapshot, balls: [] }, false, () => new CjsBallparkController())).toThrow(/read back 1 balls for 0/);
    expect(RestorePark(snapshot, false, () => new CjsBallparkController()).balls.size).toBe(1);
  });
});

/**
 * The snapshot bench (sd-time "Measurements"): SD_BENCH=1 only. Fleets of N ships in a formation behind a turning FC,
 * a quarter orbiting and a quarter on goto orders, all sampled every frame; then capture, size, restore,
 * re-simulation per tick and the warm-up's sampling, each the median of a few runs.
 */
describe.runIf(process.env['SD_BENCH'] === '1')('Destiny snapshots: the bench', () => {
  function Median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function Bench(count: number): Record<string, number> {
    const harness = new Harness();
    const { world } = harness;
    world.SetSceneEpoch(0);
    world.AddShip(Ship('fc', [0, 0, 0]), tfi);
    const ids: string[] = [];
    for (let i = 0; i < count - 1; i++) {
      const id = `s${i}`;
      ids.push(id);
      const ring = 1 + Math.floor(i / 20);
      const angle = (i % 20) * ((2 * Math.PI) / 20);
      world.AddShip(Ship(id, [Math.cos(angle) * 1500 * ring, (i % 3) * 300, Math.sin(angle) * 1500 * ring]), i % 7 === 0 ? mwdRifter : rifter);
      if (i % 4 === 0) world.Order(id, { type: 'orbit', target: 'fc', range: 2000 + 100 * (i % 10), speed: 1 });
      else if (i % 4 === 1) world.Order(id, { type: 'goto', point: [i * 100, 0, 50_000], speed: 1 });
      else world.Follow(id, { anchor: 'fc', range: 1000 * ring, frame: 'fc', direction: [Math.cos(angle), 0, Math.sin(angle)], slotRange: 1000 * ring, speed: 1 });
    }
    world.Order('fc', { type: 'direction', direction: [1, 0, 0.3], speed: 0.5 });
    harness.Sample('fc');
    for (const id of ids) harness.Sample(id);
    harness.Ticks(5);
    const captures: number[] = [];
    let snapshot = world.Snapshot();
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      snapshot = world.Snapshot();
      captures.push(performance.now() - start);
    }
    const parkBytes = ParkSnapshotBytes(snapshot.master) + ParkSnapshotBytes(snapshot.replica);
    const bytes = parkBytes + EstimateBytes(snapshot.fields) + EstimateBytes(snapshot.ships);
    const now = harness.now;
    const restores: number[] = [];
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      world.Restore(snapshot);
      restores.push(performance.now() - start);
    }
    harness.now = now;
    const tickTicks = world.master.tickInterval * TICKS_PER_MS;
    const ticks: number[] = [];
    let time = Number(world.master.time);
    for (let tick = 0; tick < 10; tick++) {
      time += tickTicks;
      const start = performance.now();
      world.Tick(time);
      ticks.push(performance.now() - start);
    }
    const warm: number[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const start = performance.now();
      for (let sample = 1; sample <= WARMUP_SAMPLES_PER_TICK; sample++) world.SampleCurves(time - tickTicks + Math.round((sample * tickTicks) / WARMUP_SAMPLES_PER_TICK));
      warm.push(performance.now() - start);
    }
    return {
      ships: count,
      captureMs: Median(captures),
      streamBytes: snapshot.master.stream.byteLength,
      parkKB: Math.round(parkBytes / 1024),
      totalKB: Math.round(bytes / 1024),
      restoreMs: Median(restores),
      tickMs: Median(ticks),
      warmMsPerTick: Median(warm),
      windowSAt64MB: Math.round(((64 * 1024 * 1024) / bytes) * 5)
    };
  }

  it('measures capture, size, restore, re-simulation and warm-up at 50, 200 and 500 ships', () => {
    const rows = [50, 200, 500].map(Bench);
    console.log(JSON.stringify(rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Math.round(value * 100) / 100])))));
    for (const row of rows) expect(row['captureMs']).toBeGreaterThan(0);
  });
});
