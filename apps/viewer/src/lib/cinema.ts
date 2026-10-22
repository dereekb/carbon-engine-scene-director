/**
 * The cinematic camera rig: plays camera shots and sequences (packages/scene cinema/shot.ts) on the scene clock.
 *
 * Every frame, between world.Tick and engine.Frame, the director hands it the scene as drawn (CinemaScene); the rig
 * resolves the shot's hardpoint on it, plays the moves (cinema-moves.ts), trails the eye and look by the shot's lag,
 * blends in from the previous pose, keeps the eye out of every hull and picks clip planes. The engine's FreeCamera
 * then writes the result into EveCamera's view and projection.
 *
 * - Time is the scene clock's: a paused clock holds the shot, fixed steps replay it exactly.
 * - A sequence advances on each shot's duration; the last shot holds unless it has one, and then the rig releases.
 * - Releasing blends from the last cinematic pose back to the orbit camera over CINEMA_RELEASE_SECONDS; with `adopt`
 *   the orbit is first set to the cinematic eye and look, so a drag continues from the image.
 * - A subject that left the scene ends the shot (released, with a note).
 *
 * Node-tested: it imports only the scene package, the clock and cinema-moves.ts.
 */

import type { Maybe } from '@dereekb/util';
import {
  cameraClips,
  cameraPathAnchors,
  cameraShotSubjects,
  HULL_CLEARANCE,
  cinemaSpheres,
  clearHulls,
  normalizeCameraSequence,
  normalizeCameraShot,
  resolveHardpoint,
  rollPose,
  toOrbitView,
  WORLD_UP,
  blendPoses,
  type CameraPose,
  type CameraShot,
  type CinemaScene,
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

export type CinemaState = 'idle' | 'playing' | 'releasing';

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
  readonly shots: number;
  readonly warnings: string[];
}

export interface CinemaReleaseOptions {
  /**
   * Return the orbit view at the cinematic eye and look, for the orbit camera to take over from the image.
   */
  readonly adopt?: boolean;
  readonly note?: string;
}

/**
 * The shot playing, in get_state.
 */
export interface CinemaShotReport {
  readonly name?: string;
  readonly hardpoint?: CameraShot['hardpoint'];
  readonly pose?: CameraShot['pose'];
  readonly moves: string[];
  readonly transition: CameraShot['transition']['type'];
  readonly elapsed: number;
  readonly duration: Maybe<number>;
  /**
   * elapsed / duration; null while it holds.
   */
  readonly progress: Maybe<number>;
}

export interface CinemaReport {
  readonly state: CinemaState;
  readonly driver: Maybe<string>;
  readonly shot: Maybe<CinemaShotReport>;
  readonly sequence: Maybe<{ readonly index: number; readonly count: number }>;
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
   * The scene tick the shot started at.
   */
  readonly start: number;
  readonly seed: number;
  anchor: Maybe<SceneVector>;
  /**
   * The pose a blend starts from; null until the first frame captures the drawn one.
   */
  blendFrom: Maybe<CameraPose>;
}

interface Release {
  readonly start: number;
  readonly from: CameraPose;
  readonly near: number;
  readonly far: number;
}

export class CinemaRig {
  private state: CinemaState = 'idle';
  private driver: Maybe<string> = null;
  private shots: CameraShot[] = [];
  private index = 0;
  private run: Maybe<ShotRun> = null;
  private release: Maybe<Release> = null;
  private last: Maybe<{ readonly pose: CameraPose; readonly near: number; readonly far: number }> = null;
  private smoothed: Maybe<{ eye: SceneVector; look: SceneVector }> = null;
  private lastTick: Maybe<number> = null;
  private note: Maybe<string> = null;
  private reportedAt = 0;

  /**
   * True while a shot plays or the release blend runs.
   */
  get active(): boolean {
    return this.state !== 'idle';
  }

  get playing(): boolean {
    return this.state === 'playing';
  }

  /**
   * Plays a shot, or a sequence (`{ shots: [...] }` or an array). A blend transition starts from the pose drawn last
   * frame; a cut starts on the hardpoint.
   *
   * @param input - The shot or sequence JSON.
   * @param now - The scene clock, in integer 100 ns ticks.
   * @param driver - Who asked (get_state's `cinema.driver`).
   * @returns The new state and any warnings.
   * @throws {Error} When the shot or sequence is invalid.
   */
  Play(input: unknown, now: number, driver = 'claude'): CinemaPlayResult {
    const sequence = Array.isArray(input) || (typeof input === 'object' && input !== null && (input as Record<string, unknown>)['shots'] != null);
    const normalized = sequence ? normalizeCameraSequence(input) : normalizeCameraShot(input);
    const shots = 'sequence' in normalized ? (normalized.sequence?.shots ?? null) : normalized.shot ? [normalized.shot] : null;
    if (!shots?.length) throw new Error(`Invalid camera ${sequence ? 'sequence' : 'shot'}:\n- ${normalized.problems.join('\n- ')}`);
    // A new play while one runs blends from its pose; from idle or a release it captures the drawn pose.
    if (this.state !== 'playing') this.last = null;
    this.shots = [...shots];
    this.index = 0;
    this.driver = driver;
    this.note = null;
    this.release = null;
    this.state = 'playing';
    this.StartShot(now);
    return { state: this.state, shots: shots.length, warnings: normalized.warnings };
  }

  /**
   * Stops the shot: a release blend back to the orbit camera, or with `cut` straight back.
   */
  Stop(now: number, { cut = false, note }: { readonly cut?: boolean; readonly note?: string } = {}): void {
    if (cut) {
      if (note && this.state !== 'idle') this.note = note;
      this.state = 'idle';
      this.run = null;
      this.release = null;
      this.smoothed = null;
    } else {
      this.Release(now, { note });
    }
  }

  /**
   * Hands the camera back to the orbit camera with a short blend.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @param options - `adopt` returns the orbit view at the cinematic eye and look.
   * @returns The orbit view to adopt, when asked and a shot was playing.
   */
  Release(now: number, { adopt = false, note }: CinemaReleaseOptions = {}): Maybe<OrbitView> {
    if (this.state !== 'playing') return null;
    if (note) this.note = note;
    const last = this.last;
    this.run = null;
    this.smoothed = null;
    if (last) {
      this.release = { start: now, from: last.pose, near: last.near, far: last.far };
      this.state = 'releasing';
    } else {
      this.state = 'idle';
    }
    return adopt && last ? toOrbitView(last.pose) : null;
  }

  /**
   * The ship ids the shot depends on.
   */
  Subjects(): string[] {
    return this.state === 'playing' ? cameraShotSubjects(this.run?.shot) : [];
  }

  /**
   * The frame's presentation the shot asks for; undefined fields keep the page's.
   */
  Presentation(): { readonly letterbox?: number | false; readonly hud?: boolean } {
    const shot = this.state === 'playing' ? this.run?.shot : null;
    return shot ? { ...(shot.letterbox === undefined ? {} : { letterbox: shot.letterbox }), ...(shot.hud === undefined ? {} : { hud: shot.hud }) } : {};
  }

  /**
   * The camera for the frame at `now`, or null when the orbit camera has it.
   *
   * @param now - The scene clock, in integer 100 ns ticks.
   * @param sceneOf - The scene as drawn at `now` (built only while a shot plays).
   */
  Frame(now: number, sceneOf: () => CinemaScene): Maybe<CinemaFrame> {
    const seconds = this.lastTick == null ? 0 : Math.max(0, (now - this.lastTick) / TICKS_PER_SECOND);
    this.lastTick = now;
    this.reportedAt = now;
    let frame: Maybe<CinemaFrame> = null;
    if (this.state === 'playing') frame = this.PlayFrame(now, seconds, sceneOf());
    if (this.state === 'releasing') frame = this.ReleaseFrame(now);
    return frame;
  }

  /**
   * Get_state's `cinema`.
   */
  Report(now = this.reportedAt): CinemaReport {
    const run = this.state === 'playing' ? this.run : null;
    const shot = run?.shot;
    const elapsed = run ? Math.max(0, (now - run.start) / TICKS_PER_SECOND) : 0;
    const pose = this.state === 'idle' ? null : this.last?.pose;
    const presentation = this.Presentation();
    return {
      state: this.state,
      driver: this.state === 'idle' ? null : this.driver,
      shot:
        run && shot
          ? {
              ...(shot.name ? { name: shot.name } : {}),
              ...(shot.hardpoint ? { hardpoint: shot.hardpoint } : {}),
              ...(shot.pose ? { pose: shot.pose } : {}),
              moves: shot.moves.map((move) => move.type),
              transition: shot.transition.type,
              elapsed: Round(elapsed, 100),
              duration: shot.duration ?? null,
              progress: shot.duration ? Round(Math.min(1, elapsed / shot.duration), 1000) : null
            }
          : null,
      sequence: this.shots.length > 1 && this.state === 'playing' ? { index: this.index, count: this.shots.length } : null,
      pose: pose ? { eye: pose.eye.map((value) => Round(value, 100)), look: pose.look.map((value) => Round(value, 100)), up: pose.up.map((value) => Round(value, 1000)), fov: Round(pose.fov, 100) } : null,
      near: this.state === 'idle' || !this.last ? null : Round(this.last.near, 1000),
      far: this.state === 'idle' || !this.last ? null : Math.round(this.last.far),
      letterbox: presentation.letterbox ?? null,
      hud: presentation.hud ?? null,
      note: this.note
    };
  }

  private StartShot(now: number): void {
    const shot = this.shots[this.index];
    const blend = shot.transition.type === 'blend';
    this.run = { shot, start: now, seed: SeedOf(`${this.index}:${JSON.stringify(shot)}`), anchor: null, blendFrom: blend ? (this.last?.pose ?? null) : null };
    if (!blend) this.smoothed = null;
  }

  private PlayFrame(now: number, seconds: number, scene: CinemaScene): Maybe<CinemaFrame> {
    let run = this.run;
    // Advance the sequence on each shot's duration, from its exact end so the timing never drifts.
    while (run?.shot.duration != null && now - run.start >= run.shot.duration * TICKS_PER_SECOND) {
      if (this.index + 1 >= this.shots.length) {
        this.Release(now, { note: this.shots.length > 1 ? 'the sequence finished' : 'the shot finished' });
        return null;
      }
      const end = run.start + Math.round(run.shot.duration * TICKS_PER_SECOND);
      this.index += 1;
      this.StartShot(end);
      run = this.run;
    }
    if (!run) return null;
    const { shot } = run;
    const t = (now - run.start) / TICKS_PER_SECOND;
    let base: Maybe<CameraPose> = null;
    let subject: Maybe<SubjectFrame> = null;
    if (shot.hardpoint) {
      const resolved = resolveHardpoint(shot.hardpoint, scene, run.anchor);
      if (resolved.anchor && !run.anchor) run.anchor = resolved.anchor;
      base = resolved.pose;
      subject = resolved.subject;
      if (!base) {
        this.Release(now, { note: resolved.note ?? 'the hardpoint has no pose' });
        return null;
      }
      this.note = resolved.note ?? null;
    } else if (shot.pose) {
      const { eye, look, up, roll, fov } = shot.pose;
      base = { eye: [...eye], look: [...look], up: up ? [...up] : [...WORLD_UP], fov: fov ?? CINEMA_DEFAULT_FOV };
      if (roll) base = rollPose(base, roll);
    }
    if (!base) return null;
    const moved = EvaluateMoves(base, shot.moves, t, { subject, seed: run.seed, shotDuration: shot.duration ?? null, scene });
    const lookLag = Math.max(shot.lag.look, TrackLag(shot.moves, t));
    const smoothed = this.smoothed ?? { eye: moved.eye, look: moved.look };
    this.smoothed = { eye: Smooth(smoothed.eye, moved.eye, seconds, shot.lag.eye), look: Smooth(smoothed.look, moved.look, seconds, lookLag) };
    let pose: CameraPose = { ...moved, eye: this.smoothed.eye, look: this.smoothed.look };
    if (shot.transition.type === 'blend') {
      run.blendFrom ??= scene.camera ?? null;
      if (run.blendFrom) pose = blendPoses(run.blendFrom, pose, Ease(shot.transition.easing, t / shot.transition.duration));
    }
    // The hulls a path rides on are exempt from clearance: its waypoints put the eye there on purpose (a pass over a hull).
    const spheres = cinemaSpheres(scene);
    const eye = shot.clearance === false ? pose.eye : clearHulls(pose.eye, cinemaSpheres(scene, new Set(cameraPathAnchors(shot))), shot.clearance ?? HULL_CLEARANCE);
    pose = { ...pose, eye };
    const { near, far } = cameraClips({ eye, spheres, reach: scene.reach ?? 0 });
    this.last = { pose, near, far };
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
