/**
 * The movie export's fixed-step clock (sd-export): the frame grid, FrameTo stepping every boundary with no budget and no
 * StopAt, an export at 24, 30 and 60 fps equal to the live 1× run tick for tick, the preroll, and the drawn attitudes
 * sampled at 30 vs 60 Hz.
 */

import { describe, expect, it } from 'vitest';
import { CLOCK_EPOCH_TICKS, SceneClock, TICKS_PER_MS, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { BallStates, Ship } from './destiny.spec-helper';
import { ExportFrameCount, ExportFrameMicros, ExportFrameTicks, ExportPrerollFrames, ExportStepper, type ExportStep } from './export-frames';
import { ResolveFlight, type PublishedHull } from './flight';
import { quat, type Quat } from './runtime-sim';
import { TimeControl } from './time-control';
import { Cue, Direction, RIG_BALLS, SHIPS_A, TimelineRig } from './timeline.spec-helper';
import type { SceneCue, ShipOrder } from '@scene-director/scene';

const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null });

describe('the export frame grid (sd-export)', () => {
  it('has no drift: every step is the floor or ceil of 1/fps, and k × fps frames are exactly k seconds', () => {
    for (const fps of [24, 25, 30, 60, 120]) {
      const step = TICKS_PER_SECOND / fps;
      const micro = 1e6 / fps;
      let previous = ExportFrameTicks(0, fps);
      let previousMicros = ExportFrameMicros(0, fps);
      expect([previous, previousMicros]).toEqual([0, 0]);
      for (let index = 1; index <= 108_000; index++) {
        const ticks = ExportFrameTicks(index, fps);
        const micros = ExportFrameMicros(index, fps);
        const delta = ticks - previous;
        const deltaMicros = micros - previousMicros;
        if (delta !== Math.floor(step) && delta !== Math.ceil(step)) throw new Error(`${fps} fps, frame ${index}: a step of ${delta} ticks`);
        if (deltaMicros !== Math.floor(micro) && deltaMicros !== Math.ceil(micro)) throw new Error(`${fps} fps, frame ${index}: a step of ${deltaMicros} µs`);
        if (index % fps === 0) {
          expect(ticks).toBe((index / fps) * TICKS_PER_SECOND);
          expect(micros).toBe((index / fps) * 1e6);
        }
        previous = ticks;
        previousMicros = micros;
      }
    }
    // The preroll's negative indices follow the same rule.
    expect(ExportFrameTicks(-30, 30)).toBe(-TICKS_PER_SECOND);
    expect(ExportFrameTicks(-1, 30)).toBe(-333_333);
  });

  it('counts frames, and keeps the preroll from reaching before t = 0', () => {
    expect(ExportFrameCount(95, 30)).toBe(2850);
    expect(ExportFrameCount(4, 10)).toBe(40);
    expect(ExportPrerollFrames(2, 30, 30)).toBe(60);
    expect(ExportPrerollFrames(2, 1, 30)).toBe(30);
    expect(ExportPrerollFrames(2, 0, 30)).toBe(0);
    expect(ExportPrerollFrames(2, 0.1, 30)).toBe(3);
    expect(ExportPrerollFrames(0, 30, 60)).toBe(0);
  });

  it('steps the preroll without encoding it, retries a frame with Again, and ends with null', () => {
    const targets: number[] = [];
    let tick = 0;
    const stepper = new ExportStepper({
      time: {
        FrameTo: (target) => {
          targets.push(target);
          tick += 1;
          return target;
        }
      },
      world: {
        get tick() {
          return tick;
        }
      },
      grid: { origin: CLOCK_EPOCH_TICKS + 5 * TICKS_PER_SECOND, fps: 30, preroll: 60, frames: 90 }
    });
    const steps: ExportStep[] = [];
    expect(stepper.index).toBe(-60);
    for (let step = stepper.Next(); step; step = stepper.Next()) {
      steps.push(step);
      if (step.index === 10) {
        expect(stepper.Again()).toBe(step);
        expect(targets).toHaveLength(71);
      }
    }
    expect(stepper.done).toBe(true);
    expect(stepper.Next()).toBeNull();
    expect(steps.map((step) => step.index)).toEqual(Array.from({ length: 150 }, (_, i) => i - 60));
    expect(steps.filter((step) => step.encode).map((step) => step.index)).toEqual(Array.from({ length: 90 }, (_, i) => i));
    for (const step of steps) expect(step.clock).toBe(CLOCK_EPOCH_TICKS + 5 * TICKS_PER_SECOND + ExportFrameTicks(step.index, 30));
    expect(steps[0].clock).toBe(CLOCK_EPOCH_TICKS + 3 * TICKS_PER_SECOND);
    expect(steps[60]).toMatchObject({ index: 0, timestamp: 0, duration: 33_333, encode: true });
    expect(steps.filter((step) => step.encode).reduce((sum, step) => sum + step.duration, 0)).toBe(3_000_000);
    expect(stepper.Summary()).toEqual({ frames: 150, minStepTicks: 333_333, maxStepTicks: 333_334 });
    expect(stepper.Log()).toHaveLength(150);
    expect(stepper.Log()[0]).toEqual({ index: -60, clock: steps[0].clock, tick: 1 });
  });

  it('retries the same frame after a FrameTo that threw', () => {
    let fail = true;
    const targets: number[] = [];
    const stepper = new ExportStepper({
      time: {
        FrameTo: (target) => {
          targets.push(target);
          if (targets.length === 2 && fail) {
            fail = false;
            throw new Error('injected tick failure');
          }
          return target;
        }
      },
      world: { tick: 0 },
      grid: { origin: 0, fps: 10, preroll: 0, frames: 3 }
    });
    stepper.Next();
    expect(() => stepper.Next()).toThrow(/injected/);
    expect(stepper.index).toBe(1);
    expect(stepper.Next()?.index).toBe(1);
    expect(targets).toEqual([0, 1_000_000, 1_000_000]);
  });
});

describe('FrameTo (sd-export)', () => {
  /**
   * A world whose every Tick costs 100 ms of fake real time (Frame breaks at its 40 ms budget after one boundary) and
   * checks that master time moves at most one tick interval per call.
   */
  function SlowWorld() {
    const world = new DestinyWorld();
    world.AddShip(Ship('a', [0, 0, 0]), rifter);
    world.Order('a', { type: 'direction', direction: [1, 0, 0.4], speed: 1 });
    let real = 0;
    let maxEvolve = 0;
    const stepped = {
      get tick() {
        return world.tick;
      },
      get master() {
        return world.master;
      },
      OnBeforeBoundary: (listener: Parameters<DestinyWorld['OnBeforeBoundary']>[0]) => world.OnBeforeBoundary(listener),
      NextBoundaryTime: () => world.NextBoundaryTime(),
      Tick: (now: number) => {
        const before = Number(world.master.time);
        world.Tick(now);
        real += 100;
        if (before) maxEvolve = Math.max(maxEvolve, Number(world.master.time) - before);
      }
    };
    const clock = new SceneClock();
    const control = new TimeControl({ clock, world: stepped, realNow: () => real, budgetMs: 40 });
    const interval = (): number => world.master.tickInterval * TICKS_PER_MS;
    return { world, clock, control, interval, maxEvolve: () => maxEvolve };
  }

  it('reaches every target past the step budget, one evolve per Tick', () => {
    const { world, clock, control, interval, maxEvolve } = SlowWorld();
    control.Frame(0);
    control.BeginExport({ fps: 30 });
    const origin = clock.now;
    const start = world.tick;
    for (let index = 1; index <= 300; index++) {
      const target = origin + ExportFrameTicks(index, 30);
      expect(control.FrameTo(target)).toBe(target);
    }
    expect(world.tick).toBe(start + 10);
    // A leap of 5 s (the export's fast-forward when nothing is recorded to seek with) steps all 5 boundaries.
    expect(control.FrameTo(origin + 15 * TICKS_PER_SECOND)).toBe(origin + 15 * TICKS_PER_SECOND);
    expect(world.tick).toBe(start + 15);
    expect(maxEvolve()).toBe(interval());
    expect(() => control.FrameTo(origin)).toThrow(/an export frame never goes back/);
  });

  it('neither pauses nor stops at a StopAt inside the range', () => {
    const { clock, control } = SlowWorld();
    control.Frame(0);
    const origin = clock.now;
    let stopped = 0;
    control.StopAt(origin + 2 * TICKS_PER_SECOND, () => (stopped += 1));
    control.BeginExport({ fps: 30 });
    for (let index = 1; index <= 120; index++) control.FrameTo(origin + ExportFrameTicks(index, 30));
    expect(clock.now).toBe(origin + 4 * TICKS_PER_SECOND);
    expect(stopped).toBe(0);
    expect(control.Report()).toMatchObject({ state: 'exporting', paused: false });
    control.EndExport({ pause: false });
    // The stop is behind the clock now: the next frame drops it.
    control.Frame(10_000);
    expect(control.stopsAt).toBeNull();
    expect(stopped).toBe(0);
  });

  it('refuses outside an export', () => {
    const { clock, control } = SlowWorld();
    expect(() => control.FrameTo(clock.now)).toThrow(/BeginExport first/);
  });
});

/**
 * The script the oracle plays: cues at 0.5, 1, 3 and 8 s (a direction, an orbit, a goto and a warp) and ship c's script.
 */
const ORACLE_CUES: readonly SceneCue[] = [
  Cue('go', 0.5, 'a', Direction([1, 0, 0.2])),
  Cue('circle', 1, 'b', { type: 'orbit', target: 'a', range: 2500, speed: 1 } as ShipOrder),
  Cue('head', 3, 'b', { type: 'goto', point: [8000, 3000, -4000], speed: 1 } as ShipOrder),
  Cue('leave', 8, 'a', { type: 'warp', point: [0, 0, 2_000_000], range: 0 } as ShipOrder)
];
const ORACLE_END = 30;

interface RunLog {
  readonly states: Map<number, number[][]>;
  readonly boundaries: number[];
}

function Watch(world: DestinyWorld): RunLog & { readonly onTick: (tick: number) => void } {
  const states = new Map<number, number[][]>();
  const boundaries: number[] = [];
  world.OnBoundary((boundary) => boundaries.push(boundary));
  return { states, boundaries, onTick: (tick) => states.set(tick, BallStates(world, 'master', RIG_BALLS)) };
}

describe('an export is the 1× run, tick for tick (sd-export)', () => {
  it('at 24, 30 and 60 fps: the balls, the boundaries, every cue and the scripts', () => {
    const live = TimelineRig(ORACLE_CUES, SHIPS_A);
    const liveLog = Watch(live.world);
    live.RunTo(ORACLE_END, liveLog.onTick);
    const facts = live.Facts();
    expect(facts.cues.map(({ id, state }) => [id, state])).toEqual(ORACLE_CUES.map(({ id }) => [id, 'fired']));
    // 0.5 s fires on the boundary at 1 s, with the cue due then.
    expect(facts.cues.map(({ tick }) => (tick ?? 0) - (live.player.startTick ?? 0))).toEqual([1, 1, 3, 8]);
    for (const fps of [24, 30, 60]) {
      const rig = TimelineRig(ORACLE_CUES, SHIPS_A);
      const log = Watch(rig.world);
      let origin: number | null = null;
      const stepper = rig.ExportTo(ORACLE_END, fps, {
        onTick: log.onTick,
        onStep: (step) => {
          origin ??= step.clock;
          expect(step.clock).toBe(origin + ExportFrameTicks(step.index, fps));
        }
      });
      expect(rig.Facts(), `${fps} fps`).toEqual(facts);
      expect(log.boundaries, `${fps} fps`).toEqual(liveLog.boundaries);
      for (const [tick, states] of liveLog.states) expect(log.states.get(tick), `${fps} fps, tick ${tick}`).toEqual(states);
      const { minStepTicks, maxStepTicks } = stepper.Summary();
      expect([minStepTicks, maxStepTicks]).toEqual([Math.floor(TICKS_PER_SECOND / fps), Math.ceil(TICKS_PER_SECOND / fps)]);
      expect(rig.control.Report()).toMatchObject({ state: 'exporting', exportFps: fps });
    }
  });
});

describe('drawn attitudes sampled at 30 vs 60 Hz (sd-export)', () => {
  /**
   * The angle between two rotations, in degrees.
   */
  function AngleBetween(a: Quat, b: Quat): number {
    const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
    return (2 * Math.acos(dot) * 180) / Math.PI;
  }

  /**
   * A Rifter turning through four headings over 20 s, its drawn rotation sampled every frame at `fps`.
   *
   * @returns The rotation at each frame's clock.
   */
  function Fly(fps: number): Map<number, Quat> {
    const world = new DestinyWorld();
    world.AddShip(Ship('r', [0, 0, 0]), rifter);
    world.OnBeforeBoundary((boundary) => {
      if (boundary === 2) world.Order('r', { type: 'direction', direction: [1, 0, 0.3], speed: 1 });
      if (boundary === 7) world.Order('r', { type: 'direction', direction: [-0.4, 0.5, -1], speed: 1 });
      if (boundary === 12) world.Order('r', { type: 'direction', direction: [0, -1, 0.2], speed: 1 });
      if (boundary === 16) world.Order('r', { type: 'direction', direction: [1, 0.2, 1], speed: 1 });
    });
    const drawn = new Map<number, Quat>();
    for (let index = 0; index <= 22 * fps; index++) {
      const now = CLOCK_EPOCH_TICKS + ExportFrameTicks(index, fps);
      world.Tick(now);
      const curves = world.Curves('r');
      if (curves) drawn.set(now, curves.rotation.Update__Ticks(now, quat.create()));
    }
    return drawn;
  }

  it('stay within 0.5° at the shared times over 20 s of turns', () => {
    const at30 = Fly(30);
    const at60 = Fly(60);
    let gap = 0;
    let shared = 0;
    let turned = 0;
    let previous: Quat | null = null;
    for (const [now, rotation] of at30) {
      const twin = at60.get(now);
      if (!twin) continue;
      shared += 1;
      gap = Math.max(gap, AngleBetween(rotation, twin));
      if (previous) turned += AngleBetween(previous, rotation);
      previous = rotation;
    }
    expect(shared).toBe(22 * 30 + 1);
    // The ship really turned (646° in all), and the two samplings agree: 0.35° at most (measured 2026-10-24, sd-export).
    expect(turned).toBeGreaterThan(90);
    expect(gap).toBeLessThan(0.5);
    if (process.env['SD_EXPORT_MEASURE']) console.log(`drawn attitude gap 30 vs 60 Hz: ${gap.toFixed(4)}° max over ${shared} frames, ${turned.toFixed(0)}° turned`);
  });
});
