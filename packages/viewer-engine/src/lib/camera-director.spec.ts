import { describe, expect, it } from 'vitest';
import type { CameraDirectorPicture, CinemaDriver, DirectorShip, SceneFleet, SceneVector } from '@scene-director/scene';
import { CameraDirector, CameraDirectorText, DIRECTOR_SETTLE_SECONDS, type CameraDirectorCinema, type CameraDirectorPort } from './camera-director';
import { SceneClock, TICKS_PER_SECOND } from './clock';
import { DestinyWorld } from './destiny';
import { RIFTER, Ship as Placement } from './destiny.spec-helper';
import { ExportStepper } from './export-frames';
import { ResolveFlight } from './flight';
import { RoundTrip } from './state-capture.spec-helper';
import { TimeControl } from './time-control';

function Ship(id: string, team: string, position: SceneVector, forward: SceneVector): DirectorShip {
  return { id, team, position, velocity: [0, 0, 0], speed: 0, forward, radius: 50, maxVelocity: 400, health: 1, remaining: 5000, total: 5000 };
}

function Picture(tick: number): CameraDirectorPicture {
  const ships: DirectorShip[] = [];
  const fleets: SceneFleet[] = [];
  for (const [team, z, heading] of [
    ['blue', 0, 1],
    ['red', 20000, -1]
  ] as const) {
    for (let i = 0; i < 4; i += 1) ships.push(Ship(`${team}-${i}`, team, [(i - 2) * 600, 0, z], [0, 0, heading]));
    fleets.push({ id: team, commander: `${team}-0`, wings: [{ id: `${team}-w`, squads: [{ id: `${team}-s`, role: 'dps', members: [`${team}-1`, `${team}-2`, `${team}-3`] }] }] } as SceneFleet);
  }
  return { tick, time: tick, ships, fleets, sunDirection: [0.6, -0.3, 0.74] };
}

class FakeRig {
  cinema: { -readonly [K in keyof CameraDirectorCinema]: CameraDirectorCinema[K] } = { driving: false, driver: 'user', paused: false, handingBack: false, releasesAt: null };
  plays: { shot: Record<string, unknown>; at: number }[] = [];
  releases: string[] = [];
  standby = false;
  settled = true;
  silent = false;

  Port(): CameraDirectorPort {
    return {
      Facts: (tick) => Picture(tick),
      Cinema: () => ({ ...this.cinema }),
      Play: (shot, at) => {
        this.plays.push({ shot, at });
        this.Drive('director');
      },
      Release: (note) => {
        this.releases.push(note);
        this.cinema = { ...this.cinema, driving: false, driver: 'user' };
      },
      Standby: (on) => {
        this.standby = on;
      },
      Seed: () => 7,
      Settled: () => this.settled,
      Silent: () => this.silent
    };
  }

  Drive(driver: CinemaDriver, extra: Partial<CameraDirectorCinema> = {}): void {
    this.cinema = { driving: true, driver, paused: false, handingBack: false, releasesAt: null, ...extra };
  }
}

function Setup(): { rig: FakeRig; director: CameraDirector } {
  const rig = new FakeRig();
  return { rig, director: new CameraDirector(rig.Port()) };
}

const AT = (tick: number) => ({ tick, time: tick, at: tick * 1e7 });

describe('CameraDirector', () => {
  it('takes the camera at once on auto_camera, stands by, and cuts at boundaries', () => {
    const { rig, director } = Setup();
    const result = director.Command({ pace: 'fast' }, { source: 'claude', ...AT(0) });
    expect(rig.plays).toHaveLength(1);
    expect(rig.standby).toBe(true);
    expect(result.director).toMatchObject({ on: true, state: 'driving', source: 'claude', bias: { pace: 'fast', hold: { min: 3, max: 7 } } });
    expect(result.director.pick?.why).toMatch(/ · /);
    for (let tick = 1; tick <= 30; tick += 1) director.Boundary(tick, tick, tick * 1e7);
    expect(rig.plays.length).toBeGreaterThanOrEqual(4);
    expect(rig.plays.every((play, index) => index === 0 || play.at > rig.plays[index - 1].at)).toBe(true);
    expect(director.Report(30).cuts).toBe(rig.plays.length);
    expect(director.Log().length).toBe(rig.plays.length);
    expect(CameraDirectorText(director.Report(30))).toMatch(/^driving · /);
  });

  it("yields to Claude's shot and takes the camera back when it hands back", () => {
    const { rig, director } = Setup();
    director.Command({}, { source: 'claude', ...AT(0) });
    rig.Drive('claude', { releasesAt: 5e7 });
    director.Boundary(1, 1, 1e7);
    expect(director.Report(1)).toMatchObject({ state: 'yielded', yieldedTo: 'claude' });
    const before = rig.plays.length;
    director.Boundary(5, 5, 5e7);
    expect(rig.plays.length).toBe(before + 1);
    expect(director.Report(5).state).toBe('driving');
  });

  it('stays yielded to the user until auto_camera hands the camera back', () => {
    const { rig, director } = Setup();
    director.Command({}, { source: 'claude', ...AT(0) });
    director.Yield('user', 'the pointer took the camera');
    rig.cinema = { ...rig.cinema, driving: false, driver: 'user' };
    const before = rig.plays.length;
    for (let tick = 1; tick <= 20; tick += 1) director.Boundary(tick, tick, tick * 1e7);
    expect(rig.plays.length).toBe(before);
    expect(director.Report(20)).toMatchObject({ state: 'yielded', yieldedTo: 'user' });
    expect(CameraDirectorText(director.Report(20))).toMatch(/yielded to you · D hands back/);
    director.Command({ favour: 'wide' }, { source: 'claude', ...AT(21) });
    expect(rig.plays.length).toBe(before + 1);
    expect(director.Report(21)).toMatchObject({ state: 'driving', bias: { favour: 'wide' } });
  });

  it('turns off, releasing its shot to the user; D toggles it', () => {
    const { rig, director } = Setup();
    director.Command({}, { source: 'claude', ...AT(0) });
    const off = director.Command({ on: false }, { source: 'claude', ...AT(1) });
    expect(off.director).toMatchObject({ on: false, state: 'off' });
    expect(rig.releases).toHaveLength(1);
    expect(rig.standby).toBe(false);
    expect(director.Toggle(AT(2))).toMatchObject({ on: true, state: 'driving', source: 'user' });
    expect(director.Toggle(AT(3))).toMatchObject({ on: false });
  });

  it("picks a cue's director at its boundary, and turns it off on a load or with the timeline's camera", () => {
    const { rig, director } = Setup();
    director.Command({}, { source: 'timeline', ...AT(1), defer: true });
    expect(rig.plays).toHaveLength(0);
    director.Boundary(1, 1, 1e7);
    expect(rig.plays).toHaveLength(1);
    expect(rig.plays[0].at).toBe(1e7);
    director.Clear({ load: true, time: 0 });
    expect(director.Report(0)).toMatchObject({ on: false });
    director.Command({}, { source: 'timeline', ...AT(2) });
    director.TimelineCameraOff(3);
    expect(director.Report(3).on).toBe(false);
    // One Claude turned on survives a load.
    director.Command({}, { source: 'claude', ...AT(4) });
    director.Clear({ load: true, time: 0 });
    expect(director.Report(0).on).toBe(true);
  });

  it('waits for an unsettled scene, at most DIRECTOR_SETTLE_SECONDS', () => {
    const { rig, director } = Setup();
    rig.settled = false;
    director.Command({}, { source: 'claude', ...AT(0) });
    rig.plays = [];
    rig.cinema = { ...rig.cinema, driving: false, driver: 'user' };
    director.Boundary(1, 1, 1e7);
    expect(rig.plays).toHaveLength(0);
    expect(director.Report(1)).toMatchObject({ state: 'waiting', note: 'waiting for the scene to settle' });
    director.Boundary(DIRECTOR_SETTLE_SECONDS, DIRECTOR_SETTLE_SECONDS, DIRECTOR_SETTLE_SECONDS * 1e7);
    expect(rig.plays).toHaveLength(1);
  });

  it('picks again when its shot is lost between boundaries', () => {
    const { rig, director } = Setup();
    director.Command({}, { source: 'claude', ...AT(0) });
    rig.cinema = { ...rig.cinema, driving: false, driver: 'user' };
    expect(director.Lost()).toBe(true);
    director.TakeBack(0, 0.5, 5e6);
    expect(rig.plays).toHaveLength(2);
    expect(director.Lost()).toBe(false);
  });
});

describe('CameraDirector shot rules and layers', () => {
  it("layers the live overrides over the scene's autoCamera: a live null falls back to the scene", () => {
    const { director } = Setup();
    director.SetSceneBias({ scales: ['close'], exclude: ['flyby'] });
    let report = director.Command({}, { source: 'claude', ...AT(0) }).director;
    expect(report.bias).toMatchObject({ scales: ['close'], exclude: ['flyby'], layers: { scene: ['scales', 'exclude'], live: [] } });
    expect(report.pick?.scale).toBe('close');
    report = director.Command({ scales: ['medium'] }, { source: 'claude', ...AT(1) }).director;
    expect(report.bias).toMatchObject({ scales: ['medium'], layers: { scene: ['scales', 'exclude'], live: ['scales'] } });
    report = director.Command({ scales: null }, { source: 'claude', ...AT(2) }).director;
    expect(report.bias).toMatchObject({ scales: ['close'], layers: { live: [] } });
    director.SetSceneBias(null);
    expect(director.Settings()).toMatchObject({ scales: null, exclude: [] });
  });

  it('refuses rules that leave no framing, and keeps the settings', () => {
    const { director } = Setup();
    director.Command({ scales: ['close'] }, { source: 'claude', ...AT(0) });
    expect(() => director.Command({ framings: ['overlook'] }, { source: 'claude', ...AT(1) })).toThrow('auto_camera: the rules leave no framing to pick (framings overlook; scales close)');
    expect(director.Settings()).toMatchObject({ scales: ['close'], framings: null });
  });

  it('keeps its memory across off and on: D off then D on takes back, and the log continues', () => {
    const { director } = Setup();
    director.Command({ pace: 'fast' }, { source: 'claude', ...AT(0) });
    for (let tick = 1; tick <= 10; tick += 1) director.Boundary(tick, tick, tick * 1e7);
    const before = director.Log().length;
    expect(director.Toggle(AT(11))).toMatchObject({ on: false });
    const back = director.Toggle(AT(12));
    expect(back).toMatchObject({ on: true, state: 'driving' });
    expect(back.pick?.why).toMatch(/taking back/);
    expect(director.Log().length).toBe(before + 1);
  });

  it("snapshots the live layer and keeps the scene's current one", () => {
    const { director } = Setup();
    director.SetSceneBias({ exclude: ['flyby'] });
    director.Command({ scales: ['medium', 'close'] }, { source: 'claude', ...AT(0) });
    const snapshot = director.Snapshot();
    director.Command({ scales: null }, { source: 'claude', ...AT(1) });
    director.SetSceneBias({ exclude: ['hero'] });
    director.Restore(snapshot);
    expect(director.Settings()).toMatchObject({ scales: ['medium', 'close'], exclude: ['hero'] });
  });
});

describe('CameraDirector snapshots (sd-time)', () => {
  const Boundaries = (director: CameraDirector, from: number, to: number): void => {
    for (let tick = from; tick <= to; tick += 1) director.Boundary(tick, tick, tick * 1e7);
  };

  it('restores its memory, and cuts after the restore exactly as an uninterrupted twin (Movie mode M4)', () => {
    const build = (): ReturnType<typeof Setup> => {
      const setup = Setup();
      setup.director.Command({ pace: 'fast' }, { source: 'claude', ...AT(0) });
      Boundaries(setup.director, 1, 10);
      return setup;
    };
    const { rig, director } = build();
    const twin = build();
    const cinema = { ...rig.cinema };
    const played = rig.plays.length;
    const trip = RoundTrip(
      director,
      (d) => {
        // The step cost is a measurement, reset by a restore.
        const { cost: _cost, ...report } = d.Report(10);
        return [report, d.Log()];
      },
      (d) => Boundaries(d, 11, 20),
      () => {
        rig.cinema = cinema;
        rig.plays.length = played;
      }
    );
    expect(trip.mutated).not.toEqual(trip.before);
    expect(trip.after).toEqual(trip.before);
    expect(trip.again).toEqual(trip.snapshot);
    Boundaries(director, 11, 40);
    Boundaries(twin.director, 11, 40);
    expect(rig.plays.length).toBeGreaterThan(played);
    expect(rig.plays).toEqual(twin.rig.plays);
    expect(director.Log()).toEqual(twin.director.Log());
  });

  it('steps nothing while its port is silent, and steps through the boundaries a movie camera re-simulates (Silent false)', () => {
    const { rig, director } = Setup();
    director.Command({ pace: 'fast' }, { source: 'claude', ...AT(0) });
    rig.silent = true;
    Boundaries(director, 1, 20);
    expect(rig.plays).toHaveLength(1);
    rig.silent = false;
    Boundaries(director, 21, 40);
    expect(rig.plays.length).toBeGreaterThan(1);
  });
});

describe('CameraDirector at any frame rate (sd-export)', () => {
  const rifter = ResolveFlight({ published: RIFTER, hull: null, overrides: null });

  /**
   * Two fleets closing in a world a movie export steps at `fps` for 40 s, the director deciding at every boundary on the
   * world's ships, as the page calls it.
   *
   * @returns Its cut log and the shots it played, with their scene clocks.
   */
  function Export(fps: number) {
    const world = new DestinyWorld();
    const ids: { id: string; team: string }[] = [];
    for (const [team, z, heading] of [
      ['blue', 0, 1],
      ['red', 20000, -1]
    ] as const) {
      for (let i = 0; i < 4; i += 1) {
        const id = `${team}-${i}`;
        ids.push({ id, team });
        world.AddShip(Placement(id, [(i - 2) * 600, 0, z]), rifter);
        world.Order(id, { type: 'direction', direction: [0.2 * (i - 1.5), 0, heading], speed: 1 });
      }
    }
    const rig = new FakeRig();
    const port = rig.Port();
    const director = new CameraDirector({
      ...port,
      Facts: (tick) => {
        const picture = Picture(tick);
        const ships = ids.map(({ id, team }) => {
          const motion = world.Motion(id);
          return { ...Ship(id, team, motion?.position ?? [0, 0, 0], [0, 0, team === 'blue' ? 1 : -1]), velocity: motion?.velocity ?? [0, 0, 0], speed: motion?.speed ?? 0 };
        });
        return { ...picture, ships };
      }
    });
    const clock = new SceneClock();
    const control = new TimeControl({ clock, world, realNow: () => 0 });
    control.Frame(0);
    // The clock sits on the boundary while the world evolves it (FrameTo sets it first).
    world.OnBoundary((boundary) => director.Boundary(boundary, boundary, clock.now));
    director.Command({ pace: 'fast' }, { source: 'claude', tick: world.tick, time: world.tick, at: clock.now });
    control.BeginExport({ fps });
    const stepper = new ExportStepper({ time: control, world, grid: { origin: clock.now, fps, preroll: 0, frames: 40 * fps } });
    while (stepper.Next());
    return { log: director.Log(), plays: rig.plays.map(({ shot, at }) => ({ shot, at: Math.round(at / TICKS_PER_SECOND) })) };
  }

  it('cuts the same shots on the same ticks at 24 and 60 fps', () => {
    const at60 = Export(60);
    expect(at60.plays.length).toBeGreaterThanOrEqual(4);
    const at24 = Export(24);
    expect(at24.log).toEqual(at60.log);
    expect(at24.plays).toEqual(at60.plays);
  });
});
