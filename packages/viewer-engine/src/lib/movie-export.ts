/**
 * The page's movie export (sd-export): `export_movie` drives the scene on the fixed 1/fps export clock, captures each
 * drawn frame in the frame's own task, and hands it to the MovieSink (movie-sink.ts), which encodes it with WebCodecs
 * and streams the chunks to the hub, which writes the MP4. Node-tested, no runtime import: the director's side is a
 * MovieExportPort, the encoder an ExportEncoderPort (WebCodecsEncoder in the page).
 *
 * States: preparing (the page locked, the restart and its prepare), seeking (the silent seek to the preroll's start),
 * prerolling (frames drawn, not encoded), rendering, finishing (the encoder's flush, the hub's save), then done,
 * cancelled or failed. main.ts calls Step() instead of TimeControl.Frame while `driving` (null: draw nothing this
 * frame, the export waits) and AfterFrame() right after engine.Frame, in the same task.
 */

import type { Maybe } from '@dereekb/util';
import { MAX_EXPORT_SECONDS, type MovieExportFile, type MovieExportPlan, type MovieExportReport, type MovieExportStartCommand, type MovieExportState, movieOutputPlan, RUNNING_MOVIE_EXPORT_STATES, SceneError, type TimelineState } from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import type { DestinyWorld } from './destiny';
import { ExportFrameCount, ExportFrameTicks, ExportPrerollFrames, type ExportStep, type ExportStepLog, ExportStepper, type ExportStepSummary } from './export-frames';
import { type ExportCapture, type ExportEncoderPort, EXPORT_FRAME_RETRIES, EXPORT_SAVE_TIMEOUT_MS, ErrorMessage, MovieSink, type MovieSinkPort, Round } from './movie-sink';
import type { TimeControl } from './time-control';

export { type ExportCapture, type ExportChunk, type ExportChunkMetadata, type ExportEncoderConfig, type ExportEncoderPort, EXPORT_FRAME_RETRIES, EXPORT_SAVE_TIMEOUT_MS, MAX_EXPORT_ENCODE_QUEUE, MAX_EXPORT_SOCKET_BYTES, WebCodecsEncoder } from './movie-sink';

/**
 * The page tools an export leaves working (reads, the screenshot of the export's frame, save, export_movie itself); the
 * timeline, movie and time_control status forms work too. Every other tool is refused (an allow-list).
 */
export const EXPORT_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['get_state', 'get_scene', 'get_overview', 'list_hardpoints', 'screenshot', 'list_scenes', 'save_scene', 'export_movie']);

/**
 * The director's side of an export.
 */
export interface MovieExportPort extends MovieSinkPort {
  readonly time: Pick<TimeControl, 'BeginExport' | 'FrameTo' | 'EndExport' | 'exporting'>;
  /**
   * The scene clock.
   */
  readonly clock: { readonly now: number };
  readonly world: Pick<DestinyWorld, 'tick'>;
  /**
   * Locks the page for the export (true: tools, input, audio muted, the fixed size and look) or gives it back.
   */
  Lock(on: boolean): void;
  /**
   * Replays the movie from its placements: restarted held at t = 0, prepared, then played with the clock paused.
   *
   * @returns t = 0's clock (the next boundary).
   */
  Restart(): Promise<number>;
  /**
   * The clock of t = 0 of the run, or null before the timeline started.
   */
  TimelineOrigin(): Maybe<number>;
  /**
   * Whether the time window holds a snapshot to seek with.
   */
  CanSeek(): boolean;
  /**
   * A silent seek to a clock (time-control jumps); its warnings.
   */
  Seek(clock: number): Promise<string[]>;
  /**
   * The frame just drawn for a step (time: its timeline seconds) as an encoder source.
   */
  Capture(step: ExportStep, time: number): ExportCapture;
  GpuErrors(): number;
  Changed(): void;
}

export interface MovieExportConfig {
  readonly id: string;
  readonly plan: MovieExportPlan;
  readonly port: MovieExportPort;
  readonly encoder: ExportEncoderPort;
  readonly warnings?: readonly string[];
  readonly saveTimeoutMs?: number;
}

export class MovieExport {
  readonly id: string;
  readonly plan: MovieExportPlan;
  state: MovieExportState = 'preparing';
  file: Maybe<MovieExportFile> = null;
  private readonly port: MovieExportPort;
  private readonly sink: MovieSink;
  private readonly warnings: string[];
  private stepper: Maybe<ExportStepper> = null;
  private locked = false;
  private began = false;
  private origin = 0;
  private pending: Maybe<ExportStep> = null;
  private last: Maybe<ExportStep> = null;
  private redraw = false;
  private frame = 0;
  private waiting: Maybe<string> = 'the scene to prepare';
  private error: Maybe<string> = null;
  private note: Maybe<string> = null;
  private readonly startedAt: number;
  private readonly startedIso: string;
  private endedAt: Maybe<number> = null;
  private readonly gpuStart: number;

  constructor({ id, plan, port, encoder, warnings = [], saveTimeoutMs = EXPORT_SAVE_TIMEOUT_MS }: MovieExportConfig) {
    this.id = id;
    this.plan = plan;
    this.port = port;
    this.warnings = [...warnings];
    this.startedAt = port.now();
    this.startedIso = new Date().toISOString();
    this.gpuStart = port.GpuErrors();
    this.sink = new MovieSink({ id, output: plan, port, encoder, saveTimeoutMs, running: () => this.running, report: () => this.Report(), fail: (error, options) => this.Fail(error, options) });
  }

  /**
   * Whether main.ts steps the clock with Step (prerolling or rendering).
   */
  get driving(): boolean {
    return this.state === 'prerolling' || this.state === 'rendering';
  }

  /**
   * Whether the export still runs (preparing to finishing): the page stays locked.
   */
  get running(): boolean {
    return RUNNING_MOVIE_EXPORT_STATES.has(this.state);
  }

  /**
   * Locks the page, replays or reaches the movie's start, seeks to the preroll and begins the export clock; main.ts
   * then drives the frames. A failure fails the export (it never throws).
   */
  async Start(): Promise<void> {
    const { plan, port } = this;
    try {
      port.Lock(true);
      this.locked = true;
      port.Changed();
      let zero: number;
      if (plan.restart) zero = await port.Restart();
      else if (plan.timeline) {
        const origin = port.TimelineOrigin();
        if (origin == null) throw new Error('the timeline has not started: restart: true replays it');
        zero = origin;
      } else zero = port.clock.now;
      if (!this.running) return;
      this.origin = zero + Math.round(plan.from * TICKS_PER_SECOND);
      const start = this.origin + ExportFrameTicks(-plan.preroll.frames, plan.fps);
      this.state = 'seeking';
      this.waiting = 'the seek';
      port.Changed();
      const now = port.clock.now;
      let fastForward = false;
      if (start < now || start - now > TICKS_PER_SECOND) {
        if (port.CanSeek()) this.warnings.push(...(await port.Seek(start)));
        else if (start > now) {
          fastForward = true;
          this.warnings.push(`the scene did not settle in its prepare, so the export fast-forwarded to ${Round(this.TimeOf(start), 3)} s instead of seeking`);
        } else throw new Error(`nothing is recorded to seek back to ${Round(this.TimeOf(start), 3)} s with`);
      }
      if (!this.running) return;
      port.time.BeginExport({ fps: plan.fps });
      this.began = true;
      if (fastForward) port.time.FrameTo(start);
      this.sink.Configure();
      this.stepper = new ExportStepper({ time: port.time, world: port.world, grid: { origin: this.origin, fps: plan.fps, preroll: plan.preroll.frames, frames: plan.frames } });
      this.waiting = null;
      this.state = plan.preroll.frames > 0 ? 'prerolling' : 'rendering';
      port.Changed();
    } catch (error) {
      this.Fail(ErrorMessage(error));
    }
  }

  /**
   * The next frame's step for main.ts (FrameTo already stepped the scene to it), or null to draw nothing this frame:
   * not driving, waiting (backpressure, a hidden tab) or a step that threw (retried next frame).
   */
  Step(): Maybe<ExportStep> {
    const stepper = this.stepper;
    if (!this.driving || !stepper) return null;
    this.waiting = this.sink.Waiting();
    if (this.waiting) {
      this.sink.Progress();
      return null;
    }
    let step: Maybe<ExportStep> = null;
    if (this.redraw) step = stepper.Again();
    else {
      try {
        step = stepper.Next();
      } catch (error) {
        this.DrawFailed(stepper.index, ErrorMessage(error));
        return null;
      }
    }
    this.pending = step;
    return step;
  }

  /**
   * Right after engine.Frame, in the same task: captures the frame drawn for the pending step and encodes it (a
   * preroll frame is drawn only), then finishes after the last.
   */
  AfterFrame(): void {
    const step = this.pending;
    this.pending = null;
    const stepper = this.stepper;
    if (!step || !stepper || !this.driving) return;
    const capture = this.port.Capture(step, this.TimeOf(step.clock));
    if ('error' in capture) {
      if (capture.fatal) this.Fail(capture.error);
      else {
        this.redraw = true;
        this.DrawFailed(step.index, capture.error);
      }
      return;
    }
    this.redraw = false;
    this.last = step;
    this.sink.Drew();
    if (step.encode) {
      if (!this.sink.Encode(capture.source, { timestamp: step.timestamp, duration: step.duration, keyFrame: step.index % this.plan.keyframeEvery === 0 })) return;
      this.frame = step.index + 1;
    }
    if (this.state === 'prerolling' && stepper.index >= 0) {
      this.state = 'rendering';
      this.port.Changed();
    }
    this.sink.Progress();
    if (stepper.done) void this.Finish();
  }

  /**
   * Cancels a running export: the encoder closes, the clock pauses at the last frame, the page unlocks.
   *
   * @param why - Who cancelled (the note).
   * @returns The report.
   * @throws {Error} When the export is not running.
   */
  Cancel(why: string): MovieExportReport {
    if (!this.running) throw new Error(`no movie export is running (the last one is ${this.state})`);
    this.state = 'cancelled';
    this.note = `cancelled: ${why}`;
    this.Stop();
    this.port.Send({ type: 'export', id: this.id, kind: 'cancelled', report: this.Report() });
    this.port.Changed();
    return this.Report();
  }

  /**
   * A hub message for this export: saved (the file) or failed (a disk error).
   *
   * @param message - `{ type: "export", id, kind, ... }`.
   */
  OnHub(message: Record<string, unknown>): void {
    this.sink.OnHub(message);
  }

  /**
   * The hub link closed: the export cannot reach the hub.
   */
  LinkClosed(): void {
    this.Fail('the hub link closed', { quiet: true });
  }

  /**
   * The export's report (get_state export, the progress messages).
   */
  Report(): MovieExportReport {
    const now = this.port.now();
    const rate = this.sink.Rate();
    const left = this.plan.frames - this.frame;
    let eta: Maybe<number> = null;
    if (this.state === 'done') eta = 0;
    else if (this.state === 'rendering' && rate.fps > 0) eta = Round(left / rate.fps, 1);
    return {
      id: this.id,
      state: this.state,
      plan: this.plan,
      frame: this.frame,
      frames: this.plan.frames,
      progress: this.plan.frames ? Round(this.frame / this.plan.frames, 4) : 0,
      time: Round(this.last ? this.TimeOf(this.last.clock) : this.plan.from, 4),
      rate,
      eta,
      ...(this.waiting && this.running ? { waiting: this.waiting } : {}),
      encoder: { queue: this.sink.queue, ...this.sink.counts },
      frameMs: this.sink.FrameMs(),
      startedAt: this.startedIso,
      wallSeconds: Round(((this.endedAt ?? now) - this.startedAt) / 1000, 3),
      gpuErrors: this.port.GpuErrors() - this.gpuStart,
      warnings: [...this.warnings],
      ...(this.error ? { error: this.error } : {}),
      ...(this.note ? { note: this.note } : {}),
      ...(this.file ? { file: this.file } : {})
    };
  }

  /**
   * The stepper's last 2,000 steps.
   */
  Log(): readonly ExportStepLog[] {
    return this.stepper?.Log() ?? [];
  }

  Summary(): Maybe<ExportStepSummary> {
    return this.stepper?.Summary() ?? null;
  }

  private DrawFailed(index: number, error: string): void {
    const failed = this.sink.DrawFailed();
    const clock = this.origin + ExportFrameTicks(index, this.plan.fps);
    if (failed >= EXPORT_FRAME_RETRIES) this.Fail(`frame ${index} (timeline ${Round(this.TimeOf(clock), 3)} s) failed to draw ${failed} times: ${error}`);
  }

  private async Finish(): Promise<void> {
    this.state = 'finishing';
    this.waiting = 'the encoder to flush';
    this.Unlock();
    this.port.Changed();
    try {
      await this.sink.Flush();
      if (this.state !== 'finishing') return;
      this.waiting = 'the hub to save the file';
      const file = await this.sink.End();
      if (this.state !== 'finishing') return;
      this.file = file;
      this.state = 'done';
      this.waiting = null;
      this.endedAt = this.port.now();
      this.sink.Close();
      this.port.Changed();
    } catch (error) {
      this.Fail(ErrorMessage(error));
    }
  }

  /**
   * Fails a running export; quiet when the hub already knows (its own failure, the link closing).
   */
  private Fail(error: string, { quiet = false }: { readonly quiet?: boolean } = {}): void {
    if (!this.running) return;
    this.state = 'failed';
    this.error = error;
    this.Stop();
    if (!quiet) this.port.Send({ type: 'export', id: this.id, kind: 'failed', error, report: this.Report() });
    console.error(`movie export ${this.id} failed: ${error}`);
    this.port.Changed();
  }

  private Stop(): void {
    this.waiting = null;
    this.pending = null;
    this.endedAt = this.port.now();
    this.sink.Close();
    this.Unlock();
  }

  private Unlock(): void {
    if (this.began) {
      this.began = false;
      this.port.time.EndExport({ pause: true });
    }
    if (this.locked) {
      this.locked = false;
      this.port.Lock(false);
    }
  }

  /**
   * Timeline seconds (scene seconds from the export's start without a timeline) of a clock.
   */
  private TimeOf(clock: number): number {
    return this.plan.from + (clock - this.origin) / TICKS_PER_SECOND;
  }
}

/**
 * What the page knows when it plans an export.
 */
export interface MovieExportPlanInput {
  readonly command: MovieExportStartCommand;
  /**
   * The scene's timeline, or null without one: its player's state, whether it started (t = 0 passed), whether it holds
   * the clock, the movie block's end and letterbox.
   */
  readonly timeline: Maybe<{ readonly state: TimelineState; readonly started: boolean; readonly held: boolean; readonly end: Maybe<number>; readonly letterbox: Maybe<number | false> }>;
  readonly jumping: boolean;
  readonly exporting: boolean;
  /**
   * Why there is no renderer, or null with one.
   */
  readonly noRenderer: Maybe<string>;
}

/**
 * Plans an export: the page's checks that need the scene (sd-export), then the plan. The encoder's preference is
 * filled in after its support check.
 *
 * @param input - The command and the scene's facts.
 * @returns The plan (hardware "prefer-hardware" until checked) and its warnings.
 * @throws {SceneError} With every problem found.
 */
export function PlanMovieExport(input: MovieExportPlanInput): { readonly plan: MovieExportPlan; readonly warnings: string[] } {
  const { command, timeline, jumping, exporting, noRenderer } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (exporting) problems.push('a movie export is running: export_movie { action: "cancel" } stops it');
  if (jumping) problems.push('a time-control jump is running: wait for it');
  if (command.source === 'scene' && noRenderer) problems.push(`no renderer (${noRenderer}): export_movie needs WebGPU; source: "slate" exports the timing only`);
  let from = 0;
  let to = 0;
  if (!timeline) {
    if (command.from != null || command.to != null || command.restart === true || command.duration == null) problems.push('this scene has no timeline: give duration, seconds from now');
    to = command.duration ?? 0;
  } else {
    from = command.from ?? 0;
    const end = timeline.end;
    if (command.duration != null) to = from + command.duration;
    else if (command.to != null) to = command.to;
    else if (end == null) problems.push('the movie has no end: give to or duration, or movie set { movie: { end } }');
    else if (end <= from) problems.push(`from (${from} s) is at or past the movie's end (${end} s): give to or duration`);
    else to = end;
    if (end != null && to > end) warnings.push(`to is past the movie's end (${end} s): the scene plays on after it`);
    if (command.restart === false) {
      if (timeline.state === 'preparing') problems.push('restart: false: the timeline holds the clock while its scene prepares: wait for it, or restart: true');
      else if (!timeline.started) problems.push(`restart: false needs a started timeline (it is ${timeline.state}): timeline play starts it, or restart: true replays it`);
      else if (timeline.held) problems.push('restart: false: the timeline holds the clock: wait for it, or restart: true');
    }
  }
  const seconds = Math.max(0, to - from);
  if (seconds > MAX_EXPORT_SECONDS) problems.push(`${Round(seconds, 3)} s is longer than an export's ${MAX_EXPORT_SECONDS} s`);
  const frames = ExportFrameCount(seconds, command.fps);
  if (!problems.length && frames < 1) problems.push(`${Round(seconds, 3)} s at ${command.fps} fps is no frame`);
  if (problems.length) throw new SceneError(problems.map((problem) => `export_movie: ${problem}`));
  const restart = timeline ? (command.restart ?? true) : false;
  const letterbox = command.letterbox !== undefined ? command.letterbox : (timeline?.letterbox ?? false);
  const plan: MovieExportPlan = {
    ...movieOutputPlan(command, letterbox),
    from,
    to,
    seconds,
    frames,
    restart,
    timeline: timeline != null,
    preroll: { seconds: command.preroll, frames: ExportPrerollFrames(command.preroll, from, command.fps) }
  };
  return { plan: { ...plan, preroll: { seconds: plan.preroll.frames / command.fps, frames: plan.preroll.frames } }, warnings };
}

/**
 * Whether a page tool still runs during an export: the allow-list, and the status forms of timeline, movie and
 * time_control.
 *
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns True when it may run.
 */
export function ExportAllows(name: string, args: Record<string, unknown>): boolean {
  const given = Object.entries(args).filter(([, value]) => value !== undefined);
  let allowed = EXPORT_ALLOWED_TOOLS.has(name);
  if (name === 'timeline' || name === 'movie') allowed = given.every(([key, value]) => key === 'action' && value === 'status');
  else if (name === 'time_control') allowed = given.length === 0;
  return allowed;
}

/**
 * Why a tool is refused during an export.
 *
 * @param report - The export's report.
 * @returns Such as `a movie export is running (rendering, frame 412 of 2850): export_movie { action: "cancel" } stops it`.
 */
export function ExportRefusal(report: Pick<MovieExportReport, 'state' | 'frame' | 'frames'>): string {
  return `a movie export is running (${report.state}, frame ${report.frame} of ${report.frames}): export_movie { action: "cancel" } stops it`;
}

/**
 * The overlay's export row.
 *
 * @param report - The export's report.
 * @returns Such as `rendering · frame 412/2850 (14 %) · 5.2 fps · 7 min 48 s left · Esc cancels`.
 */
export function ExportText(report: MovieExportReport): string {
  const parts: string[] = [report.state];
  if (report.state === 'done') parts.push(`${report.frames} frames`, report.file?.path ?? 'saved');
  else if (report.state === 'failed') return `failed: ${report.error ?? 'unknown error'}`;
  else if (report.state === 'cancelled') parts.push(`at frame ${report.frame}/${report.frames}`);
  else {
    parts.push(`frame ${report.frame}/${report.frames} (${Math.floor(report.progress * 100)} %)`);
    if (report.rate.fps > 0) parts.push(`${report.rate.fps.toFixed(1)} fps`);
    if (report.eta != null) parts.push(`${DurationText(report.eta)} left`);
    if (report.waiting) parts.push(`waiting for ${report.waiting}`);
    parts.push('Esc cancels');
  }
  return parts.join(' · ');
}

/**
 * Seconds as "7 min 48 s" or "12 s".
 */
function DurationText(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes ? `${minutes} min ${whole % 60} s` : `${whole} s`;
}
