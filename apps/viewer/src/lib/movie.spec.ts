/**
 * The determinism oracle of script edits (Movie mode M3, sd-timeline doc `movie`): a script edited while it plays,
 * re-simulated from the last snapshot before its first difference, must equal a fresh run of the edited script, tick
 * for tick: the master park's balls and every cue's and script's tick.
 */

import { cueActionOf, type SceneCue, type SceneShipStep, type ShipOrder } from '@scene-director/scene';
import { describe, expect, it } from 'vitest';
import { SceneClock } from './clock';
import { DestinyWorld, type DestinySnapshot } from './destiny';
import { BallStates, Ship } from './destiny.spec-helper';
import { ResolveFlight, type PublishedHull } from './flight';
import { ShipScripts, type ScriptedShip } from './ship-scripts';
import { EstimateBytes } from './state-capture';
import { TimeControl, type TimeResimulation } from './time-control';
import { TimelinePlayer, type TimelineSnapshot } from './timeline';

const RIFTER: PublishedHull = { typeID: 587, name: 'Rifter', published: { mass: 1_067_000, maxVelocity: 365, agility: 3.2, signatureRadius: 35, radius: 31, warpSpeedMultiplier: 5, rigSize: 1 } };
const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null });
const BALLS = 3;
/**
 * The world tick every run is compared at.
 */
const END = 30;

interface RigState {
  readonly world: DestinySnapshot;
  readonly timeline: TimelineSnapshot;
  readonly ships: readonly ScriptedShip[];
}

function Direction(direction: [number, number, number]): ShipOrder {
  return { type: 'direction', direction, speed: 1 } as ShipOrder;
}

function Cue(id: string, at: number, ship: string, order: ShipOrder): SceneCue {
  return { id, at, order_ship: { id: ship, order } } as SceneCue;
}

/**
 * A page stand-in: a real world, TimeControl and TimelinePlayer with ShipScripts, cues that order ships in the world, a
 * sim port that captures the world, the player and the ships' orders (the live scene), 60 fps frames, and the director's
 * script-edit path (Edit).
 */
function TimelineRig(cues: readonly SceneCue[], ships: readonly ScriptedShip[]) {
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
  let ms = 0;
  const RunTo = (tick: number) => {
    for (let guard = 0; world.tick < tick && guard < 100_000; guard++) {
      ms += 1000 / 60;
      const before = player.state;
      player.Frame();
      if (before !== 'playing' && player.state === 'playing' && player.startTick == null) control.MarkOrigin();
      control.Frame(ms);
    }
  };
  // The page ran before the load: the tick grid exists when the timeline starts.
  RunTo(3);
  player.Load(cues, true);
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
    balls: BallStates(world, 'master', BALLS),
    cues: (player.Report()?.list ?? []).map(({ id, state, tick }) => ({ id, state, tick })),
    scripts: (player.Report()?.ships ?? []).map(({ ship, state, step }) => ({ ship, state, step }))
  });
  return { world, clock, control, player, RunTo, Edit, Facts };
}

const CUES_A: readonly SceneCue[] = [Cue('go', 2, 'a', Direction([1, 0, 0])), Cue('turn', 6, 'b', Direction([0, 0, 1])), Cue('swing', 12, 'a', Direction([0, 1, 0]))];
const STEP_0: SceneShipStep = { type: 'direction', direction: [0, 0, -1], speed: 1, duration: 60 } as SceneShipStep;
const STEP_1: SceneShipStep = { type: 'stop' } as SceneShipStep;
const SHIPS_A: readonly ScriptedShip[] = [{ id: 'c', orders: [STEP_0, STEP_1] }];

/**
 * Script A run to END, edited there, against a fresh run of the edited script to END.
 */
function Oracle(cues: readonly SceneCue[], ships: readonly ScriptedShip[] = SHIPS_A): { edited: ReturnType<ReturnType<typeof TimelineRig>['Facts']>; fresh: ReturnType<ReturnType<typeof TimelineRig>['Facts']>; run: TimeResimulation | null } {
  const rig = TimelineRig(CUES_A, SHIPS_A);
  rig.RunTo(END);
  const run = rig.Edit(cues, ships);
  const fresh = TimelineRig(cues, ships);
  fresh.RunTo(END);
  return { edited: rig.Facts(), fresh: fresh.Facts(), run };
}

describe('script edits re-simulate to a fresh run of the edited script (Movie mode M3)', () => {
  it('a cue added at 8, behind now: re-simulated from before it', () => {
    const { edited, fresh, run } = Oracle([...CUES_A, Cue('added', 8, 'c', Direction([1, 1, 0]))]);
    expect(run?.report.resimulated).toBeGreaterThan(0);
    expect(edited.cues.find(({ id }) => id === 'added')).toMatchObject({ state: 'fired' });
    expect(edited).toEqual(fresh);
  });

  it('a fired cue retimed, and a fired cue removed', () => {
    const retimed = Oracle([CUES_A[0], Cue('turn', 9, 'b', Direction([0, 0, 1])), CUES_A[2]]);
    expect(retimed.run).not.toBeNull();
    expect(retimed.edited).toEqual(retimed.fresh);
    const removed = Oracle([CUES_A[0], CUES_A[2]]);
    expect(removed.run).not.toBeNull();
    expect(removed.edited).toEqual(removed.fresh);
  });

  it('an event cue whose event already happened, added', () => {
    const { edited, fresh, run } = Oracle([...CUES_A, { id: 'after-go', when: { cue: 'go', after: 3 }, arms: 2, order_ship: { id: 'b', order: Direction([0, 1, 1]) } } as SceneCue]);
    expect(run).not.toBeNull();
    expect(edited.cues.find(({ id }) => id === 'after-go')).toMatchObject({ state: 'fired' });
    expect(edited).toEqual(fresh);
  });

  it("a ship's step 1 changed while it flies step 0: taken at once, and equal", () => {
    const { edited, fresh, run } = Oracle(CUES_A, [{ id: 'c', orders: [STEP_0, { type: 'direction', direction: [1, 0, 0], speed: 1 } as SceneShipStep] }]);
    expect(run).toBeNull();
    expect(edited.scripts).toEqual([{ ship: 'c', state: 'flying', step: 0 }]);
    expect(edited).toEqual(fresh);
  });

  it('a future-only edit survives a jump back to a snapshot from before it', () => {
    const edited = [...CUES_A, Cue('late', 35, 'b', Direction([1, 0, 1]))];
    const rig = TimelineRig(CUES_A, SHIPS_A);
    rig.RunTo(END);
    expect(rig.Edit(edited, SHIPS_A)).toBeNull();
    rig.control.Command({ back: 12 });
    rig.RunTo(45);
    const fresh = TimelineRig(edited, SHIPS_A);
    fresh.RunTo(45);
    expect(rig.Facts().cues.find(({ id }) => id === 'late')).toMatchObject({ state: 'fired' });
    expect(rig.Facts()).toEqual(fresh.Facts());
  });

  it("a ship's step 0 changed: re-simulated from the origin", () => {
    const { edited, fresh, run } = Oracle(CUES_A, [{ id: 'c', orders: [{ ...STEP_0, direction: [1, 0, -1] } as SceneShipStep, STEP_1] }]);
    expect(run?.snapshot.tick).toBe(3);
    expect(edited).toEqual(fresh);
  });
});
