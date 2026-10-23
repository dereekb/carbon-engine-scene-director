/**
 * The cinematic camera rig: plays camera shots and sequences (packages/scene cinema/shot.ts) on the scene clock.
 *
 * Every frame, between world.Tick and engine.Frame, the director hands it the scene as drawn (CinemaScene); the rig
 * resolves the shot's hardpoint on it, plays the moves (cinema-moves.ts), trails the eye and look by the shot's lag,
 * blends in from the previous pose, keeps the eye out of every hull and picks clip planes. The engine's FreeCamera
 * then writes the result into EveCamera's view and projection.
 *
 * - Time is the scene clock's: a paused clock holds the shot, fixed steps replay it exactly.
 * - A sequence advances on each shot's duration; the last shot holds unless it has one, and then the rig releases
 *   (or, with `end: "hold"`, keeps its last frame until stopped).
 * - A pause freezes the shot's clock while its hardpoint keeps tracking; resume continues it, or replays the last
 *   stopped or released shot from where it stopped, blending in from the drawn pose.
 * - Releasing blends from the last cinematic pose back to the orbit camera over CINEMA_RELEASE_SECONDS; with `adopt`
 *   the orbit is first set to the cinematic eye and look, so a drag continues from the image.
 * - A subject that left the scene ends the shot (released and forgotten, with a note).
 *
 * Node-tested: it imports only the scene package, the clock and cinema-moves.ts.
 */

import type { Maybe } from '@dereekb/util';
import {
  cameraClips,
  cameraPathAnchors,
  cameraShotSubjects,
  cinemaAnchor,
  HULL_CLEARANCE,
  cinemaSpheres,
  clearHulls,
  DEFAULT_BLEND_SECONDS,
  normalizeCameraSequence,
  normalizeCameraShot,
  resolveHardpoint,
  resolveWaypoint,
  rollPose,
  toOrbitView,
  WORLD_UP,
  blendPoses,
  type CameraPose,
  type CameraShot,
  type CinemaDriver,
  type CinemaEasing,
  type CinemaScene,
  type HardpointAnchor,
  type OrbitView,
  type SceneVector,
  type SubjectFrame
} from '@scene-director/scene';
import { Ease, EvaluateMoves, SeedOf, Smooth, TrackLag } from './cinema-moves';
import { TICKS_PER_SECOND } from './clock';

/**
 * Seconds the release blend back to the orbit camera takes.
 */
export const CINEMA_RELEASE_SECONDS = 0.5;

/**
 * The aspect the rig frames for without a renderer (verify-page, headless).
 */
export const CINEMA_DEFAULT_ASPECT = 16 / 9;

/**
 * A free pose's field of view when the shot gives none, degrees.
 */
export const CINEMA_DEFAULT_FOV = 45;

export type CinemaState = 'idle' | 'playing' | 'paused' | 'releasing';

/**
 * Who can play a shot: Claude over MCP, the automatic director (reserved), or the timeline's camera cues. The user
 * drives the orbit camera.
 */
export type CinemaPlayer = Exclude<CinemaDriver, 'user'>;

/**
 * What the engine draws this frame.
 */
export interface CinemaFrame {
  readonly pose: CameraPose;
  /**
   * 0..1: how far to blend from the pose toward the orbit camera's (the release).
   */
  readonly toOrbit: number;
  readonly near: number;
  readonly far: number;
}

export interface CinemaPlayResult {
  readonly state: CinemaState;
  /**
   * The shots as played: normalized, library shots expanded.
   */
  readonly shots: readonly CameraShot[];
  readonly warnings: string[];
}

export interface CinemaReleaseOptions {
  /**
   * Return the orbit view at the cinematic eye and look, for the orbit camera to take over from the image.
   */
  readonly adopt?: boolean;
  readonly note?: string;
  /**
   * Straight back to the orbit camera, with no release blend.
   */
  readonly cut?: boolean;
  /**
   * Forget the shot: resume cannot replay it.
   */
  readonly forget?: boolean;
}

/**
 * The shot playing, in get_state.
 */
export interface CinemaShotReport {
  readonly name?: string;
  readonly library?: string;
  readonly hardpoint?: CameraShot['hardpoint'];
  readonly pose?: CameraShot['pose'];
  readonly moves: string[];
  readonly transition: CameraShot['transition']['type'];
  readonly end: CameraShot['end'];
  readonly elapsed: number;
  readonly duration: Maybe<number>;
  /**
   * elapsed / duration; null while it holds with no duration.
   */
  readonly progress: Maybe<number>;
  /**
   * The last shot's duration is up and it holds its last frame (`end: "hold"`).
   */
  readonly holding?: boolean;
}

export interface CinemaSequenceReport {
  readonly index: number;
  readonly count: number;
  /**
   * Seconds into the whole sequence.
   */
  readonly elapsed: number;
  /**
   * The whole sequence's seconds; null when its last shot holds with no duration.
   */
  readonly duration: Maybe<number>;
  readonly progress: Maybe<number>;
}

/**
 * What resume_shot would replay.
 */
export interface CinemaResumableReport {
  readonly name?: string;
  readonly library?: string;
  readonly index: number;
  readonly count: number;
  /**
   * Seconds into the shot it stopped at.
   */
  readonly elapsed: number;
}

export interface CinemaReport {
  readonly state: CinemaState;
  /**
   * Who drives: the player while a shot plays or is paused, else the user (the orbit camera).
   */
  readonly driver: CinemaDriver;
  readonly shot: Maybe<CinemaShotReport>;
  readonly sequence: Maybe<CinemaSequenceReport>;
  readonly resumable: Maybe<CinemaResumableReport>;
  readonly pose: Maybe<{ readonly eye: number[]; readonly look: number[]; readonly up: number[]; readonly fov: number }>;
  readonly near: Maybe<number>;
  readonly far: Maybe<number>;
  readonly letterbox: Maybe<number | false>;
  readonly hud: Maybe<boolean>;
  readonly note: Maybe<string>;
}

interface ShotRun {
  readonly shot: CameraShot;
  /**
   * The scene tick the shot started at (moved on by a pause).
   */
  start: number;
  readonly seed: number;
  anchor: Maybe<HardpointAnchor>;
  /**
   * The pose a blend starts from; null until the first frame captures the drawn one.
   */
  blendFrom: Maybe<CameraPose>;
  /**
   * A resume's blend in from the drawn pose, read instead of the shot's own transition.
   */
  resumeBlend?: { start: number; readonly duration: number; readonly easing: CinemaEasing };
  /**
   * Whether a frame has been drawn on it.
   */
  framed: boolean;
}

/**
 * A stopped or released shot, for resume.
 */
interface StoppedShots {
  readonly shots: readonly CameraShot[];
  readonly index: number;
  /**
   * Ticks into the shot it stopped at.
   */
  readonly elapsed: number;
  readonly anchor: Maybe<HardpointAnchor>;
  readonly seed: number;
}

interface Release {
  readonly start: number;
  readonly from: CameraPose;
  readonly near: number;
  readonly far: number;
}

export class CinemaRig {
  private state: CinemaState = 'idle';
  private driver: CinemaPlayer = 'claude';
  private shots: CameraShot[] = [];
  private index = 0;
  private run: Maybe<ShotRun> = null;
  private release: Maybe<Release> = null;
  private last: Maybe<{ readonly pose: CameraPose; readonly near: number; readonly far: number }> = null;
  private smoothed: Maybe<{ eye: SceneVector; look: SceneVector }> = null;
  private lastTick: Maybe<number> = null;
  private note: Maybe<string> = null;
  private reportedAt = 0;
  private pausedAt: Maybe<number> = null;
  private stopped: Maybe<StoppedShots> = null;

  /**
   * True while a shot plays, is paused, or the release blend runs.
   */
  get active(): boolean {
    return this.state !== 'idle';
  }

  get playing(): boolean {
    return this.state === 'playing';
  }

  /**
   * True while a shot plays or is paused: the cinematic camera has the view.
   */
  get driving(): boolean {
    return this.state === 'playing' || this.state === 'paused';
  }

  /**
   * Plays a shot, or a sequence (`{ shots: [...] }` or an array), replacing whatever plays and forgetting any paused
   * or stopped shot. A blend transition starts from the pose drawn last frame; a cut starts on the hardpoint.
   *
   * @param input - The shot or sequence JSON (library references expand here).
   * @param now - The scene clock, in integer 100 ns ticks.
   * @param driver - Who asked (get_state's `cinema.driver`).
   * @returns The new state, the shots as played, and any warnings.
   * @throws {Error} When the shot or sequence is invalid.
   */
  Play(input: unknown, now: number, driver: CinemaPlayer = 'claude'): CinemaPlayResult {
    const sequence = Array.isArray(input) || (typeof input === 'object' && input !== null && (input as Record<string, unknown>)['shots'] != null);
    const normalized = sequence ? normalizeCameraSequence(input) : normalizeCameraShot(input);
    const shots = 'sequence' in normalized ? (normalized.sequence?.shots ?? null) : normalized.shot ? [normalized.shot] : null;
    if (!shots?.length) throw new Error(`Invalid camera ${sequence ? 'sequence' : 'shot'}:\n- ${normalized.problems.join('\n- ')}`);
    // A new play while one runs blends from its pose; from idle, a pause or a release it captures the drawn pose.
    if (this.state !== 'playing') this.last = null;
    this.shots = [...shots];
    this.index = 0;
    this.driver = driver;
    this.note = null;
    this.release = null;
    this.pausedAt = null;
    this.stopped = null;
    this.state = 'playing';
    this.StartShot(now);
    return { state: this.state, shots: this.shots, warnings: normalized.warnings };
  }

  /**
   * Stops the shot: a release blend back to the orbit camera, or with `cut` straight back. It stays resumable unless
   * `forget`.
   */
  Stop(now: number, { cut = false, note, forget = false }: { readonly cut?: boolean; readonly note?: string; readonly forget?: boolean } = {}): void {
    if (this.driving) this.Release(now, { note, cut, forget });
    else {
      if (forget) this.stopped = null;
      if (cut && this.state === 'releasing') {
        if (note) this.note = note;
        this.state = 'idle';
        this.release = null;
      }
    }
  }

  /**
   * Hands the camera back to the orbit camera with a short blend (none with `cut`), remembering the shot for resume
   * unless `forget`.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @param options - `adopt` returns the orbit view at the cinematic eye and look.
   * @returns The orbit view to adopt, when asked and a shot was driving.
   */
  Release(now: number, { adopt = false, note, cut = false, forget = false }: CinemaReleaseOptions = {}): Maybe<OrbitView> {
    if (!this.driving) {
      if (forget) this.stopped = null;
      return null;
    }
    if (note) this.note = note;
    const run = this.run;
    this.stopped = forget || !run ? null : { shots: this.shots, index: this.index, elapsed: this.ShotNow(now) - run.start, anchor: run.anchor, seed: run.seed };
    const last = this.last;
    this.run = null;
    this.smoothed = null;
    this.pausedAt = null;
    if (last && !cut) {
      this.release = { start: now, from: last.pose, near: last.near, far: last.far };
      this.state = 'releasing';
    } else {
      this.release = null;
      this.state = 'idle';
    }
    return adopt && last ? toOrbitView(last.pose) : null;
  }

  /**
   * Freezes the playing shot: its clock, moves, paths and sequence stop, while its hardpoint still follows the subject.
   *
   * @throws {Error} When no shot is playing.
   */
  Pause(now: number): void {
    if (this.state === 'paused') return;
    if (this.state !== 'playing') throw new Error('nothing to pause: no shot is playing');
    this.pausedAt = now;
    this.state = 'paused';
  }

  /**
   * Continues a paused shot where it froze, or replays the last stopped or released shot or sequence from where it
   * stopped, blending in from the drawn pose. A no-op while a shot plays.
   *
   * @throws {Error} When nothing is paused or stopped.
   */
  Resume(now: number, driver: CinemaPlayer = this.driver): void {
    if (this.state === 'playing') return;
    if (this.state === 'paused' && this.run && this.pausedAt != null) {
      const frozen = now - this.pausedAt;
      this.run.start += frozen;
      if (this.run.resumeBlend) this.run.resumeBlend.start += frozen;
      this.pausedAt = null;
      this.driver = driver;
      this.state = 'playing';
      return;
    }
    const stopped = this.stopped;
    if (!stopped) throw new Error('nothing to resume: no shot is paused or stopped');
    this.shots = [...stopped.shots];
    this.index = stopped.index;
    this.run = {
      shot: this.shots[this.index],
      start: now - stopped.elapsed,
      seed: stopped.seed,
      anchor: stopped.anchor,
      blendFrom: null,
      resumeBlend: { start: now, duration: DEFAULT_BLEND_SECONDS, easing: 'ease-in-out' },
      framed: false
    };
    this.stopped = null;
    this.release = null;
    this.last = null;
    this.smoothed = null;
    this.note = null;
    this.driver = driver;
    this.state = 'playing';
  }

  /**
   * A time-control jump moved the scene clock by `delta`: every scene-tick stamp shifts with it, so a playing shot
   * continues at its progress, a paused one stays paused where it was, and a release blend runs on. The camera is a
   * viewing control: a jump never rewinds it.
   *
   * @param delta - The jump, 100 ns ticks (negative for a jump back).
   */
  Rebase(delta: number): void {
    if (!delta) return;
    if (this.run) {
      this.run.start += delta;
      if (this.run.resumeBlend) this.run.resumeBlend.start += delta;
    }
    if (this.release) this.release = { ...this.release, start: this.release.start + delta };
    if (this.pausedAt != null) this.pausedAt += delta;
    if (this.lastTick != null) this.lastTick += delta;
    this.reportedAt += delta;
  }

  /**
   * The ship and object ids the shot depends on.
   */
  Subjects(): string[] {
    return this.driving ? cameraShotSubjects(this.run?.shot) : [];
  }

  /**
   * The frame's presentation the shot asks for; undefined fields keep the page's.
   */
  Presentation(): { readonly letterbox?: number | false; readonly hud?: boolean } {
    const shot = this.driving ? this.run?.shot : null;
    return shot ? { ...(shot.letterbox === undefined ? {} : { letterbox: shot.letterbox }), ...(shot.hud === undefined ? {} : { hud: shot.hud }) } : {};
  }

  /**
   * The camera for the frame at `now`, or null when the orbit camera has it.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @param sceneOf - The scene as drawn at `now` (built only while a shot drives).
   */
  Frame(now: number, sceneOf: () => CinemaScene): Maybe<CinemaFrame> {
    const seconds = this.lastTick == null ? 0 : Math.max(0, (now - this.lastTick) / TICKS_PER_SECOND);
    this.lastTick = now;
    this.reportedAt = now;
    let frame: Maybe<CinemaFrame> = null;
    if (this.driving) frame = this.PlayFrame(now, seconds, sceneOf());
    if (this.state === 'releasing') frame = this.ReleaseFrame(now);
    return frame;
  }

  /**
   * Get_state's `cinema`.
   */
  Report(now = this.reportedAt): CinemaReport {
    const run = this.driving ? this.run : null;
    const shot = run?.shot;
    const raw = run ? Math.max(0, (this.ShotNow(now) - run.start) / TICKS_PER_SECOND) : 0;
    const holding = shot?.duration != null && shot.end === 'hold' && this.index === this.shots.length - 1 && raw >= shot.duration;
    const elapsed = holding && shot?.duration != null ? shot.duration : raw;
    const pose = this.state === 'idle' ? null : this.last?.pose;
    const presentation = this.Presentation();
    let sequence: Maybe<CinemaSequenceReport> = null;
    if (run && this.shots.length > 1) {
      const before = this.shots.slice(0, this.index).reduce((sum, entry) => sum + (entry.duration ?? 0), 0);
      const total = this.shots.every((entry) => entry.duration != null) ? this.shots.reduce((sum, entry) => sum + (entry.duration ?? 0), 0) : null;
      sequence = { index: this.index, count: this.shots.length, elapsed: Round(before + elapsed, 100), duration: total, progress: total ? Round(Math.min(1, (before + elapsed) / total), 1000) : null };
    }
    const stopped = this.stopped;
    const stoppedShot = stopped?.shots[stopped.index];
    return {
      state: this.state,
      driver: this.driving ? this.driver : 'user',
      shot:
        run && shot
          ? {
              ...(shot.name ? { name: shot.name } : {}),
              ...(shot.library ? { library: shot.library } : {}),
              ...(shot.hardpoint ? { hardpoint: shot.hardpoint } : {}),
              ...(shot.pose ? { pose: shot.pose } : {}),
              moves: shot.moves.map((move) => move.type),
              transition: shot.transition.type,
              end: shot.end,
              elapsed: Round(elapsed, 100),
              duration: shot.duration ?? null,
              progress: shot.duration ? Round(Math.min(1, elapsed / shot.duration), 1000) : null,
              ...(holding ? { holding: true } : {})
            }
          : null,
      sequence,
      resumable:
        stopped && stoppedShot
          ? {
              ...(stoppedShot.name ? { name: stoppedShot.name } : {}),
              ...(stoppedShot.library ? { library: stoppedShot.library } : {}),
              index: stopped.index,
              count: stopped.shots.length,
              elapsed: Round(stopped.elapsed / TICKS_PER_SECOND, 100)
            }
          : null,
      pose: pose ? { eye: pose.eye.map((value) => Round(value, 100)), look: pose.look.map((value) => Round(value, 100)), up: pose.up.map((value) => Round(value, 1000)), fov: Round(pose.fov, 100) } : null,
      near: this.state === 'idle' || !this.last ? null : Round(this.last.near, 1000),
      far: this.state === 'idle' || !this.last ? null : Math.round(this.last.far),
      letterbox: presentation.letterbox ?? null,
      hud: presentation.hud ?? null,
      note: this.note
    };
  }

  /**
   * The shot clock: frozen at the pause while paused.
   */
  private ShotNow(now: number): number {
    return this.state === 'paused' && this.pausedAt != null ? this.pausedAt : now;
  }

  private StartShot(now: number): void {
    const shot = this.shots[this.index];
    const blend = shot.transition.type === 'blend';
    this.run = { shot, start: now, seed: SeedOf(`${this.index}:${JSON.stringify(shot)}`), anchor: null, blendFrom: blend ? (this.last?.pose ?? null) : null, framed: false };
    if (!blend) this.smoothed = null;
  }

  private PlayFrame(now: number, seconds: number, scene: CinemaScene): Maybe<CinemaFrame> {
    const shotNow = this.ShotNow(now);
    let run = this.run;
    let holding = false;
    // Advance the sequence on each shot's duration, from its exact end so the timing never drifts.
    while (run?.shot.duration != null && shotNow - run.start >= run.shot.duration * TICKS_PER_SECOND) {
      if (this.index + 1 >= this.shots.length) {
        if (run.shot.end === 'hold') {
          holding = true;
          break;
        }
        this.Release(now, { note: this.shots.length > 1 ? 'the sequence finished' : 'the shot finished', forget: true });
        return null;
      }
      const end = run.start + Math.round(run.shot.duration * TICKS_PER_SECOND);
      this.index += 1;
      this.StartShot(end);
      run = this.run;
    }
    if (!run) return null;
    const { shot } = run;
    const elapsed = (shotNow - run.start) / TICKS_PER_SECOND;
    const t = holding && shot.duration != null ? Math.min(elapsed, shot.duration) : elapsed;
    let base: Maybe<CameraPose> = null;
    let subject: Maybe<SubjectFrame> = null;
    if (shot.hardpoint) {
      const resolved = resolveHardpoint(shot.hardpoint, scene, run.anchor);
      if (resolved.anchor && !run.anchor) {
        // An anchor seen after the first frame (warp-landing once the warp is known) cuts there instead of smearing.
        if (run.framed) this.smoothed = null;
        run.anchor = resolved.anchor;
      }
      base = resolved.pose;
      subject = resolved.subject;
      if (!base) {
        this.Release(now, { note: resolved.note ?? 'the hardpoint has no pose', forget: true });
        return null;
      }
      this.note = resolved.note ?? null;
    } else if (shot.pose) {
      const context = { anchorOf: (ref: { readonly ship?: string; readonly object?: string }) => cinemaAnchor(scene, ref) };
      const eye = resolveWaypoint(shot.pose.eye, context);
      const look = resolveWaypoint(shot.pose.look, context);
      if (!eye || !look) {
        this.Release(now, { note: 'its subject left the scene', forget: true });
        return null;
      }
      // An eye riding the hull it looks at, at its centre: hold the last pose.
      if (eye.every((value, axis) => value === look[axis])) return this.last ? { pose: this.last.pose, toOrbit: 0, near: this.last.near, far: this.last.far } : null;
      const { up, roll, fov } = shot.pose;
      base = { eye, look, up: up ? [...up] : [...WORLD_UP], fov: fov ?? CINEMA_DEFAULT_FOV };
      if (roll) base = rollPose(base, roll);
    }
    if (!base) return null;
    const moved = EvaluateMoves(base, shot.moves, t, { subject, seed: run.seed, shotDuration: shot.duration ?? null, scene });
    const lookLag = Math.max(shot.lag.look, TrackLag(shot.moves, t));
    const smoothed = this.smoothed ?? { eye: moved.eye, look: moved.look };
    this.smoothed = { eye: Smooth(smoothed.eye, moved.eye, seconds, shot.lag.eye), look: Smooth(smoothed.look, moved.look, seconds, lookLag) };
    let pose: CameraPose = { ...moved, eye: this.smoothed.eye, look: this.smoothed.look };
    if (run.resumeBlend) {
      run.blendFrom ??= scene.camera ?? null;
      const share = (shotNow - run.resumeBlend.start) / TICKS_PER_SECOND / run.resumeBlend.duration;
      if (run.blendFrom && share < 1) pose = blendPoses(run.blendFrom, pose, Ease(run.resumeBlend.easing, share));
    } else if (shot.transition.type === 'blend') {
      run.blendFrom ??= scene.camera ?? null;
      if (run.blendFrom) pose = blendPoses(run.blendFrom, pose, Ease(shot.transition.easing, t / shot.transition.duration));
    }
    // The hulls a path or the pose's eye rides on are exempt from clearance: the shot puts the eye there on purpose.
    // Ships streaking in from warp only stretch the clip planes, so the streak is drawn.
    const spheres = [...cinemaSpheres(scene), ...(scene.incoming ?? [])];
    const eye = shot.clearance === false ? pose.eye : clearHulls(pose.eye, cinemaSpheres(scene, new Set(cameraPathAnchors(shot))), shot.clearance ?? HULL_CLEARANCE);
    pose = { ...pose, eye };
    const { near, far } = cameraClips({ eye, spheres, reach: scene.reach ?? 0 });
    this.last = { pose, near, far };
    run.framed = true;
    return { pose, toOrbit: 0, near, far };
  }

  private ReleaseFrame(now: number): Maybe<CinemaFrame> {
    const release = this.release;
    if (!release) {
      this.state = 'idle';
      return null;
    }
    const share = (now - release.start) / TICKS_PER_SECOND / CINEMA_RELEASE_SECONDS;
    if (share >= 1) {
      this.state = 'idle';
      this.release = null;
      return null;
    }
    return { pose: release.from, toOrbit: Ease('ease-in-out', share), near: release.near, far: release.far };
  }
}

/**
 * What a scene edit does to a playing shot.
 */
export interface CinemaReleaseInput {
  /**
   * A load (load_scene / open_scene).
   */
  readonly restart: boolean;
  /**
   * Whether the edit changed the document's camera.
   */
  readonly cameraChanged: boolean;
  /**
   * The ships and objects the edit removed.
   */
  readonly removed: readonly string[];
  /**
   * The ships the shot depends on (CinemaRig.Subjects).
   */
  readonly subjects: readonly string[];
}

/**
 * Whether an edit ends the shot: a load cuts straight back to the orbit camera (its document camera frames the new
 * scene), a camera change or removing a subject releases it, and any other edit keeps it playing. ReframesAfterEdit
 * (camera.ts) still drives the orbit camera underneath either way.
 *
 * @param input - The edit and the shot's subjects.
 * @returns What to do with the shot.
 */
export function CinemaReleases(input: CinemaReleaseInput): 'cut' | 'release' | 'keep' {
  const { restart, cameraChanged, removed, subjects } = input;
  let action: 'cut' | 'release' | 'keep' = 'keep';
  if (restart) action = 'cut';
  else if (cameraChanged || subjects.some((id) => removed.includes(id))) action = 'release';
  return action;
}

export interface LetterboxBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The frame's box inside a window for an aspect: bars above and below (a letterbox) when the window is narrower than
 * the aspect, at the sides (a pillarbox) when it is wider.
 *
 * @param width - The window's width, CSS pixels.
 * @param height - The window's height.
 * @param aspect - Width / height; null or false for the whole window.
 */
export function LetterboxRect(width: number, height: number, aspect: Maybe<number | false>): LetterboxBox {
  let box: LetterboxBox = { left: 0, top: 0, width, height };
  if (aspect && width > 0 && height > 0) {
    if (width / height > aspect) {
      const inner = Math.round(height * aspect);
      box = { left: Math.floor((width - inner) / 2), top: 0, width: inner, height };
    } else {
      const inner = Math.round(width / aspect);
      box = { left: 0, top: Math.floor((height - inner) / 2), width, height: inner };
    }
  }
  return box;
}

function Round(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}
