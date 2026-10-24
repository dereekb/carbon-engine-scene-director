/**
 * The automatic camera director on the page (auto_camera): a standing driver of the cinematic rig. While it is on it
 * drives whenever nobody else does; Claude's and the timeline's shots take precedence and hand the camera back when they
 * end; the user's takeover is sticky until auto_camera or D hands it back.
 *
 * The page collects events (kills, called primaries, warps, prop mods) and, at the end of each Destiny tick boundary,
 * builds the picture and runs the pure step (packages/scene cinema/director): the choice is runtime-free and
 * deterministic for a given picture, event stream and seed. The chosen shot plays through the rig as driver
 * `director`, stamped at the boundary's exact scene time.
 *
 * No runtime import: node-tested over a fake port (camera-director.spec.ts).
 */

import type { Maybe } from '@dereekb/util';
import {
  describeDirectorPick,
  normalizeAutoCameraCommand,
  resolveCameraDirectorSettings,
  sideName,
  stepCameraDirector,
  toDirectorBiasReport,
  DEFAULT_CAMERA_DIRECTOR_SETTINGS,
  emptyCameraDirectorMemory,
  type CameraDirectorEvent,
  type CameraDirectorMemory,
  type CameraDirectorMode,
  type CameraDirectorPicture,
  type CameraDirectorReport,
  type CameraDirectorSettings,
  type CameraDirectorSource,
  type CameraDirectorState,
  type CameraDirectorStepResult,
  type CinemaDriver,
  type DirectorCutLogEntry
} from '@scene-director/scene';
import { CaptureFields, RestoreFields, type CaptureOptions, type CapturedFields, type CloneMemo } from './state-capture';

type JsonObject = Record<string, unknown>;

/**
 * How long the director waits for an unsettled scene after it is turned on before it picks anyway, seconds.
 */
export const DIRECTOR_SETTLE_SECONDS = 10;

/**
 * What the director reads of the rig.
 */
export interface CameraDirectorCinema {
  /**
   * A shot plays or is paused.
   */
  readonly driving: boolean;
  readonly driver: CinemaDriver;
  readonly paused: boolean;
  /**
   * Another driver's release-ending shot holds for the director (the rig's standby).
   */
  readonly handingBack: boolean;
  /**
   * The exact scene tick the playing sequence releases at, when it does.
   */
  readonly releasesAt: Maybe<number>;
}

export interface CameraDirectorPort {
  /**
   * The picture at the scene tick and scene seconds given; null without a scene.
   */
  Facts(tick: number, time: number): Maybe<CameraDirectorPicture>;
  Cinema(): CameraDirectorCinema;
  /**
   * Plays a shot as driver `director` from the scene clock tick `at`.
   */
  Play(shot: JsonObject, at: number): void;
  /**
   * Releases the director's shot to the user (adopt).
   */
  Release(note: string): void;
  Standby(on: boolean): void;
  /**
   * The document's combat seed.
   */
  Seed(): number;
  /**
   * The scene is settled for the simulation (the page's `SceneSettled({ simulation: true })`), so a re-simulation and a
   * straight run gate the first pick the same.
   */
  Settled(): boolean;
  /**
   * A time-control jump re-simulates silently: the director does nothing, unless the movie owns the camera (its state
   * is restored and it steps through the re-simulation as the straight run did).
   */
  Silent(): boolean;
}

export interface CameraDirectorCommandOptions {
  readonly source: CameraDirectorSource;
  /**
   * Scene seconds and tick now, and the scene clock tick a pick plays from.
   */
  readonly tick: number;
  readonly time: number;
  readonly at: number;
  /**
   * A timeline cue: the pick waits for the cue's own boundary step (deterministic), instead of now.
   */
  readonly defer?: boolean;
}

export interface CameraDirectorCommandResult {
  readonly director: CameraDirectorReport;
  readonly log: readonly DirectorCutLogEntry[];
}

type Yielded = 'user' | 'claude' | 'timeline';

/**
 * The director's time-control capture (Movie mode M4, sd-time): the port is wiring, the step cost a measurement.
 */
const CAMERA_DIRECTOR_CAPTURE: CaptureOptions = { wiring: ['port'], reset: { cost: () => ({ lastMs: 0, maxMs: 0 }) } };

export class CameraDirector {
  private on = false;
  private source: Maybe<CameraDirectorSource> = null;
  private settings: CameraDirectorSettings = DEFAULT_CAMERA_DIRECTOR_SETTINGS;
  private memory: Maybe<CameraDirectorMemory> = null;
  private events: CameraDirectorEvent[] = [];
  private yielded: Maybe<Yielded> = null;
  private onSince = 0;
  private time = 0;
  private last: Maybe<CameraDirectorStepResult> = null;
  private note: Maybe<string> = null;
  private cost = { lastMs: 0, maxMs: 0 };
  private waiting = false;
  /**
   * Its shot was put on the rig and nobody took it since.
   */
  private playing = false;

  constructor(private readonly port: CameraDirectorPort) {}

  get active(): boolean {
    return this.on;
  }

  /**
   * auto_camera: turns the director on (or off) and merges its bias. A call while it is yielded takes the camera back
   * now; a call while it drives only changes the bias (the next boundary re-evaluates).
   *
   * @throws SceneError on bad arguments.
   */
  Command(args: unknown, options: CameraDirectorCommandOptions): CameraDirectorCommandResult {
    const command = normalizeAutoCameraCommand(args);
    this.settings = resolveCameraDirectorSettings(command, this.settings);
    if (command.on === false) this.Off(options.time, 'auto_camera turned the director off');
    else {
      const wasOn = this.on;
      this.on = true;
      this.source = wasOn && this.source ? (options.source === 'timeline' ? this.source : options.source) : options.source;
      if (!wasOn) {
        this.onSince = options.time;
        this.memory = null;
      }
      this.port.Standby(true);
      const cinema = this.port.Cinema();
      const driving = cinema.driving && cinema.driver === 'director';
      if (!driving) {
        this.yielded = null;
        if (!options.defer) this.Step(options.tick, options.time, options.at, 'take');
      }
    }
    return { director: this.Report(options.time), log: this.memory?.log ?? [] };
  }

  /**
   * D: off while its shot drives, else on and taking the camera now (source user).
   */
  Toggle(options: Omit<CameraDirectorCommandOptions, 'source'>): CameraDirectorReport {
    const cinema = this.port.Cinema();
    if (this.on && cinema.driving && cinema.driver === 'director') this.Off(options.time, 'D turned the director off');
    else this.Command({}, { ...options, source: 'user' });
    return this.Report(options.time);
  }

  private Off(time: number, note: string): void {
    const cinema = this.port.Cinema();
    const driving = this.on && cinema.driving && cinema.driver === 'director';
    this.on = false;
    this.source = null;
    this.yielded = null;
    this.events = [];
    this.port.Standby(false);
    this.note = note;
    this.time = time;
    this.playing = false;
    if (driving) this.port.Release(note);
  }

  /**
   * Queues a page event for the next boundary's step (dropped while off).
   */
  Event(event: CameraDirectorEvent): void {
    if (this.on) this.events.push(event);
  }

  /**
   * The camera went to someone else: the user (sticky until auto_camera or D) or, for Claude and the timeline, until
   * their shot ends.
   */
  Yield(to: Yielded, note?: string): void {
    if (!this.on) return;
    this.yielded = to;
    this.playing = false;
    if (note) this.note = note;
  }

  /**
   * Its shot left the rig on its own (no one took it): the subject left, the hardpoint lost its pose.
   */
  Lost(): boolean {
    return this.playing && this.StandingBy() && !this.port.Cinema().driving;
  }

  /**
   * Whether the director stands by: on, not yielded to the user, and its shot not paused.
   */
  StandingBy(): boolean {
    const cinema = this.port.Cinema();
    return this.on && this.yielded !== 'user' && !(cinema.paused && cinema.driver === 'director');
  }

  /**
   * The rig lost the director's shot between boundaries (its subject left, its hardpoint lost its pose): pick again
   * now.
   */
  TakeBack(tick: number, time: number, at: number): void {
    if (!this.StandingBy()) return;
    this.Step(tick, time, at, 'take');
  }

  /**
   * A boundary: the step, with this boundary's events, at its scene tick and seconds; a pick plays from `at`, the
   * boundary's exact scene clock tick.
   */
  Boundary(tick: number, time: number, at: number): void {
    if (!this.on || this.port.Silent()) {
      this.events = [];
      return;
    }
    const cinema = this.port.Cinema();
    let mode: CameraDirectorMode = 'watch';
    if (this.yielded === 'user') mode = 'watch';
    else if (cinema.driving && cinema.driver === 'director') mode = cinema.paused ? 'watch' : 'drive';
    else if (cinema.driving && cinema.driver !== 'user') {
      // Claude's or the timeline's shot: back once it ends (the rig holds its last frame for us).
      this.yielded = cinema.driver as Yielded;
      this.playing = false;
      mode = cinema.handingBack || (cinema.releasesAt != null && at >= cinema.releasesAt) ? 'take' : 'watch';
    } else mode = 'take';
    if (mode === 'take' && !this.port.Settled() && time - this.onSince < DIRECTOR_SETTLE_SECONDS) {
      this.waiting = true;
      mode = 'watch';
    }
    this.Step(tick, time, at, mode);
  }

  private Step(tick: number, time: number, at: number, mode: CameraDirectorMode): void {
    const picture = this.port.Facts(tick, time);
    this.time = time;
    const events = this.events;
    this.events = [];
    if (!picture) {
      this.note = 'no scene';
      return;
    }
    const started = performance.now();
    const result = stepCameraDirector({ picture, events, settings: this.settings, memory: this.memory ?? emptyCameraDirectorMemory(time), seed: this.settings.seed ?? this.port.Seed(), mode });
    const ms = performance.now() - started;
    this.cost = { lastMs: Math.round(ms * 100) / 100, maxMs: Math.max(this.cost.maxMs, Math.round(ms * 100) / 100) };
    this.memory = result.memory;
    this.last = mode === 'watch' ? (this.last ?? result) : result;
    if (mode !== 'watch') this.waiting = false;
    if (result.cut) {
      this.yielded = null;
      this.note = null;
      this.playing = true;
      this.port.Play(result.cut.shot, at);
    } else if (mode === 'take') this.note = result.note ?? 'nothing to frame yet';
  }

  /**
   * Forgets the memory: on a load (a cue-sourced director turns off; one Claude or the user turned on stays on and
   * waits for the scene to settle), or keeping the settings across a time-control jump.
   */
  Clear(options: { readonly load: true; readonly time: number } | { readonly keep: 'settings'; readonly time: number }): void {
    this.memory = null;
    this.events = [];
    this.last = null;
    if ('load' in options) {
      if (this.source === 'timeline') this.Off(options.time, 'the load turned off the timeline’s director');
      else if (this.on) {
        this.onSince = options.time;
        this.yielded = null;
      }
    }
  }

  /**
   * The director for a time-control snapshot (Movie mode M4, sd-time): on, source, settings, memory, events, yield and
   * the last step. The page restores it only while the movie owns the camera.
   *
   * @param memo - Shared with the other owners captured into the same snapshot.
   * @returns Plain data.
   */
  Snapshot(memo?: CloneMemo): CapturedFields {
    return CaptureFields(this, CAMERA_DIRECTOR_CAPTURE, memo);
  }

  /**
   * Puts a Snapshot back; the step cost starts over.
   *
   * @param state - From Snapshot.
   * @param memo - Shared with the other owners restored from the same snapshot.
   */
  Restore(state: unknown, memo?: CloneMemo): void {
    RestoreFields(this, state, CAMERA_DIRECTOR_CAPTURE, memo);
  }

  /**
   * The timeline's camera turned off: a director a cue turned on turns off with it.
   */
  TimelineCameraOff(time: number): void {
    if (this.on && this.source === 'timeline') this.Off(time, "the timeline's camera is off");
  }

  /**
   * get_state.cinema.director.
   *
   * @param time - Scene seconds now (the pick's `since`).
   */
  Report(time = this.time): CameraDirectorReport {
    const cinema = this.port.Cinema();
    const ownShot = cinema.driving && cinema.driver === 'director';
    let state: CameraDirectorState = 'off';
    if (this.on) {
      if (this.yielded === 'user' || (!ownShot && cinema.driving)) state = 'yielded';
      else if (ownShot && cinema.paused) state = 'paused';
      else if (ownShot) state = 'driving';
      else state = 'waiting';
    }
    const pick = ownShot ? this.memory?.current : null;
    const yieldedTo = state === 'yielded' ? (this.yielded ?? (cinema.driver === 'user' ? 'user' : (cinema.driver as Yielded))) : null;
    const axis = this.last?.axis;
    const side = this.memory?.side;
    const note = this.note ?? (state === 'waiting' ? (this.waiting ? 'waiting for the scene to settle' : 'waiting for something to frame') : null);
    return {
      on: this.on,
      state,
      ...(yieldedTo ? { yieldedTo } : {}),
      ...(this.on && this.source ? { source: this.source } : {}),
      bias: toDirectorBiasReport(this.settings),
      ...(pick ? { pick: describeDirectorPick(pick, time) } : {}),
      candidates: this.on ? (this.last?.candidates ?? []) : [],
      ...(axis ? { axis: { kind: axis.kind, ...(axis.teams ? { teams: axis.teams } : {}), ...(axis.ship ? { ship: axis.ship } : {}), side: sideName(side?.value ?? 0) } } : {}),
      cuts: this.memory?.cuts ?? 0,
      recent: (this.memory?.recent ?? []).slice(0, 5).map((shot) => ({ at: shot.at, framing: shot.framing, subject: shot.label, scale: shot.scale, why: shot.why })),
      cost: this.cost,
      ...(note ? { note } : {})
    };
  }

  /**
   * The last 20 cuts (auto_camera's result).
   */
  Log(): readonly DirectorCutLogEntry[] {
    return this.memory?.log ?? [];
  }
}

/**
 * The HUD's director row.
 */
export { cameraDirectorText as CameraDirectorText } from '@scene-director/scene';
