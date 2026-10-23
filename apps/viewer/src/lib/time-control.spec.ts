import { describe, expect, it, vi } from 'vitest';
import { CLOCK_EPOCH_TICKS, SceneClock, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { BallStates, FRAME_TICKS, Harness, Ship, TFI } from './destiny.spec-helper';
import { ResolveFlight, type PublishedHull } from './flight';
import { ResolveShipPropMod } from './prop-mods';
import { RateText, TimeControl, TimeText, type TimePresentation } from './time-control';

const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null, propMod: ResolveShipPropMod({ module: 'mwd', rigSize: 1, answer: null }) });
const tfi = ResolveFlight({ published: TFI, hull: null, overrides: null });

const BALLS = 5;

/**
 * The same scene and the same commands at the same boundaries, whoever steps the world: a turning FC with a follower
 * in its slot, a ship with an MWD switched on and off, a delayed order and a warp. Every boundary is logged.
 *
 * @param world - A fresh world.
 * @returns The boundaries the world processed, in order.
 */
function Stage(world: DestinyWorld): number[] {
  world.AddShip(Ship('fc', [0, 0, 0]), tfi);
  world.AddShip(Ship('m0', [0, 0, -1281]), rifter);
  world.AddShip(Ship('mwd', [5000, 0, 0]), rifter);
  world.AddShip(Ship('late', [-5000, 0, 0]), rifter);
  world.AddShip(Ship('warper', [0, 5000, 0]), rifter);
  world.Follow('m0', { anchor: 'fc', range: 1000, frame: 'fc', direction: [0, 0, -1], slotRange: 1000, speed: 1 });
  const boundaries: number[] = [];
  world.OnBeforeBoundary((boundary) => {
    if (boundary === 2) world.Order('fc', { type: 'direction', direction: [1, 0, 0.2], speed: 1 });
    if (boundary === 3) world.Order('late', { type: 'goto', point: [-5000, 0, 20_000], speed: 1 }, { delay: 4 });
    if (boundary === 4) world.SwitchPropMod('mwd', true);
    if (boundary === 6) world.Order('warper', { type: 'warp', point: [0, 5000, 800_000], range: 0 });
    if (boundary === 9) world.SwitchPropMod('mwd', false);
    if (boundary === 14) world.Order('fc', { type: 'direction', direction: [-1, 0.3, 0], speed: 1 });
  });
  world.OnBoundary((boundary) => boundaries.push(boundary));
  return boundaries;
}

/**
 * The master park's ship balls at every tick, as a world evolves.
 */
function Recorder(world: DestinyWorld): Map<number, number[][]> {
  const states = new Map<number, number[][]>();
  states.set(world.tick, BallStates(world, 'master', BALLS));
  return states;
}

describe('TimeControl', () => {
  it('steps every tick at 8× and at 32× behind its budget, equal to real time tick for tick', () => {
    const TICKS = 40;
    // World A: the spec harness at 60 fps and 1×, its first frame at the epoch like the page's.
    const harness = new Harness();
    harness.now = CLOCK_EPOCH_TICKS - FRAME_TICKS;
    const boundariesA = Stage(harness.world);
    const statesA = Recorder(harness.world);
    harness.Ticks(TICKS, () => statesA.set(harness.world.tick, BallStates(harness.world, 'master', BALLS)));

    // 4 fps frames: at 8× each frame steps two boundaries; at 32× it wants eight, but each stepped tick costs 50 ms of
    // fake real time and the 40 ms budget stops after one.
    for (const { rate, tickCost, perFrame, effective } of [
      { rate: 8, tickCost: 0, perFrame: 2, effective: 8 },
      { rate: 32, tickCost: 50, perFrame: 1, effective: 4 }
    ]) {
      const clock = new SceneClock();
      const world = new DestinyWorld();
      const boundariesB = Stage(world);
      const statesB = Recorder(world);
      let real = 0;
      const stepped = {
        get tick() {
          return world.tick;
        },
        NextBoundaryTime: () => world.NextBoundaryTime(),
        Tick: (now: number) => {
          const before = world.tick;
          world.Tick(now);
          if (world.tick === before) return;
          real += tickCost;
          // Stepped exactly on the grid: the clock is the boundary the tick evolved from.
          expect(world.NextBoundaryTime()).toBe(now + TICKS_PER_SECOND);
          statesB.set(world.tick, BallStates(world, 'master', BALLS));
        }
      };
      const control = new TimeControl({ clock, world: stepped, realNow: () => real, budgetMs: 40 });
      control.SetRate(rate);
      let lastTick = world.tick;
      for (let frame = 0; world.tick < TICKS + 1 && frame < 1000; frame++) {
        control.Frame(frame * 250);
        if (frame > 1) expect(world.tick - lastTick, `rate ${rate}, frame ${frame}`).toBe(perFrame);
        lastTick = world.tick;
      }
      expect(boundariesB.slice(0, TICKS)).toEqual(boundariesA.slice(0, TICKS));
      expect(boundariesB.slice(0, TICKS)).toEqual(Array.from({ length: TICKS }, (_, index) => index));
      for (let tick = 1; tick <= TICKS; tick++) expect(statesB.get(tick), `rate ${rate}, tick ${tick}`).toEqual(statesA.get(tick));
      expect(control.effectiveRate).toBeCloseTo(effective, 1);
      expect(control.Report().effectiveRate).toBe(rate === effective ? undefined : effective);
    }
  });

  it('reports the effective rate when the budget holds the clock back', () => {
    const clock = new SceneClock();
    const world = new DestinyWorld();
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    let real = 0;
    world.OnBoundary(() => {
      real += 50;
    });
    const control = new TimeControl({ clock, world, realNow: () => real, budgetMs: 40 });
    control.SetRate(32);
    // 4 fps frames want 8 s of scene each; the budget steps one tick (1 s) a frame.
    for (let frame = 0; frame <= 8; frame++) control.Frame(frame * 250);
    expect(control.effectiveRate).toBeCloseTo(4, 1);
    expect(control.Report()).toMatchObject({ rate: 32, paused: false, state: 'playing', effectiveRate: 4, audio: 'muted' });
  });

  it('runs no tick while paused, one every 4 s at 0.25×, and anchors the grid at the first frame', () => {
    const clock = new SceneClock();
    const world = new DestinyWorld();
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.Order('a', { type: 'direction', direction: [0, 0, 1], speed: 1 });
    const control = new TimeControl({ clock, world });
    expect(world.NextBoundaryTime()).toBeNull();
    control.Frame(1000);
    expect(world.tick).toBe(1);
    expect(world.NextBoundaryTime()).toBe(CLOCK_EPOCH_TICKS + TICKS_PER_SECOND);
    control.Pause(true);
    for (let ms = 1016; ms < 6000; ms += 16) control.Frame(ms);
    expect(world.tick).toBe(1);
    expect(clock.now).toBe(CLOCK_EPOCH_TICKS);
    expect(control.Report()).toMatchObject({ paused: true, state: 'paused', audio: 'suspended', seconds: 0 });
    control.Pause(false);
    control.SetRate(0.25);
    let ms = 6000;
    control.Frame(ms);
    for (; ms < 6000 + 3900; ms += 16) control.Frame(ms);
    expect(world.tick).toBe(1);
    for (; ms < 6000 + 4100; ms += 16) control.Frame(ms);
    expect(world.tick).toBe(2);
    expect(control.Report()).toMatchObject({ rate: 0.25, paused: false });
    expect(control.Report().audio).toBeUndefined();
  });

  it('presents pause and muting to its port on attach and on change only', () => {
    const control = new TimeControl({ clock: new SceneClock(), world: new DestinyWorld() });
    const presented: TimePresentation[] = [];
    control.AttachPort({ Presentation: (presentation) => presented.push(presentation) });
    control.SetRate(2);
    control.SetRate(4);
    control.SetRate(8);
    control.Pause(true);
    control.Pause(true);
    control.SetRate(0.5);
    expect(presented).toEqual([
      { paused: false, muted: false },
      { paused: false, muted: true },
      { paused: true, muted: true },
      { paused: true, muted: false }
    ]);
    expect(() => control.SetRate(0)).toThrow(RangeError);
  });

  it('logs a failing tick once and keeps the loop', () => {
    const clock = new SceneClock();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const world = {
      tick: 1,
      NextBoundaryTime: () => clock.now,
      Tick: () => {
        throw new Error('boom');
      }
    };
    const control = new TimeControl({ clock, world });
    control.Frame(0);
    control.Frame(16);
    control.Frame(32);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('writes the HUD row', () => {
    expect(RateText(1 / 16)).toBe('0.0625×');
    expect(TimeText({ seconds: 3, tick: 4, rate: 1, paused: false, state: 'playing' })).toBe('1×');
    expect(TimeText({ seconds: 3, tick: 4, rate: 0.25, paused: true, state: 'paused', audio: 'suspended' })).toBe('paused at 0.25×');
    expect(TimeText({ seconds: 3, tick: 4, rate: 32, paused: false, state: 'playing', effectiveRate: 2.7, audio: 'muted' })).toBe('32× (2.7× actual) · muted');
  });
});
