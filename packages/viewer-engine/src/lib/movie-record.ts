/**
 * The page's live recording (sd-export → Live recording): `record_movie` records the live scene while every tool but
 * the time jumps stays open. The scene clock runs under the record lock (TimeControl.BeginRecording: the frame lock at
 * the file's fps), and every grid frame it reaches is captured in its own task and handed to the MovieSink, which
 * encodes it and streams it to the hub. File frame k is scene time T0 + k / fps at ExportFrameMicros(k, fps), so video
 * time is scene time: hold frames (paused, held by a timeline prepare, an off-grid stop) are drawn but never encoded,
 * so a pause leaves no gap and no freeze frame. Node-tested, no runtime import: the director's side is a
 * MovieRecordPort, the encoder an ExportEncoderPort (WebCodecsEncoder in the page).
 *
 * States: preparing (the canvas held at the picture size, the encoder configuring, RECORD_WARMUP_FRAMES drawn at the
 * frozen clock), recording, finishing (the encoder's flush, the hub's save), then done, cancelled or failed. main.ts
 * calls Step(timestamp) instead of the time control while `driving` (null: draw nothing this frame) and AfterFrame()
 * right after engine.Frame, in the same task.
 */

import type { Maybe } from '@dereekb/util';
import { MAX_EXPORT_SECONDS, type MovieExportFile, type MovieRecordPlan, type MovieRecordReport, type MovieRecordStartCommand, type MovieRecordState, movieOutputPlan, RUNNING_MOVIE_RECORD_STATES, SceneError } from '@scene-director/scene';
import { CLOCK_EPOCH_TICKS, TICKS_PER_SECOND } from './clock';
import type { DestinyWorld } from './destiny';
import { ExportFrameCount, ExportFrameMicros, type ExportStepLog } from './export-frames';
import { type ExportCapture, type ExportEncoderPort, EXPORT_FRAME_RETRIES, EXPORT_SAVE_TIMEOUT_MS, ErrorMessage, MovieSink, type MovieSinkPort, Round } from './movie-sink';
import type { TimeControl } from './time-control';

/**
 * Frames drawn at the frozen clock before the first grid frame: the canvas takes the picture size and TAA settles.
 */
export const RECORD_WARMUP_FRAMES = 3;
const LOG_LIMIT = 2000;

/**
 * A grid frame to capture: its file index, world tick and clock.
 */
export interface RecordFrame {
  readonly index: number;
  readonly tick: number;
  readonly clock: number;
}

/**
 * The director's side of a recording.
 */
export interface MovieRecordPort extends MovieSinkPort {
  readonly time: Pick<TimeControl, 'BeginRecording' | 'EndRecording' | 'LockedFrame'>;
  /**
   * The scene clock.
   */
  readonly clock: { readonly now: number };
  readonly world: Pick<DestinyWorld, 'tick'>;
  /**
   * The frame just drawn for a grid frame (seconds: its scene seconds) as an encoder source.
   */
  Capture(frame: RecordFrame, seconds: number): ExportCapture;
  GpuErrors(): number;
  Changed(): void;
}

export interface MovieRecordingConfig {
  readonly id: string;
  readonly plan: MovieRecordPlan;
  readonly port: MovieRecordPort;
  readonly encoder: ExportEncoderPort;
  readonly warnings?: readonly string[];
  readonly saveTimeoutMs?: number;
}

export class MovieRecording {
  readonly id: string;
  readonly plan: MovieRecordPlan;
  state: MovieRecordState = 'preparing';
  file: Maybe<MovieExportFile> = null;
  private readonly port: MovieRecordPort;
  private readonly sink: MovieSink;
  private readonly warnings: string[];
  private began = false;
  private warm = 0;
  private pending: Maybe<{ readonly clock: number; readonly tick: number }> = null;
  /**
   * A grid frame whose capture failed: drawn again at its clock before the clock moves on.
   */
  private redraw: Maybe<{ readonly clock: number; readonly tick: number }> = null;
  /**
   * The last locked frame was a hold (paused, held, a stop): the first one after grid frames forces a progress message.
   */
  private holding = false;
  private frame = 0;
  private lastClock: Maybe<number> = null;
  private readonly log: ExportStepLog[] = [];
  private waiting: Maybe<string> = 'the warm-up';
  private error: Maybe<string> = null;
  private note: Maybe<string> = null;
  private readonly startedAt: number;
  private readonly startedIso: string;
  private endedAt: Maybe<number> = null;
  private readonly gpuStart: number;

  constructor({ id, plan, port, encoder, warnings = [], saveTimeoutMs = EXPORT_SAVE_TIMEOUT_MS }: MovieRecordingConfig) {
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
   * Whether main.ts steps the clock with Step (preparing or recording).
   */
  get driving(): boolean {
    return this.state === 'preparing' || this.state === 'recording';
  }

  /**
   * Whether the recording still runs (preparing to finishing).
   */
  get running(): boolean {
    return RUNNING_MOVIE_RECORD_STATES.has(this.state);
  }

  /**
   * Configures the encoder; main.ts then draws the warm-up frames and the recording begins.
   */
  Start(): void {
    try {
      this.sink.Configure();
      this.port.Changed();
    } catch (error) {
      this.Fail(`the encoder failed: ${ErrorMessage(error)}`);
    }
  }

  /**
   * The frame's clock for main.ts to draw at, or null to draw nothing this frame: waiting on backpressure (the clock does
   * not move), or a wait frame of the record lock. A warm-up, hold or redrawn frame draws at the clock; a grid frame
   * steps the scene to its clock first (LockedFrame) and AfterFrame encodes it.
   *
   * @param timestamp - The animation frame's timestamp, ms.
   * @param drawAnyway - A screenshot waits for a frame: a frame that would draw nothing draws at the clock (never
   *   encoded).
   */
  Step(timestamp: number, drawAnyway = false): Maybe<{ readonly clock: number }> {
    this.pending = null;
    if (!this.driving) return null;
    const hold = drawAnyway ? { clock: this.port.clock.now } : null;
    this.waiting = this.sink.Waiting();
    if (this.waiting) {
      this.sink.Progress();
      return hold;
    }
    if (this.state === 'preparing') return this.WarmUp();
    // Paused or holding, nothing is encoded: the hub's status still hears from the page once a second.
    this.sink.Progress();
    if (this.redraw) {
      this.pending = this.redraw;
      return { clock: this.redraw.clock };
    }
    const locked = this.port.time.LockedFrame(timestamp);
    if (locked.kind === 'wait') return hold;
    if (locked.kind === 'grid') this.pending = { clock: locked.clock, tick: this.port.world.tick };
    // A pause or a beat's end: the hub's status hears the frames recorded up to it now, not up to a second later.
    else if (!this.holding) this.sink.Progress(true);
    this.holding = locked.kind === 'hold';
    return { clock: locked.clock };
  }

  /**
   * Right after engine.Frame, in the same task: captures and encodes the grid frame just drawn as the file's next
   * frame (hold and warm-up frames are drawn only), then stops by itself at the duration or the cap.
   */
  AfterFrame(): void {
    const grid = this.pending;
    this.pending = null;
    if (!grid || this.state !== 'recording') return;
    const index = this.frame;
    const capture = this.port.Capture({ index, tick: grid.tick, clock: grid.clock }, this.SceneSecondsOf(grid.clock));
    if ('error' in capture) {
      if (capture.fatal) this.Fail(capture.error);
      else {
        this.redraw = grid;
        const failed = this.sink.DrawFailed();
        if (failed >= EXPORT_FRAME_RETRIES) this.Fail(`frame ${index} (scene ${Round(this.SceneSecondsOf(grid.clock), 3)} s) failed to draw ${failed} times: ${capture.error}`);
      }
      return;
    }
    this.redraw = null;
    this.sink.Drew();
    const timestamp = ExportFrameMicros(index, this.plan.fps);
    if (!this.sink.Encode(capture.source, { timestamp, duration: ExportFrameMicros(index + 1, this.plan.fps) - timestamp, keyFrame: index % this.plan.keyframeEvery === 0 })) return;
    this.frame = index + 1;
    this.lastClock = grid.clock;
    this.log.push({ index, clock: grid.clock, tick: grid.tick });
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.sink.Progress();
    if (this.frame >= this.plan.maxFrames) this.Stop(this.plan.duration != null ? `its duration (${this.plan.duration} s of video)` : `the cap (${MAX_EXPORT_SECONDS} s of video)`);
  }

  /**
   * Ends the recording and saves the file: the record lock lets go of the clock (the user's lock comes back), then the
   * encoder flushes and the hub writes the file (state finishing, then done). With no frame encoded there is nothing to
   * save: it ends cancelled.
   *
   * @param why - Who stopped it (the note).
   * @returns The report.
   * @throws {Error} When no recording runs, or it is already finishing.
   */
  Stop(why: string): MovieRecordReport {
    if (!this.driving) throw new Error(this.state === 'finishing' ? 'the live recording is already finishing' : `no live recording is running (the last one is ${this.state})`);
    if (this.frame === 0) return this.Cancel(`${why}, before any frame was recorded: no file`);
    this.state = 'finishing';
    this.note = `stopped: ${why}`;
    this.waiting = 'the encoder to flush';
    this.pending = null;
    this.redraw = null;
    this.Release();
    this.port.Changed();
    void this.Finish();
    return this.Report();
  }

  /**
   * Cancels a running recording: the encoder closes, the clock is the user's again, nothing is saved.
   *
   * @param why - Who cancelled (the note).
   * @returns The report.
   * @throws {Error} When the recording is not running.
   */
  Cancel(why: string): MovieRecordReport {
    if (!this.running) throw new Error(`no live recording is running (the last one is ${this.state})`);
    this.state = 'cancelled';
    this.note = `cancelled: ${why}`;
    this.Close();
    this.port.Send({ type: 'export', id: this.id, kind: 'cancelled', report: this.Report() });
    this.port.Changed();
    return this.Report();
  }

  /**
   * A hub message for this recording: saved (the file) or failed (a disk error).
   *
   * @param message - `{ type: "export", id, kind, ... }`.
   */
  OnHub(message: Record<string, unknown>): void {
    this.sink.OnHub(message);
  }

  /**
   * The hub link closed: the recording cannot reach the hub.
   */
  LinkClosed(): void {
    this.Fail('the hub link closed', { quiet: true });
  }

  /**
   * The recording's report (get_state record, the progress messages).
   */
  Report(): MovieRecordReport {
    const now = this.port.now();
    const { fps } = this.plan;
    return {
      id: this.id,
      state: this.state,
      plan: this.plan,
      frame: this.frame,
      seconds: Round(this.frame / fps, 3),
      sceneSeconds: this.lastClock == null ? null : Round(this.SceneSecondsOf(this.lastClock), 3),
      rate: this.sink.Rate(),
      left: Round(Math.max(0, this.plan.maxFrames - this.frame) / fps, 3),
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
   * The last 2,000 encoded frames: { index, clock, tick }.
   */
  Log(): readonly ExportStepLog[] {
    return this.log;
  }

  /**
   * A warm-up frame at the frozen clock; after the last the record lock takes the clock, anchored at now.
   */
  private WarmUp(): Maybe<{ readonly clock: number }> {
    this.warm += 1;
    if (this.warm > RECORD_WARMUP_FRAMES) {
      try {
        this.port.time.BeginRecording({ fps: this.plan.fps });
      } catch (error) {
        this.Fail(ErrorMessage(error));
        return null;
      }
      this.began = true;
      this.state = 'recording';
      this.waiting = null;
      this.sink.Progress(true);
      this.port.Changed();
    }
    return { clock: this.port.clock.now };
  }

  private async Finish(): Promise<void> {
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
   * Fails a running recording; quiet when the hub already knows (its own failure, the link closing).
   */
  private Fail(error: string, { quiet = false }: { readonly quiet?: boolean } = {}): void {
    if (!this.running) return;
    this.state = 'failed';
    this.error = error;
    this.Close();
    if (!quiet) this.port.Send({ type: 'export', id: this.id, kind: 'failed', error, report: this.Report() });
    console.error(`live recording ${this.id} failed: ${error}`);
    this.port.Changed();
  }

  private Close(): void {
    this.waiting = null;
    this.pending = null;
    this.redraw = null;
    this.endedAt = this.port.now();
    this.sink.Close();
    this.Release();
  }

  /**
   * Gives the clock back (EndRecording), once.
   */
  private Release(): void {
    if (!this.began) return;
    this.began = false;
    this.port.time.EndRecording();
  }

  private SceneSecondsOf(clock: number): number {
    return (clock - CLOCK_EPOCH_TICKS) / TICKS_PER_SECOND;
  }
}

/**
 * What the page knows when it plans a recording.
 */
export interface MovieRecordPlanInput {
  readonly command: MovieRecordStartCommand;
  /**
   * The movie block's letterbox (the look a recording takes without its own), or null.
   */
  readonly movieLetterbox: Maybe<number | false>;
  readonly jumping: boolean;
  readonly exporting: boolean;
  readonly recording: boolean;
  readonly paused: boolean;
  /**
   * Why there is no renderer, or null with one.
   */
  readonly noRenderer: Maybe<string>;
}

/**
 * Plans a recording: the page's checks, then the plan. The encoder's preference is filled in after its support check.
 *
 * @param input - The command and the page's facts.
 * @returns The plan (hardware "prefer-hardware" until checked) and its warnings.
 * @throws {SceneError} With every problem found.
 */
export function PlanMovieRecord(input: MovieRecordPlanInput): { readonly plan: MovieRecordPlan; readonly warnings: string[] } {
  const { command, movieLetterbox, jumping, exporting, recording, paused, noRenderer } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (exporting) problems.push('a movie export is running: export_movie { action: "cancel" } stops it');
  if (recording) problems.push('a live recording is running: record_movie { action: "stop" } ends it');
  if (jumping) problems.push('a time-control jump is running: wait for it');
  if (command.source === 'scene' && noRenderer) problems.push(`no renderer (${noRenderer}): record_movie needs WebGPU; source: "slate" records the timing only`);
  if (problems.length) throw new SceneError(problems.map((problem) => `record_movie: ${problem}`));
  if (paused) warnings.push('the scene is paused: nothing is recorded until it plays (time_control { pause: false } or { play: N })');
  const letterbox = command.letterbox !== undefined ? command.letterbox : (movieLetterbox ?? false);
  const duration = command.duration ?? null;
  const plan: MovieRecordPlan = { ...movieOutputPlan(command, letterbox), duration, maxFrames: Math.max(1, ExportFrameCount(duration ?? MAX_EXPORT_SECONDS, command.fps)) };
  return { plan, warnings };
}

/**
 * Why a page tool is refused while a live recording runs, or null when it runs: only what would cut the video (a
 * time_control jump or lock change, a movie seek or retake, an export_movie start).
 *
 * @param name - The tool.
 * @param args - Its arguments.
 * @returns The refusal, or null.
 */
export function RecordRefusal(name: string, args: Record<string, unknown>): Maybe<string> {
  const stop = 'record_movie { action: "stop" } ends it';
  let refusal: Maybe<string> = null;
  if (name === 'time_control') {
    const cut = (['back', 'seek', 'fps'] as const).filter((key) => args[key] !== undefined);
    if (cut.length) refusal = `a live recording is running: time_control ${cut.join(' / ')} would cut the video (${stop})`;
  } else if (name === 'movie' && (args['action'] === 'seek' || args['action'] === 'retake')) refusal = `a live recording is running: movie ${String(args['action'])} would cut the video (${stop})`;
  else if (name === 'export_movie' && args['action'] === 'start') refusal = `a live recording is running: one movie at a time (${stop})`;
  return refusal;
}

/**
 * The overlay's record row.
 *
 * @param report - The recording's report.
 * @returns Such as `recording · 1:23.4 · 2,502 frames · 30 fps · 0.42× real time · Esc stops`.
 */
export function RecordText(report: MovieRecordReport): string {
  if (report.state === 'failed') return `failed: ${report.error ?? 'unknown error'}`;
  const parts: string[] = [report.state, VideoTime(report.seconds), `${report.frame.toLocaleString('en-US')} frames`];
  if (report.state === 'done') parts.push(report.file?.path ?? 'saved');
  else if (report.state === 'cancelled') parts.push(report.note ?? 'cancelled');
  else {
    parts.push(`${report.plan.fps} fps`);
    if (report.rate.fps > 0) parts.push(`${report.rate.realtime.toFixed(2)}× real time`);
    if (report.waiting) parts.push(`waiting for ${report.waiting}`);
    if (report.state !== 'finishing') parts.push('Esc stops');
  }
  return parts.join(' · ');
}

/**
 * Seconds of video as "1:23.4".
 */
function VideoTime(seconds: number): string {
  const tenths = Math.max(0, Math.floor(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
