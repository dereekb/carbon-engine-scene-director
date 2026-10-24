/**
 * The timeline rig the Movie mode and movie export specs share (movie.spec.ts, export-frames.spec.ts): a page stand-in
 * with a real world, TimeControl and TimelinePlayer. It imports no vitest, so the app's tsconfig may include it;
 * `expect` stays in the specs.
 */

import { cueActionOf, type SceneCue, type SceneShipStep, type ShipOrder } from '@scene-director/scene';
import { SceneClock } from './clock';
import { DestinyWorld, type DestinySnapshot } from './destiny';
import { BallStates, Ship } from './destiny.spec-helper';
import { ExportStepper, type ExportStep } from './export-frames';
import { ResolveFlight, type PublishedHull } from './flight';
import { ShipScripts, type ScriptedShip } from './ship-scripts';
import { EstimateBytes } from './state-capture';
import { TimeControl, type TimeResimulation } from './time-control';
import { TimelinePlayer, type TimelineSnapshot } from './timeline';

const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null });
/**
 * The rig's ship balls: a, b and c.
 */
export const RIG_BALLS = 3;

interface RigState {
  readonly world: DestinySnapshot;
  readonly timeline: TimelineSnapshot;
  readonly ships: readonly ScriptedShip[];
}

export function Direction(direction: [number, number, number]): ShipOrder {
  return { type: 'direction', direction, speed: 1 } as ShipOrder;
}

export function Cue(id: string, at: number, ship: string, order: ShipOrder): SceneCue {
  return { id, at, order_ship: { id: ship, order } } as SceneCue;
}

/**
 * A page stand-in: a real world, TimeControl and TimelinePlayer with ShipScripts, cues that order ships in the world, a
 * sim port that captures the world, the player and the ships' orders (the live scene), 60 fps frames, and the director's
 * script-edit path (Edit). ExportTo drives it as a movie export does instead (sd-export).
 */
export function TimelineRig(cues: readonly SceneCue[], ships: readonly ScriptedShip[]) {
  const clock = new SceneClock();
  const world = new DestinyWorld();
  const control = new TimeControl({ clock, world, realNow: () => 0, windowConfig: { every: 2 } });
  world.AddShip(Ship('a', [0, 0, 0]), rifter);
  world.AddShip(Ship('b', [5000, 0, 0]), rifter);
  world.AddShip(Ship('c', [0, 5000, 0]), rifter);
  let live: readonly ScriptedShip[] = ships;
  // The authored script: a jump restoring an older snapshot brings it in (AfterRestore).
  let script = { cues, ships };
  const player = new TimelinePlayer({
    port: {
      Fire: (cue) => {
        const { args } = cueActionOf(cue) as { args: { id: string; order: ShipOrder } };
        world.Order(args.id, args.order);
        return { state: 'fired' };
      },
      Settled: () => ({ settled: true, waiting: {} }),
      HoldClock: (held) => (held ? clock.Hold() : clock.Release()),
      Now: () => 0
    },
    scripts: new ShipScripts({
      Order: (id, order) => {
        world.Order(id, order as ShipOrder);
        return world.Motion(id)?.pendingOrder ?? order;
      },
      Motion: (id) => world.Motion(id),
      Alive: () => true,
      Arriving: (id) => world.Arriving(id),
      InWarp: (id) => world.InWarp(id)
    })
  });
  // After TimeControl's tape listener, as in the page.
  world.OnBeforeBoundary((boundary, time) => player.Boundary(boundary, time, live));
  control.AttachSim({
    Capture: () => {
      const state: RigState = { world: world.Snapshot(), timeline: player.Snapshot(), ships: live };
      return { state, bytes: EstimateBytes(state) };
    },
    Restore: (state) => {
      const rig = state as RigState;
      world.Restore(rig.world);
      player.Restore(rig.timeline);
      live = rig.ships;
    },
    AfterRestore: () => {
      if (!player.Accepts(script.cues, script.ships, { previous: live })) return;
      live = script.ships;
      player.Rescript(script.cues, live);
    },
    Settled: () => ({ settled: true, waiting: {} }),
    Drift: () => null,
    Replay: () => undefined,
    BeginJump: () => undefined,
    SilentFrame: () => undefined,
    WarmCurves: (time) => world.SampleCurves(time),
    EndJump: () => undefined,
    TimelineOrigin: () => (player.startTick == null ? null : world.BoundaryTime(player.startTick))
  });
  /**
   * The player's frame: the prepare ends, and the timeline's origin is pinned when it starts playing.
   */
  const PlayerFrame = () => {
    const before = player.state;
    player.Frame();
    if (before !== 'playing' && player.state === 'playing' && player.startTick == null) control.MarkOrigin();
  };
  let ms = 0;
  /**
   * Live play at 60 fps until the world reaches a tick, calling back at every new tick.
   */
  const RunTo = (tick: number, onTick?: (tick: number) => void) => {
    for (let guard = 0; world.tick < tick && guard < 100_000; guard++) {
      ms += 1000 / 60;
      const before = world.tick;
      PlayerFrame();
      control.Frame(ms);
      if (world.tick !== before) onTick?.(world.tick);
    }
  };
  // The page ran before the load: the tick grid exists when the timeline starts.
  RunTo(3);
  player.Load(cues, true);
  /**
   * A movie export from where the rig is (sd-export): the prepare ends without stepping the clock, then an export grid
   * from now at `fps` is stepped until the world reaches a tick, calling back at every new tick and every step.
   *
   * @returns The stepper.
   */
  const ExportTo = (tick: number, fps: number, { onTick, onStep }: { readonly onTick?: (tick: number) => void; readonly onStep?: (step: ExportStep) => void } = {}): ExportStepper => {
    PlayerFrame();
    control.BeginExport({ fps });
    const stepper = new ExportStepper({ time: control, world, grid: { origin: clock.now, fps, preroll: 0, frames: 1_000_000 } });
    for (let guard = 0; world.tick < tick && guard < 1_000_000; guard++) {
      const before = world.tick;
      PlayerFrame();
      const step = stepper.Next();
      if (!step) break;
      onStep?.(step);
      if (world.tick !== before) onTick?.(world.tick);
    }
    return stepper;
  };
  /**
   * Live play under the frame lock at `fps` (sd-time), frames `frameMs` apart, until the world reaches a tick, calling
   * back at every new tick and every grid frame.
   */
  const LockTo = (tick: number, fps: number, frameMs: number, { onTick, onGrid }: { readonly onTick?: (tick: number) => void; readonly onGrid?: (clock: number, index: number) => void } = {}) => {
    control.SetFrameLock(fps);
    for (let guard = 0; world.tick < tick && guard < 1_000_000; guard++) {
      ms += frameMs;
      const before = world.tick;
      PlayerFrame();
      const result = control.LockedFrame(ms);
      if (result.kind === 'grid') onGrid?.(result.clock, result.index);
      if (world.tick !== before) onTick?.(world.tick);
    }
  };
  /**
   * The director's script-edit path: abandon the recorded future, then take the edit at once when it changes only the
   * future, else re-simulate from the latest snapshot it does not affect.
   *
   * @returns The re-simulation, or null when the edit was taken at once.
   */
  const Edit = (edited: readonly SceneCue[], orders: readonly ScriptedShip[]): TimeResimulation | null => {
    control.AbandonFuture();
    player.AbandonFuture();
    if (player.Accepts(edited, orders, { previous: live })) {
      live = orders;
      player.Rescript(edited, live);
      script = { cues: edited, ships: orders };
      return null;
    }
    const run = control.Resimulate({
      accept: (state) => player.Accepts(edited, orders, { state: (state as RigState).timeline, previous: (state as RigState).ships }),
      restored: () => {
        live = orders;
        player.Rescript(edited, live);
      }
    });
    if (!run) throw new Error('no snapshot passes');
    script = { cues: edited, ships: orders };
    return run;
  };
  /**
   * What a run is compared on: the balls, and each cue's and script's state and tick.
   */
  const Facts = () => ({
    tick: world.tick,
    balls: BallStates(world, 'master', RIG_BALLS),
    cues: (player.Report()?.list ?? []).map(({ id, state, tick }) => ({ id, state, tick })),
    scripts: (player.Report()?.ships ?? []).map(({ ship, state, step }) => ({ ship, state, step }))
  });
  return { world, clock, control, player, RunTo, ExportTo, LockTo, Edit, Facts };
}

export type TimelineRigFacts = ReturnType<ReturnType<typeof TimelineRig>['Facts']>;

export const CUES_A: readonly SceneCue[] = [Cue('go', 2, 'a', Direction([1, 0, 0])), Cue('turn', 6, 'b', Direction([0, 0, 1])), Cue('swing', 12, 'a', Direction([0, 1, 0]))];
export const STEP_0: SceneShipStep = { type: 'direction', direction: [0, 0, -1], speed: 1, duration: 60 } as SceneShipStep;
export const STEP_1: SceneShipStep = { type: 'stop' } as SceneShipStep;
export const SHIPS_A: readonly ScriptedShip[] = [{ id: 'c', orders: [STEP_0, STEP_1] }];
