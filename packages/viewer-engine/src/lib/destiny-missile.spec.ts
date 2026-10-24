import type { SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { FIRST_SHIP_BALL_ID, MISSILE_BALL_LINGER_TICKS, type MissileEvent, type MissileLaunch, type MissilePhysics } from './destiny';
import { BallStates, Fly, Harness, RIFTER, Ship } from './destiny.spec-helper';
import { CollideTwoSpheres, vec3 } from './runtime-sim';

// T1 missiles at max skills (plan §1.6): the heavy's 9,675 m/s on a Caracal, the light's 8,437.5 on a Kestrel; the
// SDE's 300 m radius; mass × agility / 1e6 ≈ 1e-7 s, so they fly at full speed from the first tick.
const HEAVY: MissilePhysics = { mass: 1000, agility: 0.0001, maxVelocity: 9675, radius: 300 };
const LIGHT: MissilePhysics = { ...HEAVY, maxVelocity: 8437.5 };
const RIFTER_FLIGHT = Fly(RIFTER);
const RIFTER_RADIUS = RIFTER.published.radius ?? 0;

/**
 * A shooter at the origin and a target `distance` metres off along +z, both at rest, a few ticks evolved.
 */
function Duel(distance: number, ships: { readonly id: string; readonly position: SceneVector }[] = []): Harness {
  const harness = new Harness();
  harness.world.AddShip(Ship('a', [0, 0, 0]), RIFTER_FLIGHT);
  harness.world.AddShip(Ship('b', [0, 0, distance]), RIFTER_FLIGHT);
  for (const ship of ships) harness.world.AddShip(Ship(ship.id, ship.position), RIFTER_FLIGHT);
  harness.Ticks(3);
  return harness;
}

function Launch(harness: Harness, overrides: Partial<MissileLaunch> = {}): MissileLaunch {
  const tick = harness.world.tick;
  return { id: 'm1', owner: 'a', target: 'b', physics: HEAVY, launchedAt: tick, expiresAt: tick + 10, ...overrides };
}

function Lockstep(harness: Harness, balls: number): void {
  expect(BallStates(harness.world, 'replica', balls)).toEqual(BallStates(harness.world, 'master', balls));
}

describe('DestinyWorld missiles', () => {
  it('launches a ball on both parks at the owner, in the missile mode on both, and keeps them in lockstep', () => {
    const harness = Duel(150_000);
    const { world } = harness;
    expect(world.LaunchMissile(Launch(harness, { expiresAt: harness.world.tick + 20 }))).toBeNull();
    const ballId = FIRST_SHIP_BALL_ID + 2;
    for (const park of [world.master, world.replica]) {
      const ball = park.GetBall(ballId);
      expect([ball?.x, ball?.y, ball?.z]).toEqual([0, 0, 0]);
      expect(ball?.mode).toBe(5);
      expect(ball?.isMassive).toBe(false);
    }
    expect(world.MissileIds()).toEqual(['m1']);
    for (const ticks of [1, 4, 5]) {
      harness.Ticks(ticks);
      Lockstep(harness, 3);
    }
    expect(world.Missile('m1')).toMatchObject({ state: 'flying', owner: 'a', target: 'b', mode: 'missile' });
  });

  it('hits a target 20 km off in its third tick, at the fraction a direct swept contact gives', () => {
    const harness = Duel(20_000);
    const { world } = harness;
    const start = world.tick;
    world.LaunchMissile(Launch(harness));
    const ballId = FIRST_SHIP_BALL_ID + 2;
    const positions: { missile: number[]; target: number[] }[] = [];
    const record = (): void => {
      const missile = world.master.GetBall(ballId);
      const target = world.master.GetBall(FIRST_SHIP_BALL_ID + 1);
      positions.push({ missile: [missile?.x ?? 0, missile?.y ?? 0, missile?.z ?? 0], target: [target?.x ?? 0, target?.y ?? 0, target?.z ?? 0] });
    };
    record();
    const events: MissileEvent[] = [];
    harness.Until(
      () => events.length > 0,
      10,
      () => {
        events.push(...world.TakeMissileEvents());
        if (!events.length) record();
        else positions.push(positions[positions.length - 1]);
      }
    );
    expect(events).toHaveLength(1);
    const [hit] = events;
    expect(hit).toMatchObject({ kind: 'hit', id: 'm1', owner: 'a', target: 'b', ended: true, tick: start + 3 });
    expect(Math.floor(hit.at)).toBe(start + 2);
    // The contact radius is the missile's 300 m plus the target's ball radius; the missile flew 19,669 m by then.
    expect(hit.at - start).toBeCloseTo((20_000 - 300 - RIFTER_RADIUS) / HEAVY.maxVelocity, 2);
    const before = positions[2];
    const missile = world.master.GetBall(ballId);
    const target = world.master.GetBall(FIRST_SHIP_BALL_ID + 1);
    const direct = CollideTwoSpheres(before.missile, [missile?.x ?? 0, missile?.y ?? 0, missile?.z ?? 0], before.target, [target?.x ?? 0, target?.y ?? 0, target?.z ?? 0], 300 + RIFTER_RADIUS);
    expect(hit.at - (start + 2)).toBeCloseTo(direct, 9);
    expect(world.Missile('m1')).toMatchObject({ state: 'done', mode: 'goto', expiresIn: 0 });
    Lockstep(harness, 3);
  });

  it('still hits a target orbiting at 1 km at 400 m/s', () => {
    const harness = Duel(30_000, [{ id: 'c', position: [0, 0, 31_000] }]);
    const { world } = harness;
    world.SetPhysics('b', { ...RIFTER_FLIGHT, maxVelocity: 400 });
    world.Order('b', { type: 'orbit', target: 'c', range: 1000, speed: 1 });
    harness.Ticks(20);
    expect(world.Motion('b')?.speed).toBeGreaterThan(300);
    world.LaunchMissile(Launch(harness, { expiresAt: world.tick + 12 }));
    const events: MissileEvent[] = [];
    harness.Until(
      () => events.length > 0,
      12,
      () => events.push(...world.TakeMissileEvents())
    );
    expect(events[0]).toMatchObject({ kind: 'hit', target: 'b' });
  });

  it('expires on the whole-tick rule: a 7.505 s light missile flies 7 ticks launched at k + 0.3 and 8 at k + 0.7', () => {
    // Out of reach in 7 ticks (59,062.5 m), in reach in the 8th (67,500 m).
    const distance = 64_000 + 300 + RIFTER_RADIUS;
    const run = (phase: number): MissileEvent[] => {
      const harness = Duel(distance);
      const { world } = harness;
      const launchedAt = world.tick + phase;
      world.LaunchMissile(Launch(harness, { physics: LIGHT, launchedAt, expiresAt: launchedAt + 7.505 }));
      const events: MissileEvent[] = [];
      harness.Ticks(10, () => events.push(...world.TakeMissileEvents()));
      return events.map((event) => ({ ...event, tick: event.tick - Math.floor(launchedAt), at: event.at - Math.floor(launchedAt) }));
    };
    const [early] = run(0.3);
    expect(early).toMatchObject({ kind: 'expired', tick: 8, ended: true });
    expect(early.at).toBeCloseTo(7.805, 9);
    const [late] = run(0.7);
    expect(late).toMatchObject({ kind: 'hit', tick: 8 });
    expect(late.at).toBeGreaterThan(7);
  });

  it('loses a target that enters warp: straight on, no hit, then expired', () => {
    const harness = Duel(150_000);
    const { world } = harness;
    world.Order('b', { type: 'warp', point: [0, 0, 5e10], range: 0 });
    world.LaunchMissile(Launch(harness, { expiresAt: world.tick + 20 }));
    const events: MissileEvent[] = [];
    harness.Ticks(22, () => events.push(...world.TakeMissileEvents()));
    expect(events.map((event) => [event.kind, event.why ?? null, event.ended])).toEqual([
      ['lost', 'its target entered warp', false],
      ['expired', null, true]
    ]);
    Lockstep(harness, 3);
  });

  it('loses a removed or destroyed target', () => {
    const removed = Duel(150_000);
    removed.world.LaunchMissile(Launch(removed, { expiresAt: removed.world.tick + 20 }));
    removed.Ticks(2);
    removed.world.RemoveShip('b');
    removed.Ticks(1);
    expect(removed.world.TakeMissileEvents()).toMatchObject([{ kind: 'lost', why: 'its target was removed', ended: false }]);
    expect(removed.world.Missile('m1')).toMatchObject({ state: 'lost', mode: 'goto', distance: null });

    const destroyed = Duel(150_000);
    const { world } = destroyed;
    world.LaunchMissile(Launch(destroyed, { expiresAt: world.tick + 20 }));
    destroyed.Ticks(2);
    world.Destroy('b');
    expect(world.TakeMissileEvents()).toMatchObject([{ kind: 'lost', why: 'its target was destroyed', ended: false, at: world.tick }]);
    for (const park of [world.master, world.replica]) expect(park.GetBall(FIRST_SHIP_BALL_ID + 2)?.mode).toBe(0);
    destroyed.Ticks(20);
    expect(world.TakeMissileEvents().map((event) => event.kind)).toEqual(['expired']);
    Lockstep(destroyed, 3);
  });

  it('vanishes when its ship is destroyed, removed or enters warp', () => {
    const cases: [string, (harness: Harness) => void][] = [
      ['its ship was destroyed', (harness) => harness.world.Destroy('a')],
      ['its ship was removed', (harness) => harness.world.RemoveShip('a')],
      ['its ship entered warp', (harness) => harness.world.Order('a', { type: 'warp', point: [0, 0, -5e10], range: 0 })]
    ];
    for (const [why, act] of cases) {
      const harness = Duel(150_000);
      harness.world.LaunchMissile(Launch(harness, { expiresAt: harness.world.tick + 20 }));
      harness.Ticks(1);
      act(harness);
      const events: MissileEvent[] = [];
      harness.Until(
        () => events.length > 0,
        15,
        () => events.push(...harness.world.TakeMissileEvents())
      );
      expect(events).toMatchObject([{ kind: 'lost', why, ended: true }]);
      expect(harness.world.Missile('m1')?.state).toBe('done');
    }
  });

  it('refuses a target in another bubble or in warp, and a destroyed owner, adding nothing', () => {
    const far = Duel(20_000_000);
    expect(far.world.LaunchMissile(Launch(far))).toBe('target "b" is in another Destiny bubble');
    expect(far.world.MissileIds()).toEqual([]);
    expect(far.world.master.GetBall(FIRST_SHIP_BALL_ID + 2)).toBeNull();

    const warping = Duel(50_000);
    warping.world.Order('b', { type: 'warp', point: [0, 0, 5e10], range: 0 });
    warping.Until(() => warping.world.InWarp('b'), 20);
    expect(warping.world.LaunchMissile(Launch(warping))).toBe('target "b" is in warp');

    const dead = Duel(50_000);
    dead.world.Destroy('a');
    expect(dead.world.LaunchMissile(Launch(dead))).toBe('ship "a" was destroyed');
    expect(dead.world.LaunchMissile(Launch(dead, { owner: 'b' }))).toBe('a ship cannot launch at itself');
    expect(dead.world.LaunchMissile(Launch(dead, { owner: 'b', target: 'nobody' }))).toBe('target "nobody" is gone');
    expect(dead.world.MissileIds()).toEqual([]);
  });

  it(`takes an ended ball off both parks ${MISSILE_BALL_LINGER_TICKS} boundaries later; RemoveMissilesOf and ClearMissiles take them at once`, () => {
    const harness = Duel(20_000, [{ id: 'c', position: [0, 0, 40_000] }]);
    const { world } = harness;
    world.LaunchMissile(Launch(harness));
    let ended = 0;
    harness.Until(
      () => ended > 0,
      5,
      () => {
        if (world.TakeMissileEvents().length) ended = world.tick;
      }
    );
    const ballId = FIRST_SHIP_BALL_ID + 3;
    harness.Ticks(MISSILE_BALL_LINGER_TICKS - 1);
    expect(world.MissileIds()).toEqual(['m1']);
    harness.Ticks(1);
    expect(world.tick).toBe(ended + MISSILE_BALL_LINGER_TICKS);
    expect(world.MissileIds()).toEqual([]);
    harness.Ticks(1);
    expect(world.master.GetBall(ballId)).toBeNull();
    expect(world.replica.GetBall(ballId)).toBeNull();

    world.LaunchMissile(Launch(harness, { id: 'a1', target: 'c' }));
    world.LaunchMissile(Launch(harness, { id: 'a2', target: 'c' }));
    world.LaunchMissile(Launch(harness, { id: 'b1', owner: 'b', target: 'c' }));
    expect(world.RemoveMissilesOf('a')).toEqual(['a1', 'a2']);
    expect(world.MissileIds()).toEqual(['b1']);
    world.ClearMissiles();
    expect(world.MissileIds()).toEqual([]);
    harness.Ticks(1);
    expect(world.TakeMissileEvents()).toEqual([]);
    Lockstep(harness, 7);
  });

  it('draws about a tick behind the master (the drawn lag)', () => {
    const harness = Duel(200_000);
    const { world } = harness;
    const start = world.tick;
    world.LaunchMissile(Launch(harness, { expiresAt: start + 20 }));
    const curve = world.MissileCurves('m1');
    expect(curve).not.toBeNull();
    const lags: number[] = [];
    harness.Ticks(10, () => {
      const master = world.master.GetBall(FIRST_SHIP_BALL_ID + 2);
      const drawn = curve?.Update__Ticks(harness.now, vec3.create()) ?? vec3.create();
      lags.push(((master?.z ?? 0) - drawn[2]) / HEAVY.maxVelocity);
    });
    // After the launch tick the drawn missile trails the master by one tick (as the drawn ships do), right after
    // each evolve.
    for (const lag of lags.slice(3)) expect(lag).toBeCloseTo(1, 1);
  });
});
