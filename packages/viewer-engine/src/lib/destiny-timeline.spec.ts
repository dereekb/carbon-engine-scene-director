import { describe, expect, it } from 'vitest';
import { ResolveFlight } from './flight';
import { ResolveShipPropMod } from './prop-mods';
import { BallStates, Fly, Harness, RequireMotion, RIFTER, Ship, TFI } from './destiny.spec-helper';

describe('DestinyWorld OnBeforeBoundary', () => {
  const tfi = ResolveFlight({ published: { ...TFI, published: { ...TFI.published, rigSize: 3 } }, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 3, answer: null }) });

  it('runs before the prop mods and the OnBoundary listeners, with the boundary and its scene-clock time', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), Fly(RIFTER));
    harness.Ticks(2);
    const calls: string[] = [];
    let seen: [number, number] | null = null;
    world.OnBoundary((boundary) => calls.push(`boundary ${boundary}`));
    world.OnBeforeBoundary((boundary, time) => {
      calls.push(`before ${boundary}`);
      seen = [boundary, time];
    });
    const tick = world.tick;
    harness.Ticks(1);
    expect(calls).toEqual([`before ${tick}`, `boundary ${tick}`]);
    expect(seen).not.toBeNull();
    expect(seen?.[0]).toBe(tick);
    expect(seen?.[1]).toBeLessThanOrEqual(harness.now);
    expect(harness.now - (seen?.[1] ?? 0)).toBeLessThan(10_000_000 / 60 + 1);
  });

  it('applies an order given there at that boundary, and a prop mod switched on there is active since that boundary', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), tfi);
    world.AddShip(Ship('b', [5000, 0, 0]), Fly(RIFTER));
    harness.Ticks(2);
    let fired: number | null = null;
    const off = world.OnBeforeBoundary((boundary) => {
      if (fired !== null) return;
      fired = boundary;
      world.Order('b', { type: 'direction', direction: [0, 0, 1], speed: 1 });
      world.SwitchPropMod('a', true);
    });
    harness.Ticks(1);
    off();
    expect(fired).not.toBeNull();
    expect(RequireMotion(world, 'b').order).toMatchObject({ type: 'direction' });
    expect(RequireMotion(world, 'b').pendingOrder).toBeUndefined();
    expect(RequireMotion(world, 'b').speed).toBeGreaterThan(0);
    expect(RequireMotion(world, 'a').propMod).toMatchObject({ state: 'active', since: fired });
  });

  it('keeps master and replica bit-identical when ships are added and removed there', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), Fly(RIFTER));
    world.Order('a', { type: 'direction', direction: [1, 0, 0], speed: 1 });
    harness.Ticks(2);
    let step = 0;
    world.OnBeforeBoundary(() => {
      step++;
      if (step === 1) {
        world.AddShip(Ship('b', [2000, 0, 0]), Fly(RIFTER));
        world.Order('b', { type: 'approach', target: 'a', speed: 1 });
      }
      if (step === 3) world.RemoveShip('a');
      if (step === 4) world.AddShip(Ship('c', [0, 3000, 0]), Fly(RIFTER));
    });
    harness.Ticks(6);
    expect(world.Motion('a')).toBeNull();
    expect(BallStates(world, 'replica', 4)).toEqual(BallStates(world, 'master', 4));
  });

  it('logs a throwing listener and still runs the rest and the tick', () => {
    const harness = new Harness();
    const { world } = harness;
    world.AddShip(Ship('a', [0, 0, 0]), Fly(RIFTER));
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args[0]);
    try {
      let ran = 0;
      world.OnBeforeBoundary(() => {
        throw new Error('boom');
      });
      world.OnBeforeBoundary(() => ran++);
      const tick = world.tick;
      harness.Ticks(1);
      expect(ran).toBe(1);
      expect(world.tick).toBe(tick + 1);
      expect(String(errors[0])).toContain('OnBeforeBoundary');
    } finally {
      console.error = original;
    }
  });
});

describe('DestinyWorld time invariance', () => {
  const tfi = ResolveFlight({ published: { ...TFI, published: { ...TFI.published, rigSize: 3 } }, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 3, answer: null }) });

  // A timeline replay rests on this: the same orders at the same ticks since t = 0 fly the same, whatever the world's
  // absolute tick.
  it('flies the same relative orders to the same ball states when started 37 ticks later, orbits from the epoch', () => {
    const run = (start: number): number[][] => {
      const harness = new Harness();
      const { world } = harness;
      // The later world had balls before (an earlier run's ships): ids are seeded, not counted.
      for (let index = 0; index < start % 5; index++) world.AddShip(Ship(`old-${index}`, [0, 50_000, index * 1000]), Fly(RIFTER));
      harness.Ticks(start);
      for (let index = 0; index < start % 5; index++) world.RemoveShip(`old-${index}`);
      // A load: orbit time and ship ball ids start from here (Director.ApplyNow).
      world.SetSceneEpoch(world.tick);
      world.AddShip(Ship('a', [0, 0, 0]), tfi);
      world.AddShip(Ship('b', [8000, 0, 2000]), Fly(RIFTER));
      world.AddShip(Ship('c', [-3000, 500, 0]), Fly(RIFTER));
      let played = 0;
      world.OnBeforeBoundary(() => {
        played++;
        if (played === 1) {
          world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
          world.Order('b', { type: 'approach', target: 'a', speed: 1 });
        }
        if (played === 3) world.SwitchPropMod('a', true);
        if (played === 5) world.Order('c', { type: 'orbit', target: 'a', range: 2500, speed: 1 });
        if (played === 12) world.Order('b', { type: 'keep-at-range', target: 'c', range: 5000, speed: 1 });
        if (played === 16) world.SwitchPropMod('a', false);
        if (played === 20) world.Order('a', { type: 'goto', point: [0, 2000, 40_000], speed: 0.5 });
      });
      harness.Ticks(30);
      expect(played).toBe(30);
      // Positions, velocities, mode, heading and physics; effectStamp is an absolute tick.
      return ['a', 'b', 'c'].map((id) => {
        const ball = world.master.GetBall(world.BallIdOf(id) ?? 0);
        return ball ? [ball.x, ball.y, ball.z, ball.vx, ball.vy, ball.vz, ball.mode, ball.mNewYaw, ball.mNewPitch, ball.mass, ball.maxVelocity, ball.agility] : [];
      });
    };
    expect(run(39)).toEqual(run(2));
  });
});
