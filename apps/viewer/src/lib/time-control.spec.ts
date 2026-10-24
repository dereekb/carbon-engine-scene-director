import { describe, expect, it, vi } from 'vitest';
import { CLOCK_EPOCH_TICKS, SceneClock, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { BallStates, FRAME_TICKS, Harness, Ship, TFI } from './destiny.spec-helper';
import { ResolveFlight, type PublishedHull } from './flight';
import { ResolveShipPropMod } from './prop-mods';
import { ExportFrameTicks } from './export-frames';
import { EstimateBytes } from './state-capture';
import { EXPORT_LOCKED_TEXT, RateText, SceneSeconds, SceneTicks, TimeControl, TimeText, type LockedFrameResult, type TapeEntry, type TimeBeatEnd, type TimePresentation, type TimeSimPort } from './time-control';
import type { ShipOrder } from '@scene-director/scene';
import type { DestinySnapshot } from './destiny';

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
        get master() {
          return world.master;
        },
        OnBeforeBoundary: (listener: Parameters<DestinyWorld['OnBeforeBoundary']>[0]) => world.OnBeforeBoundary(listener),
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
    expect([world.BoundaryTime(1), world.BoundaryTime(0), world.BoundaryTime(4)]).toEqual([CLOCK_EPOCH_TICKS + TICKS_PER_SECOND, CLOCK_EPOCH_TICKS, CLOCK_EPOCH_TICKS + 4 * TICKS_PER_SECOND]);
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
      master: new DestinyWorld().master,
      OnBeforeBoundary: () => () => undefined,
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
    const base = { seconds: 3, tick: 4, back: 0, window: { seconds: 0, every: 5, window: 120, snapshots: 0, bytes: 0, budget: 1 }, recording: { on: true } };
    expect(TimeText({ ...base, rate: 1, paused: false, state: 'playing' })).toBe('1×');
    expect(TimeText({ ...base, rate: 0.25, paused: true, state: 'paused', audio: 'suspended' })).toBe('paused at 0.25×');
    expect(TimeText({ ...base, rate: 32, paused: false, state: 'playing', effectiveRate: 2.7, audio: 'muted' })).toBe('32× (2.7× actual) · muted');
    expect(TimeText({ ...base, rate: 1, paused: false, state: 'playing', back: 63.4 })).toBe('1× · back 63 s');
    expect(TimeText({ ...base, rate: 1, paused: false, state: 'playing', recording: { on: false, waiting: { builds: 3 } } })).toBe('1× · recording waits: 3 builds');
  });
});

/**
 * A page stand-in for the T2b specs: a TimeControl over a real world staged like the T1 spec, a fake sim port over
 * world.Snapshot / Restore whose tape replays `order` entries, 60 fps frames, and live commands between frames.
 */
function Rig({ every = 2, window = 120, settledFrom = 0 }: { every?: number; window?: number; settledFrom?: number } = {}) {
  const clock = new SceneClock();
  const world = new DestinyWorld();
  const control = new TimeControl({ clock, world, realNow: () => 0, windowConfig: { every, window } });
  Stage(world);
  const calls = { restores: 0, begins: 0, ends: 0, silent: 0, warm: 0, failRestore: false, divergent: false, origin: null as number | null };
  const replayed: TapeEntry[] = [];
  const port: TimeSimPort = {
    Capture: () => {
      const state = world.Snapshot();
      return { state, bytes: EstimateBytes(state) };
    },
    Restore: (state) => {
      calls.restores += 1;
      if (calls.failRestore) {
        calls.failRestore = false;
        throw new Error('injected restore failure');
      }
      world.Restore(state as DestinySnapshot);
    },
    Settled: () => ({ settled: world.tick >= settledFrom, waiting: { lookups: world.tick >= settledFrom ? 0 : 2, builds: 0 } }),
    Drift: (recorded, fresh) => (Buffer.from((recorded as DestinySnapshot).master.stream).equals(Buffer.from((fresh as DestinySnapshot).master.stream)) ? null : 'the master park differs'),
    Replay: (entry) => {
      replayed.push(entry);
      const { id, order } = entry.args as { id: string; order: ShipOrder };
      world.Order(id, calls.divergent && order.type === 'goto' ? { ...order, point: [order.point[0] + 9000, order.point[1], order.point[2]] } : order);
    },
    BeginJump: () => (calls.begins += 1),
    SilentFrame: () => (calls.silent += 1),
    WarmCurves: (time) => {
      calls.warm += 1;
      world.SampleCurves(time);
    },
    EndJump: () => (calls.ends += 1),
    TimelineOrigin: () => calls.origin
  };
  control.AttachSim(port);
  let ms = 0;
  const boundaryOf = new Map<number, number>();
  const Frame = () => {
    ms += 1000 / 60;
    control.Frame(ms);
  };
  /**
   * Plays frames until the world reaches a tick, calling back at every new tick.
   */
  const RunTo = (tick: number, onTick?: (tick: number) => void) => {
    for (let guard = 0; world.tick < tick && guard < 100_000; guard++) {
      const before = world.tick;
      Frame();
      if (world.tick !== before) {
        boundaryOf.set(world.tick, Number(world.master.time));
        onTick?.(world.tick);
      }
    }
  };
  const Frames = (count: number) => {
    for (let i = 0; i < count; i++) Frame();
  };
  /**
   * A live order between frames, journaled like the Director's wrapper does.
   */
  const Live = (id: string, order: ShipOrder) => {
    const mark = control.Mark();
    world.Order(id, order);
    control.Record(mark, 'order_ship', { id, order });
  };
  return { clock, world, control, port, calls, replayed, boundaryOf, RunTo, Frames, Live };
}

const TURN: ShipOrder = { type: 'direction', direction: [0, 1, 1], speed: 1 };
const GOTO: ShipOrder = { type: 'goto', point: [-9000, 2000, 6000], speed: 1 };

describe('TimeControl jumps (T2b)', () => {
  it('starts recording at the first settled tick, snapshots every `every`, and trims by window and budget', () => {
    const rig = Rig({ every: 2, window: 10, settledFrom: 4 });
    rig.RunTo(3);
    expect(rig.control.ring).toHaveLength(0);
    expect(rig.control.Report().recording).toEqual({ on: false, waiting: { lookups: 2 } });
    expect(() => rig.control.Jump(rig.clock.now - TICKS_PER_SECOND)).toThrow(/nothing is recorded yet: the scene is settling \(waiting for 2 lookups\)/);
    rig.RunTo(4);
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([4]);
    expect(rig.control.Report().recording).toMatchObject({ on: true, since: SceneSeconds(rig.boundaryOf.get(4) ?? 0) });
    rig.RunTo(30);
    // Every 2 s from tick 4, the window keeping 10 s before the latest.
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([20, 22, 24, 26, 28, 30]);
    const report = rig.control.Report();
    expect(report.window).toMatchObject({ seconds: 10, every: 2, window: 10, snapshots: 6 });
    expect(report.back).toBeCloseTo(10, 0);
    expect(report.earliest).toBe(SceneSeconds(rig.boundaryOf.get(20) ?? 0));
    // The budget drops the oldest first; one snapshot always stays.
    const one = rig.control.ring[0].bytes;
    rig.control.Configure({ budgetBytes: Math.floor(one * 2.5) });
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([28, 30]);
    rig.control.Configure({ budgetBytes: 1 });
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([30]);
  });

  it('a cut drops the ring and the tape, and recording comes back once the scene is settled', () => {
    const rig = Rig();
    rig.RunTo(6);
    rig.Frames(10);
    rig.Live('fc', TURN);
    expect(rig.control.journal).toHaveLength(1);
    const mark = rig.control.Mark();
    rig.control.Cut('patch_scene changed the ships');
    // A call that saw a cut is not journaled.
    rig.control.Record(mark, 'order_ship', { id: 'fc', order: TURN });
    expect(rig.control.ring).toHaveLength(0);
    expect(rig.control.journal).toHaveLength(0);
    expect(rig.control.Report()).toMatchObject({ back: 0, recording: { on: false, why: 'patch_scene changed the ships' } });
    rig.RunTo(7);
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([7]);
    expect(rig.control.Report().recording).toMatchObject({ on: true, why: 'patch_scene changed the ships' });
  });

  it('a jump back replays the first run tick for tick, its live commands included, and passes its snapshots without drift', () => {
    const rig = Rig({ every: 2 });
    const first = new Map<number, number[][]>();
    const record = (tick: number) => first.set(tick, BallStates(rig.world, 'master', BALLS));
    rig.RunTo(8, record);
    rig.Frames(20);
    rig.Live('fc', TURN);
    rig.RunTo(12, record);
    rig.Frames(10);
    const goClock = rig.clock.now;
    rig.Live('late', GOTO);
    rig.RunTo(30, record);
    expect(rig.control.journal.map(({ tick, done }) => [tick, done])).toEqual([
      [8, true],
      [12, true]
    ]);
    // Back to 0.3 s into tick 10: the latest snapshot at least 3 ticks before is tick 6 (every 2 from tick 2).
    const target = (rig.boundaryOf.get(10) ?? 0) + 0.3 * TICKS_PER_SECOND;
    const jump = rig.control.Jump(target);
    expect(jump).toMatchObject({ to: SceneSeconds(target), snapshot: 6, resimulated: 4 });
    expect(rig.world.tick).toBe(10);
    expect(rig.clock.now).toBe(target);
    expect(BallStates(rig.world, 'master', BALLS)).toEqual(first.get(10));
    expect(rig.calls).toMatchObject({ begins: 1, ends: 1, silent: 4, restores: 1 });
    expect(rig.calls.warm).toBeGreaterThanOrEqual(3 * 30);
    // The tick-8 command replayed during the re-simulation; the tick-12 one is the tape ahead.
    expect(rig.replayed.map(({ tick }) => tick)).toEqual([8]);
    expect(rig.control.Report()).toMatchObject({ latest: SceneSeconds(rig.boundaryOf.get(30) ?? 0), replay: { pending: 1, next: { tool: 'order_ship', seconds: SceneSeconds(goClock) } } });
    rig.RunTo(30, (tick) => expect(BallStates(rig.world, 'master', BALLS), `tick ${tick}`).toEqual(first.get(tick)));
    expect(rig.replayed.map(({ tick }) => tick)).toEqual([8, 12]);
    const report = rig.control.Report();
    expect(report.replay).toBeUndefined();
    expect(report.drift).toBeUndefined();
    expect(report.jump).toEqual(jump);
  });

  it('landing inside a tick runs the commands made before the target at once and the later ones at the boundary', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(12);
    rig.Frames(10);
    const madeAt = rig.clock.now;
    rig.Live('late', GOTO);
    rig.RunTo(20);
    rig.control.Jump(madeAt + TICKS_PER_SECOND / 10);
    expect(rig.replayed).toHaveLength(1);
    expect(rig.control.Report().replay).toBeUndefined();
    rig.control.Jump(madeAt - TICKS_PER_SECOND / 10);
    expect(rig.replayed).toHaveLength(1);
    expect(rig.control.Report().replay).toMatchObject({ pending: 1 });
    expect(rig.world.tick).toBe(12);
    rig.RunTo(13);
    expect(rig.replayed).toHaveLength(2);
    expect(rig.control.Report().replay).toBeUndefined();
  });

  it('reports timeline seconds once the timeline started, and seeks by them', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(12);
    expect(rig.control.Report().timeline).toBeUndefined();
    expect(() => rig.control.Command({ seek: { timeline: 1 } })).toThrow(/needs a scripted timeline that has started/u);
    rig.calls.origin = rig.boundaryOf.get(6) ?? 0;
    rig.RunTo(16);
    expect(rig.control.Report().timeline).toBeCloseTo(10, 1);
    rig.control.Command({ seek: { timeline: 3.5 } });
    const report = rig.control.Report();
    expect(report.timeline).toBe(3.5);
    expect(rig.clock.now).toBe((rig.boundaryOf.get(6) ?? 0) + 3.5 * TICKS_PER_SECOND);
    expect(rig.world.tick).toBe(9);
  });

  it('a new live command abandons the recorded future: the tape ahead and the later snapshots', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(12);
    rig.Frames(10);
    rig.Live('late', GOTO);
    rig.RunTo(24);
    rig.control.Jump(rig.boundaryOf.get(9) ?? 0);
    expect(rig.control.Report().replay).toMatchObject({ pending: 1 });
    rig.Frames(10);
    rig.Live('fc', TURN);
    expect(rig.control.journal.map(({ tick }) => tick)).toEqual([9]);
    expect(rig.control.ring.every(({ tick }) => tick <= 9)).toBe(true);
    const report = rig.control.Report();
    expect(report.replay).toBeUndefined();
    expect(report.latest).toBe(report.seconds);
    rig.RunTo(16);
    expect(rig.replayed).toHaveLength(0);
  });

  it('detects drift when a replay differs from the recorded run, and keeps the replay as the truth', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(12);
    rig.Frames(10);
    rig.Live('late', GOTO);
    rig.RunTo(24);
    rig.calls.divergent = true;
    rig.control.Jump(rig.boundaryOf.get(10) ?? 0);
    rig.RunTo(16);
    const drift = rig.control.Report().drift;
    expect(drift).toMatchObject({ count: 1, tick: 14, summary: 'the master park differs' });
    // The abandoned run's later snapshots went; the replay's own replaced tick 14.
    expect(rig.control.ring.at(-1)?.tick).toBe(16);
  });

  it('a failing snapshot cuts the window and the world ticks on', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(6);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const capture = vi.spyOn(rig.world, 'Snapshot').mockImplementation(() => {
      throw new Error('a function at .ships.a.cb');
    });
    rig.RunTo(9);
    expect(rig.world.tick).toBe(9);
    expect(rig.control.Report().recording).toMatchObject({ on: false, why: 'a snapshot failed: a function at .ships.a.cb' });
    capture.mockRestore();
    error.mockRestore();
    rig.RunTo(10);
    expect(rig.control.Report().recording.on).toBe(true);
  });

  it('a failed restore leaves the scene as it was', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(16);
    rig.Frames(7);
    const before = { tick: rig.world.tick, clock: rig.clock.now, states: BallStates(rig.world, 'master', BALLS), ring: rig.control.ring.length };
    rig.calls.failRestore = true;
    expect(() => rig.control.Jump(rig.boundaryOf.get(10) ?? 0)).toThrow('the jump failed and the scene is as it was: injected restore failure');
    expect({ tick: rig.world.tick, clock: rig.clock.now, states: BallStates(rig.world, 'master', BALLS), ring: rig.control.ring.length }).toEqual(before);
    expect(rig.calls).toMatchObject({ restores: 2, begins: 1, ends: 1 });
    expect(rig.control.Report().state).toBe('playing');
    rig.control.Jump(rig.boundaryOf.get(10) ?? 0);
    expect(rig.world.tick).toBe(10);
  });

  it('clamps a jump before the window with a warning, seeks forward silently, refuses while held, and runs a command in order', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(12);
    const earliest = rig.control.ring[0];
    const clamped = rig.control.Jump(CLOCK_EPOCH_TICKS);
    expect(clamped.warnings?.[0]).toMatch(/^only \d+\.\d s is recorded: jumped back to \d+\.\d s$/);
    expect(rig.world.tick).toBe(earliest.tick);
    expect(rig.clock.now).toBe(earliest.clock);
    // Forward past the recorded end: simulated silently, recording as it goes.
    const end = rig.control.Report().latest ?? 0;
    rig.control.Jump(SceneTicks(end + 6));
    expect(rig.control.Report().latest).toBe(end + 6);
    expect(rig.control.ring.at(-1)?.tick).toBeGreaterThan(12);
    rig.clock.Hold();
    expect(() => rig.control.Jump(rig.clock.now - TICKS_PER_SECOND)).toThrow(/holds the clock/);
    rig.clock.Release();
    const seconds = rig.control.Report().seconds;
    expect(rig.control.Command({ back: 3, rate: 0.25, pause: true })).toEqual([]);
    expect(rig.control.Report()).toMatchObject({ seconds: seconds - 3, rate: 0.25, paused: true });
    expect(rig.control.Command({ seek: seconds - 3 })).toEqual(['already there: nothing to do']);
    expect(TimeText(rig.control.Report())).toMatch(/^paused at 0\.25× · back \d+ s · 3 s recorded ahead$/);
  });
});

describe('TimeControl script edits (Movie mode M3)', () => {
  /**
   * The ring's snapshot ticks by state, for an accept test that reads a snapshot's tick.
   */
  const TickOf = (rig: ReturnType<typeof Rig>) => new Map(rig.control.ring.map((snapshot) => [snapshot.state, snapshot.tick]));

  it('Resimulate restores the latest passing snapshot, drops the later ones, replays the tape after it and lands at now', () => {
    const fresh = Rig({ every: 2 });
    fresh.RunTo(10);
    fresh.world.Order('late', GOTO);
    fresh.RunTo(12);
    fresh.Frames(10);
    fresh.Live('fc', TURN);
    fresh.RunTo(20);

    const rig = Rig({ every: 2 });
    rig.RunTo(12);
    rig.Frames(10);
    rig.Live('fc', TURN);
    rig.RunTo(20);
    rig.Frames(5);
    const now = rig.clock.now;
    const later = rig.control.ring.filter(({ tick }) => tick > 10);
    const tickOf = TickOf(rig);
    const restored: unknown[] = [];
    const run = rig.control.Resimulate({
      accept: (state) => (tickOf.get(state) ?? Infinity) <= 10,
      restored: (state) => {
        restored.push(tickOf.get(state));
        rig.world.Order('late', GOTO);
      },
      edit: { cues: 1, ships: 0 }
    });
    expect(run?.snapshot.tick).toBe(10);
    expect(run?.report).toMatchObject({ from: SceneSeconds(now), to: SceneSeconds(now), snapshot: 10, resimulated: 10, cause: 'edit', edit: { cues: 1, ships: 0 } });
    expect(restored).toEqual([10]);
    expect(rig.world.tick).toBe(20);
    expect(rig.clock.now).toBe(now);
    expect(rig.replayed.map(({ tick }) => tick)).toEqual([12]);
    expect(BallStates(rig.world, 'master', BALLS)).toEqual(BallStates(fresh.world, 'master', BALLS));
    // The old run's later snapshots went; the re-simulation took its own on the grid.
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    for (const snapshot of rig.control.ring.filter(({ tick }) => tick > 10)) expect(later).not.toContain(snapshot);
    expect(rig.control.Report().jump).toEqual(run?.report);
  });

  it('Resimulate prefers a snapshot WARMUP_TICKS back, returns null when none passes, refuses like a jump and undoes a failure', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(20);
    const tickOf = TickOf(rig);
    // The latest passing (20 is now) is 18, within the warm-up; 16 is the latest at least 3 ticks back.
    expect(rig.control.Resimulate({ accept: () => true, restored: () => undefined })?.snapshot.tick).toBe(16);
    expect(rig.control.Resimulate({ accept: (state) => tickOf.get(state) === 2, restored: () => undefined })?.snapshot.tick).toBe(2);
    expect(rig.control.Resimulate({ accept: () => false, restored: () => undefined })).toBeNull();
    rig.clock.Hold();
    expect(() => rig.control.Resimulate({ accept: () => true, restored: () => undefined })).toThrow(/holds the clock/);
    rig.clock.Release();
    const before = { tick: rig.world.tick, clock: rig.clock.now, states: BallStates(rig.world, 'master', BALLS), ring: rig.control.ring.map(({ tick }) => tick) };
    rig.calls.failRestore = true;
    expect(() => rig.control.Resimulate({ accept: () => true, restored: () => undefined })).toThrow('the re-simulation failed and the scene is as it was: injected restore failure');
    expect({ tick: rig.world.tick, clock: rig.clock.now, states: BallStates(rig.world, 'master', BALLS), ring: rig.control.ring.map(({ tick }) => tick) }).toEqual(before);
    const empty = Rig({ settledFrom: 100 });
    empty.RunTo(4);
    expect(() => empty.control.Resimulate({ accept: () => true, restored: () => undefined })).toThrow(/nothing is recorded yet/);
  });

  it('the origin is pinned through the window and a byte budget of one snapshot, a cut drops it, and it starts recording when settled', () => {
    const rig = Rig({ every: 2, window: 10 });
    rig.RunTo(3);
    rig.Frames(10);
    expect(rig.control.MarkOrigin()).toBe(true);
    expect(rig.control.ring.find(({ pinned }) => pinned)).toMatchObject({ tick: 3, clock: rig.boundaryOf.get(3) });
    rig.RunTo(30);
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([3, 20, 22, 24, 26, 28, 30]);
    rig.control.Configure({ budgetBytes: 1 });
    expect(rig.control.ring.map(({ tick }) => tick)).toEqual([3, 30]);
    expect(rig.control.Report().earliest).toBe(SceneSeconds(rig.boundaryOf.get(3) ?? 0));
    // A jump to 5 restores the origin, 27 ticks back.
    expect(rig.control.Jump(rig.boundaryOf.get(5) ?? 0)).toMatchObject({ snapshot: 3, resimulated: 2 });
    rig.control.Cut('a scene was loaded');
    expect(rig.control.ring).toHaveLength(0);
    // Off and settled: the origin starts recording at once.
    expect(rig.control.MarkOrigin()).toBe(true);
    expect(rig.control.Report().recording).toMatchObject({ on: true });
    expect(rig.control.ring.map(({ tick, pinned }) => [tick, pinned])).toEqual([[5, true]]);
    const settling = Rig({ settledFrom: 100 });
    settling.RunTo(4);
    expect(settling.control.MarkOrigin()).toBe(false);
  });

  it('restoring the origin replays only the tape entries of its tick made after it', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(5);
    rig.Frames(5);
    rig.Live('fc', TURN);
    rig.control.MarkOrigin();
    rig.Frames(5);
    rig.Live('late', GOTO);
    rig.RunTo(12);
    // Landing at 8: the latest snapshot at least 3 ticks back is the origin at 5.
    expect(rig.control.Jump(rig.boundaryOf.get(8) ?? 0)).toMatchObject({ snapshot: 5 });
    expect(rig.replayed.map(({ tick, args }) => [tick, (args as { id: string }).id])).toEqual([[5, 'late']]);
  });

  it('AbandonFuture drops the snapshots and the tape after now, and the recorded end becomes now', () => {
    const rig = Rig({ every: 2 });
    rig.RunTo(12);
    rig.Frames(10);
    rig.Live('late', GOTO);
    rig.RunTo(24);
    rig.control.Jump(rig.boundaryOf.get(9) ?? 0);
    expect(rig.control.Report().replay).toMatchObject({ pending: 1 });
    rig.control.AbandonFuture();
    expect(rig.control.ring.every(({ tick }) => tick <= 9)).toBe(true);
    expect(rig.control.journal).toHaveLength(0);
    const report = rig.control.Report();
    expect(report.replay).toBeUndefined();
    expect(report.latest).toBe(report.seconds);
  });
});

describe('TimeControl StopAt (Movie mode M5)', () => {
  for (const rate of [1, 32]) {
    it(`rests exactly at the stop at ${rate}×, pauses once, then plays on past it`, () => {
      const { clock, world, control, Frames } = Rig();
      control.SetRate(rate);
      Frames(2);
      const stop = world.BoundaryTime(world.tick + 6) ?? 0;
      let stopped = 0;
      control.StopAt(stop, () => (stopped += 1));
      expect(control.stopsAt).toBe(stop);
      Frames(rate === 1 ? 600 : 60);
      expect(clock.now).toBe(stop);
      // The stop's own boundary ran: its cues fired.
      expect(Number(world.master.time)).toBe(stop);
      expect(control.paused).toBe(true);
      expect(stopped).toBe(1);
      expect(control.stopsAt).toBeNull();
      const tick = world.tick;
      control.Pause(false);
      Frames(120);
      expect(world.tick).toBeGreaterThan(tick);
      expect(stopped).toBe(1);
    });
  }

  it('is ignored by jumps: a jump past it drops it, one back keeps it', () => {
    const { clock, world, control, RunTo, Frames } = Rig();
    RunTo(12);
    control.StopAt(world.BoundaryTime(world.tick + 4));
    const past = world.BoundaryTime(world.tick + 8) ?? 0;
    control.Jump(past);
    expect(clock.now).toBe(past);
    expect(control.paused).toBe(false);
    Frames(2);
    expect(control.stopsAt).toBeNull();
    expect(control.paused).toBe(false);
    const stop = world.BoundaryTime(world.tick + 3) ?? 0;
    control.StopAt(stop);
    control.Jump(clock.now - 4 * TICKS_PER_SECOND);
    expect(control.stopsAt).toBe(stop);
    Frames(600);
    expect(clock.now).toBe(stop);
    expect(control.paused).toBe(true);
  });
});

describe('TimeControl export mode (sd-export)', () => {
  it('refuses to begin during a jump, while the timeline holds the clock and during another export', () => {
    const { clock, control, port, RunTo } = Rig();
    RunTo(10);
    let refusal = '';
    control.AttachSim({
      ...port,
      SilentFrame: () => {
        if (refusal) return;
        try {
          control.BeginExport();
        } catch (error) {
          refusal = (error as Error).message;
        }
      }
    });
    control.Jump(clock.now - 4 * TICKS_PER_SECOND);
    expect(refusal).toMatch(/a jump is running/);
    expect(control.exporting).toBe(false);
    clock.Hold();
    expect(() => control.BeginExport()).toThrow(/the timeline holds the clock while its scene prepares/);
    clock.Release();
    control.BeginExport();
    expect(() => control.BeginExport()).toThrow(/already running/);
  });

  it("locks the user's time controls, steps nothing in Frame and reports exporting", () => {
    const { clock, world, control, RunTo, Frames } = Rig();
    RunTo(10);
    control.Pause(true);
    control.BeginExport({ fps: 30 });
    expect(control.paused).toBe(false);
    const now = clock.now;
    const tick = world.tick;
    Frames(120);
    expect([clock.now, world.tick]).toEqual([now, tick]);
    for (const call of [() => control.Command({ pause: true }), () => control.Command({ back: 2 }), () => control.Jump(now - TICKS_PER_SECOND), () => control.Pause(true), () => control.SetRate(2), () => control.Resimulate({ accept: () => true, restored: () => undefined })]) {
      expect(call).toThrow(EXPORT_LOCKED_TEXT);
    }
    const report = control.Report();
    expect(report).toMatchObject({ state: 'exporting', paused: false, exportFps: 30, rate: 1 });
    expect(TimeText(report)).toBe('exporting · 1/30 s a frame');
    // Not refused: the cut, the origin and recording.
    expect(() => control.Mark()).not.toThrow();
  });

  it('pauses at the end, and the first live frame after it does not count the export as a frame', () => {
    const { clock, control, RunTo } = Rig();
    RunTo(10);
    control.BeginExport({ fps: 30 });
    const origin = clock.now;
    for (let index = 1; index <= 90; index++) control.FrameTo(origin + ExportFrameTicks(index, 30));
    control.EndExport();
    expect(control.Report()).toMatchObject({ state: 'paused', paused: true });
    expect(control.Report()).not.toHaveProperty('exportFps');
    expect(clock.now).toBe(origin + 3 * TICKS_PER_SECOND);
    control.Pause(false);
    // A minute of real time went by during the export: the first frame targets now, the next one moves a frame.
    control.Frame(60_000);
    expect(clock.now).toBe(origin + 3 * TICKS_PER_SECOND);
    control.Frame(60_000 + 1000 / 60);
    expect(clock.now).toBe(origin + 3 * TICKS_PER_SECOND + Math.round(TICKS_PER_SECOND / 60));
    control.EndExport();
    expect(control.paused).toBe(false);
  });

  it('records snapshots on the grid during an export, and the run is scrubbable after', () => {
    const { clock, world, control, RunTo } = Rig({ every: 2 });
    RunTo(5);
    const start = control.ring[0].tick;
    control.BeginExport({ fps: 30 });
    const origin = clock.now;
    for (let index = 1; world.tick < 16; index++) control.FrameTo(origin + ExportFrameTicks(index, 30));
    const ticks = control.ring.map((snapshot) => snapshot.tick);
    expect(ticks.filter((tick) => tick > 5)).toEqual([6, 8, 10, 12, 14, 16].filter((tick) => (tick - start) % 2 === 0 && tick <= world.tick));
    expect(control.Report().latest).toBe(SceneSeconds(clock.now));
    control.EndExport();
    control.Command({ back: 6 });
    expect(world.tick).toBeLessThan(16);
  });
});

/**
 * A Rig at tick 4 under a frame lock at `fps`, with its own frame timestamps (the first locked frame counts no real time).
 */
function LockRig(fps: number, options: Parameters<typeof Rig>[0] = {}) {
  const rig = Rig(options);
  rig.RunTo(4);
  rig.clock.Resync();
  rig.control.SetFrameLock(fps);
  let ms = 1_000_000;
  const Locked = (frameMs = 1000 / 60): LockedFrameResult => {
    ms += frameMs;
    return rig.control.LockedFrame(ms);
  };
  return { ...rig, Locked };
}

describe('TimeControl frame lock (sd-time)', () => {
  it('steps a grid frame every other 60 Hz frame at 30 fps, wall time equal to scene time', () => {
    const { clock, control, Locked } = LockRig(30);
    const start = clock.now;
    expect(Locked()).toEqual({ kind: 'grid', clock: start, index: 0 });
    const kinds: string[] = [];
    let previous = start;
    for (let frame = 0; frame < 600; frame++) {
      const result = Locked();
      kinds.push(result.kind);
      if (result.kind === 'grid') {
        expect([333_333, 333_334]).toContain(result.clock - previous);
        previous = result.clock;
      } else expect(result).toEqual({ kind: 'wait', clock: previous });
    }
    expect(kinds.filter((kind) => kind === 'grid')).toHaveLength(300);
    expect(clock.now - start).toBe(10 * TICKS_PER_SECOND);
    expect(control.Report()).toMatchObject({ lock: { fps: 30, by: 'time_control' } });
    expect(control.Report().effectiveRate).toBeUndefined();
    expect(TimeText(control.Report())).toMatch(/^1× · 30 fps lock( · back \d+ s)?$/u);
  });

  it('steps one grid frame a 300 ms frame, and reports the slowdown', () => {
    const { clock, control, Locked } = LockRig(30);
    const start = clock.now;
    for (let frame = 0; frame <= 40; frame++) expect(Locked(300)).toEqual({ kind: 'grid', clock: start + ExportFrameTicks(frame, 30), index: frame });
    expect(control.effectiveRate).toBeCloseTo(1 / 9, 2);
    expect(TimeText(control.Report())).toMatch(/^1× · 30 fps lock \(0\.11× actual\)( · back \d+ s)?$/u);
  });

  it('never steps two grid frames in one call, and never pays back a slow spell', () => {
    const { clock, Locked } = LockRig(10);
    const start = clock.now;
    Locked();
    // A 5 s stall counts 1 s (MAX_FRAME_STEP_MS): one grid frame, then the one frame owed, then the pacing goes on.
    expect(Locked(5000)).toEqual({ kind: 'grid', clock: start + TICKS_PER_SECOND / 10, index: 1 });
    expect(Locked()).toMatchObject({ kind: 'grid', index: 2 });
    const kinds = Array.from({ length: 11 }, () => Locked().kind);
    expect(kinds).toEqual(['wait', 'wait', 'wait', 'wait', 'grid', 'wait', 'wait', 'wait', 'wait', 'wait', 'grid']);
  });

  it('holds while paused or held, and owes nothing for those frames', () => {
    const { clock, control, Locked } = LockRig(30);
    Locked();
    Locked();
    Locked();
    const at = clock.now;
    control.Pause(true);
    for (let i = 0; i < 30; i++) expect(Locked()).toEqual({ kind: 'hold', clock: at });
    control.Pause(false);
    clock.Hold();
    for (let i = 0; i < 30; i++) expect(Locked()).toEqual({ kind: 'hold', clock: at });
    clock.Release();
    expect(Locked()).toEqual({ kind: 'wait', clock: at });
    expect(Locked()).toMatchObject({ kind: 'grid', clock: at + 333_334 });
  });

  it('stops at an off-grid StopAt, then resumes onto the same grid', () => {
    const { clock, control, Locked } = LockRig(10);
    const start = clock.now;
    Locked();
    const stop = start + 5_500_000;
    let stopped = 0;
    control.StopAt(stop, () => (stopped += 1));
    const results: LockedFrameResult[] = [];
    for (let i = 0; i < 100 && !control.paused; i++) results.push(Locked());
    expect(results.at(-1)).toEqual({ kind: 'hold', clock: stop });
    expect(results.filter((result) => result.kind === 'grid').map((result) => result.clock)).toEqual([1, 2, 3, 4, 5].map((k) => start + k * 1_000_000));
    expect([clock.now, control.paused, stopped, control.stopsAt]).toEqual([stop, true, 1, null]);
    control.Pause(false);
    expect(Locked()).toEqual({ kind: 'grid', clock: start + 6_000_000, index: 6 });
  });

  it('re-anchors at a jump landing: its grid frame 0 draws at once', () => {
    const { clock, control, Locked } = LockRig(30);
    for (let i = 0; i < 600; i++) Locked();
    control.Command({ back: 4 });
    const landing = clock.now;
    expect(Locked()).toEqual({ kind: 'grid', clock: landing, index: 0 });
    expect(Locked()).toEqual({ kind: 'grid', clock: landing + 333_333, index: 1 });
    expect(Locked()).toEqual({ kind: 'wait', clock: landing + 333_333 });
  });

  it('unlocks, refuses an fps out of bounds, and is refused during an export', () => {
    const { control } = LockRig(30);
    expect(control.frameLock).toBe(30);
    control.Command({ fps: false });
    expect(control.frameLock).toBeNull();
    expect(control.Report()).not.toHaveProperty('lock');
    for (const fps of [0, 121, 2.5]) expect(() => control.SetFrameLock(fps)).toThrow(RangeError);
    control.BeginExport({ fps: 30 });
    expect(() => control.Command({ fps: 10 })).toThrow(EXPORT_LOCKED_TEXT);
  });
});

describe('TimeControl beats (sd-time)', () => {
  it('plays N scene seconds, pauses exactly there, and reports the beat until then', () => {
    const { clock, control, RunTo, Frames } = Rig();
    RunTo(3);
    control.Pause(true);
    const from = clock.now;
    const ends: TimeBeatEnd[] = [];
    control.PlayFor(2.5, (end) => ends.push(end));
    expect(control.paused).toBe(false);
    expect(control.Report().play).toEqual({ stopsAt: SceneSeconds(from + 25_000_000), stopsIn: 2.5 });
    expect(TimeText(control.Report())).toMatch(/^1× · beat ends in 2\.5 s( · back \d+ s)?$/u);
    Frames(600);
    expect([clock.now, control.paused]).toEqual([from + 25_000_000, true]);
    expect(ends).toEqual([{ endedBy: 'played', played: 2.5, wallSeconds: 0 }]);
    expect(control.Report()).not.toHaveProperty('play');
  });

  it('with the movie end armed too: the earlier stop wins, and each fires its own callback', () => {
    const { clock, control, RunTo, Frames } = Rig();
    RunTo(3);
    let movie = 0;
    const ends: TimeBeatEnd[] = [];
    let from = clock.now;
    control.StopAt(from + TICKS_PER_SECOND, () => (movie += 1));
    control.PlayFor(3, (end) => ends.push(end));
    Frames(600);
    expect([clock.now, movie]).toEqual([from + TICKS_PER_SECOND, 1]);
    expect(ends).toEqual([{ endedBy: 'paused', played: 1, wallSeconds: 0 }]);
    from = clock.now;
    control.StopAt(from + 3 * TICKS_PER_SECOND, () => (movie += 1));
    control.PlayFor(1, (end) => ends.push(end));
    Frames(600);
    expect([clock.now, movie, ends.at(-1)?.endedBy]).toEqual([from + TICKS_PER_SECOND, 1, 'played']);
    expect(control.stopsAt).toBe(from + 3 * TICKS_PER_SECOND);
    control.Pause(false);
    Frames(600);
    expect([clock.now, movie, control.paused]).toEqual([from + 3 * TICKS_PER_SECOND, 2, true]);
  });

  it('keeps a beat when the movie stop is re-armed or cleared', () => {
    const { clock, control, RunTo, Frames } = Rig();
    RunTo(3);
    const from = clock.now;
    const ends: TimeBeatEnd[] = [];
    control.PlayFor(2, (end) => ends.push(end));
    control.StopAt(from + 9 * TICKS_PER_SECOND);
    control.StopAt(null);
    expect(control.stopsAt).toBe(from + 2 * TICKS_PER_SECOND);
    Frames(600);
    expect([clock.now, ends.at(-1)?.endedBy]).toEqual([from + 2 * TICKS_PER_SECOND, 'played']);
  });

  it('lands exactly on its clock under the frame lock, on the grid or off it', () => {
    const { clock, control, Locked } = LockRig(30);
    Locked();
    const ends: TimeBeatEnd[] = [];
    for (const seconds of [2, 0.55]) {
      const from = clock.now;
      control.PlayFor(seconds, (end) => ends.push(end));
      for (let i = 0; i < 1000 && !control.paused; i++) Locked();
      expect(clock.now).toBe(from + Math.round(seconds * TICKS_PER_SECOND));
    }
    expect(ends.map(({ endedBy, played }) => [endedBy, played])).toEqual([
      ['played', 2],
      ['played', 0.55]
    ]);
  });

  it('ends at a pause, a jump, a new beat and an export, each with its why, and clears its stop', () => {
    const { clock, control, RunTo, Frames } = Rig();
    RunTo(10);
    const ends: TimeBeatEnd[] = [];
    control.PlayFor(5, (end) => ends.push(end));
    control.Command({ pause: true });
    expect(ends.at(-1)?.endedBy).toBe('paused');
    control.PlayFor(5, (end) => ends.push(end));
    Frames(60);
    control.Command({ back: 2 });
    expect(ends.at(-1)).toEqual({ endedBy: 'jump', played: 1, wallSeconds: 0 });
    expect([control.stopsAt, control.paused]).toEqual([null, false]);
    control.PlayFor(5, (end) => ends.push(end));
    control.PlayFor(1, (end) => ends.push(end));
    expect(ends.at(-1)?.endedBy).toBe('replaced');
    expect(control.stopsAt).toBe(clock.now + TICKS_PER_SECOND);
    control.BeginExport({ fps: 30 });
    expect(ends.at(-1)?.endedBy).toBe('export');
    expect(control.stopsAt).toBeNull();
    expect(() => control.PlayFor(1, () => undefined)).toThrow(EXPORT_LOCKED_TEXT);
    expect(ends).toHaveLength(4);
  });
});
