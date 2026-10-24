import type { SceneVector } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import type { WarpEvent } from './destiny';
import { Fly, Gap, Harness, RequireMotion, RIFTER, Ship, TFI } from './destiny.spec-helper';
import { vec3 } from './runtime-sim';
import { RotationToward, WARP_IN_GLOW_PATH, WARP_IN_NOGLOW_PATH, WARP_OUT_PATH, WARP_OUT_START_PATH, WarpFlashReplays, WarpFlashScale, WarpFx, WarpInFlashPath, WarpInTriggerDistance, type WarpFxCommand } from './warp-fx';
import { RoundTrip } from './state-capture.spec-helper';

const RIFTER_RADIUS = 31;
const TFI_RADIUS = 250;
const RADII: Record<string, number> = { r: RIFTER_RADIUS, t: TFI_RADIUS };
const AHEAD: SceneVector = [0, 0, 500_000_000];
const LANDING: SceneVector = [5_000, 0, 20_000];

interface Run {
  readonly harness: Harness;
  readonly fx: WarpFx;
  readonly commands: (WarpFxCommand & { readonly from: 'event' | 'frame'; readonly at: number })[];
  readonly events: WarpEvent[];
  /**
   * The drawn distance to the landing on the frame each frame command was made.
   */
  readonly drawnGaps: number[];
  /**
   * Run frames, calling WarpFx.Frame on each unless `frames` is off.
   */
  Until(done: () => boolean, limit: number, frames?: boolean): void;
}

function Setup(id = 'r', physics = Fly(RIFTER)): Run {
  const harness = new Harness();
  const { world } = harness;
  world.AddShip(Ship(id, [0, 0, 0]), physics);
  harness.Ticks(6);
  const fx = new WarpFx({
    RadiusOf: (ship) => RADII[ship] ?? 50,
    DrawnPosition: (ship, now) => {
      const curves = world.Curves(ship);
      return curves ? (Array.from(curves.translation.GetValueAt__Ticks(now, vec3.create())) as SceneVector) : null;
    },
    InWarp: (ship) => world.InWarp(ship),
    get tick() {
      return world.tick;
    }
  });
  const run: Run = {
    harness,
    fx,
    commands: [],
    events: [],
    drawnGaps: [],
    Until(done, limit, frames = true) {
      harness.Until(done, limit, undefined, () => {
        if (!frames) return;
        for (const command of fx.Frame(harness.now)) {
          run.commands.push({ ...command, from: 'frame', at: world.tick });
          const curves = world.Curves(command.ship);
          if (curves) run.drawnGaps.push(Gap(curves.translation.GetValueAt__Ticks(harness.now, vec3.create()), command.position));
        }
      });
    }
  };
  world.OnWarp((event) => {
    run.events.push(event);
    for (const command of fx.OnWarp(event)) run.commands.push({ ...command, from: 'event', at: world.tick });
  });
  return run;
}

/**
 * v + 2w (q × v) + 2 q × (q × v).
 */
function Rotate(rotation: readonly number[], vector: SceneVector): number[] {
  const [x, y, z, w] = rotation;
  const cross = (a: readonly number[], b: readonly number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const t = cross([x, y, z], vector).map((value) => 2 * value);
  const u = cross([x, y, z], t);
  return vector.map((value, axis) => value + w * t[axis] + u[axis]);
}

describe('WarpFx', () => {
  it('flashes a warp-out on entering and one warp-in when the drawn ship nears its landing, before the exit', () => {
    const run = Setup();
    const { world } = run.harness;
    expect(world.Order('r', { type: 'warp', point: AHEAD, range: 0 })).toBe(true);
    run.Until(() => run.events.some((event) => event.kind === 'exit'), 400);

    const enter = run.events.find((event) => event.kind === 'enter');
    const exit = run.events.find((event) => event.kind === 'exit');
    expect(run.commands.map(({ kind, from }) => `${kind}:${from}`)).toEqual(['warp-out:event', 'warp-in:frame']);
    const [out, inFlash] = run.commands;
    expect(out).toMatchObject({ ship: 'r', files: [WARP_OUT_START_PATH, WARP_OUT_PATH], position: enter?.position, scale: 0.5, tick: enter?.tick });
    // Along the warp: +Z turns onto the direction.
    const along = Rotate(out.rotation, [0, 0, 1]);
    enter?.direction.forEach((value, axis) => expect(along[axis]).toBeCloseTo(value, 6));
    expect(inFlash).toMatchObject({ ship: 'r', files: [WARP_IN_NOGLOW_PATH], position: exit?.landing, scale: 0.5 });
    expect(inFlash.at).toBeLessThanOrEqual(exit?.tick ?? 0);
    expect(run.drawnGaps[0]).toBeLessThanOrEqual(WarpInTriggerDistance(RIFTER_RADIUS));
    expect(run.fx.Counts()).toEqual({ warpOut: 1, warpIn: 1 });
    expect(run.fx.Tracking('r')).toBe(false);
  });

  it('gives an arrival no warp-out, and its warp-in at the landing', () => {
    const run = Setup('t', Fly(TFI));
    const { world } = run.harness;
    const from: SceneVector = [LANDING[0], LANDING[1], LANDING[2] - 1e9];
    expect(world.Arrive('t', { from, landing: LANDING, at: world.tick })).toBe(true);
    run.Until(() => run.events.some((event) => event.kind === 'exit'), 600);

    expect(run.events.map((event) => `${event.kind}:${event.arrival ?? false}`)).toEqual(['enter:true', 'exit:true']);
    expect(run.commands.map(({ kind, from: made }) => `${kind}:${made}`)).toEqual(['warp-in:frame']);
    expect(run.commands[0]).toMatchObject({ files: [WARP_IN_GLOW_PATH], position: LANDING, scale: 1 });
    expect(run.commands[0].at).toBeLessThanOrEqual(run.events[1].tick);
    expect(run.fx.Counts()).toEqual({ warpOut: 0, warpIn: 1 });
  });

  it('plays the warp-in on the exit when no frame did', () => {
    const run = Setup();
    const { world } = run.harness;
    expect(world.Order('r', { type: 'warp', point: AHEAD, range: 0 })).toBe(true);
    run.Until(() => run.events.some((event) => event.kind === 'exit'), 400, false);

    expect(run.commands.map(({ kind, from }) => `${kind}:${from}`)).toEqual(['warp-out:event', 'warp-in:event']);
    expect(run.commands[1].position).toEqual(run.events[1].landing);
    expect(run.fx.Counts()).toEqual({ warpOut: 1, warpIn: 1 });
  });

  it('drops a warp a placement ends: no warp-in, then or later', () => {
    const run = Setup();
    const { world } = run.harness;
    expect(world.Order('r', { type: 'warp', point: AHEAD, range: 0 })).toBe(true);
    run.Until(() => run.events.length > 0, 400);
    run.Until(() => Gap(RequireMotion(world, 'r').position, [0, 0, 0]) > 1e7, 400);
    expect(run.fx.Tracking('r')).toBe(true);

    world.PlaceShip(Ship('r', [0, 0, 1000]));
    run.harness.Ticks(30, undefined, () => {
      for (const command of run.fx.Frame(run.harness.now)) run.commands.push({ ...command, from: 'frame', at: world.tick });
    });
    expect(run.fx.Tracking('r')).toBe(false);
    expect(run.events.map((event) => event.kind)).toEqual(['enter']);
    expect(run.commands.map(({ kind }) => kind)).toEqual(['warp-out']);
    expect(run.fx.Counts()).toEqual({ warpOut: 1, warpIn: 0 });
  });

  it('drops a removed ship', () => {
    const run = Setup();
    const { world } = run.harness;
    expect(world.Order('r', { type: 'warp', point: AHEAD, range: 0 })).toBe(true);
    run.Until(() => run.events.length > 0, 400);
    world.RemoveShip('r');
    expect(run.fx.Frame(run.harness.now)).toEqual([]);
    expect(run.fx.Tracking('r')).toBe(false);
  });

  it('picks the variant and scale by SOF radius, and turns +Z along the warp', () => {
    expect(WarpInFlashPath(31)).toBe(WARP_IN_NOGLOW_PATH);
    expect(WarpInFlashPath(149.9)).toBe(WARP_IN_NOGLOW_PATH);
    expect(WarpInFlashPath(150)).toBe(WARP_IN_GLOW_PATH);
    expect(WarpFlashScale(31)).toBe(0.5);
    expect(WarpFlashScale(250)).toBe(1);
    expect(WarpFlashScale(1000)).toBe(4);
    expect(WarpFlashScale(20_000)).toBe(8);
    expect(WarpFlashScale(Number.NaN)).toBe(1);
    expect(WarpInTriggerDistance(31)).toBe(2000);
    expect(WarpInTriggerDistance(1000)).toBe(4000);
    expect(RotationToward([0, 0, 1])).toEqual([0, 0, 0, 1]);
    expect(RotationToward([0, 0, 0])).toEqual([0, 0, 0, 1]);
    for (const direction of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0.6, 0, -0.8],
      [0.48, 0.6, 0.64]
    ] as SceneVector[]) {
      const along = Rotate(RotationToward(direction), [0, 0, 1]);
      direction.forEach((value, axis) => expect(along[axis]).toBeCloseTo(value, 9));
    }
  });
});

describe('WarpFlashReplays (sd-time)', () => {
  it('plays again the swallowed flashes still playing at the target: warp-ins within 4.125 s, warp-outs within 1 s', () => {
    const Flash = (kind: WarpFxCommand['kind'], ship: string, at: number) => ({ command: { kind, ship, files: [], position: [0, 0, 0] as SceneVector, rotation: [0, 0, 0, 1] as const, scale: 1, tick: at }, at });
    const swallowed = [Flash('warp-in', 'old', 5.5), Flash('warp-in', 'landing', 6), Flash('warp-out', 'left', 8.9), Flash('warp-out', 'leaving', 9.2), Flash('warp-in', 'now', 10), Flash('warp-in', 'after', 10.5)];
    expect(WarpFlashReplays(swallowed, 10, 1).map((command) => command.ship)).toEqual(['landing', 'leaving', 'now']);
    expect(WarpFlashReplays([], 10, 1)).toEqual([]);
    expect(WarpFlashReplays([Flash('warp-out', 'a', 2e7)], 2.5e7, 1e7).map((command) => command.ship)).toEqual(['a']);
  });
});

describe('WarpFx snapshots (sd-time)', () => {
  it('restores the tracked warps and the flash counts', () => {
    const run = Setup();
    const { world } = run.harness;
    world.Order('r', { type: 'warp', point: AHEAD, range: 0 });
    run.Until(() => run.events.some((event) => event.kind === 'enter'), 400);
    const trip = RoundTrip(
      run.fx,
      (fx) => [fx.Tracking('r'), fx.Counts()],
      () => run.Until(() => run.events.some((event) => event.kind === 'exit'), 400)
    );
    expect(trip.before).toEqual([true, expect.anything()]);
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
  });
});
