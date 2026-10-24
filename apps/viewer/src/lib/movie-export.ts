/**
 * The page's movie export (sd-export): `export_movie` drives the scene on the fixed 1/fps export clock, captures each
 * drawn frame in the frame's own task, encodes it with WebCodecs and streams the chunks to the hub, which writes the
 * MP4. Node-tested, no runtime import: the director's side is a MovieExportPort, the encoder an ExportEncoderPort
 * (WebCodecsEncoder in the page).
 *
 * States: preparing (the page locked, the restart and its prepare), seeking (the silent seek to the preroll's start),
 * prerolling (frames drawn, not encoded), rendering, finishing (the encoder's flush, the hub's save), then done,
 * cancelled or failed. main.ts calls Step() instead of TimeControl.Frame while `driving` (null: draw nothing this
 * frame, the export waits) and AfterFrame() right after engine.Frame, in the same task.
 */

import type { Maybe } from '@dereekb/util';
import {
  defaultExportBitrate,
  encodeExportPacket,
  EXPORT_KEYFRAME_SECONDS,
  EXPORT_PROGRESS_MS,
  exportBytesToBase64,
  exportCodecString,
  exportPictureRect,
  MAX_EXPORT_SECONDS,
  type MovieExportFile,
  type MovieExportHardware,
  type MovieExportPlan,
  type MovieExportReport,
  type MovieExportStartCommand,
  type MovieExportState,
  type MovieExportTrack,
  RUNNING_MOVIE_EXPORT_STATES,
  SceneError,
  type TimelineState
} from '@scene-director/scene';
import { TICKS_PER_SECOND } from './clock';
import type { DestinyWorld } from './destiny';
import { ExportFrameCount, ExportFrameTicks, ExportPrerollFrames, type ExportStep, type ExportStepLog, ExportStepper, type ExportStepSummary } from './export-frames';
import type { TimeControl } from './time-control';

/**
 * The export waits while the encoder holds more frames than this.
 */
export const MAX_EXPORT_ENCODE_QUEUE = 8;
/**
 * The export waits while the hub link buffers more bytes than this.
 */
export const MAX_EXPORT_SOCKET_BYTES = 8 * 1024 * 1024;
/**
 * A frame that fails to draw this many times fails the export.
 */
export const EXPORT_FRAME_RETRIES = 3;
/**
 * How long the export waits for the hub's `saved`, ms.
 */
export const EXPORT_SAVE_TIMEOUT_MS = 30_000;
/**
 * The page tools an export leaves working (reads, the screenshot of the export's frame, save, export_movie itself); the
 * timeline, movie and time_control status forms work too. Every other tool is refused (an allow-list).
 */
export const EXPORT_ALLOWED_TOOLS: ReadonlySet<string> = new Set(['get_state', 'get_scene', 'get_overview', 'list_hardpoints', 'screenshot', 'list_scenes', 'save_scene', 'export_movie']);
const FRAME_RATE_WINDOW = 30;

/**
 * The frame just drawn, as an encoder source (a canvas), or why it is not (retried; fatal fails the export).
 */
export type ExportCapture = { readonly source: unknown } | { readonly error: string; readonly fatal?: boolean };

/**
 * The director's side of an export.
 */
export interface MovieExportPort {
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
  Send(message: object): boolean;
  SendBinary(bytes: Uint8Array): boolean;
  readonly buffered: number;
  readonly hidden: boolean;
  GpuErrors(): number;
  now(): number;
  Changed(): void;
}

/**
 * An encoded chunk, as WebCodecs gives it.
 */
export interface ExportChunk {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: Maybe<number>;
  readonly byteLength: number;
  copyTo(destination: Uint8Array): void;
}

/**
 * The first chunk's metadata: the decoder config the file carries.
 */
export interface ExportChunkMetadata {
  readonly decoderConfig?: { readonly codec: string; readonly description?: ArrayBuffer | ArrayBufferView; readonly colorSpace?: { readonly primaries?: Maybe<string>; readonly transfer?: Maybe<string>; readonly matrix?: Maybe<string>; readonly fullRange?: Maybe<boolean> } };
}

export interface ExportEncoderConfig {
  readonly codec: MovieExportPlan['codec'];
  readonly codecString: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly bitrate: number;
  readonly hardware: MovieExportHardware;
}

/**
 * The encoder (WebCodecsEncoder in the page, a fake in the specs).
 */
export interface ExportEncoderPort {
  Configure(config: ExportEncoderConfig, output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void, error: (error: Error) => void): void;
  /**
   * Encodes the source (a canvas) as one frame.
   */
  Encode(source: unknown, frame: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }): void;
  /**
   * Frames waiting in the encoder.
   */
  readonly queue: number;
  /**
   * False while the configure is pending.
   */
  readonly ready: boolean;
  Flush(): Promise<void>;
  Close(): void;
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
  private readonly encoder: ExportEncoderPort;
  private readonly warnings: string[];
  private readonly saveTimeoutMs: number;
  private stepper: Maybe<ExportStepper> = null;
  private locked = false;
  private began = false;
  private configured = false;
  private origin = 0;
  private pending: Maybe<ExportStep> = null;
  private last: Maybe<ExportStep> = null;
  private redraw = false;
  private failedDraws = 0;
  private retries = 0;
  private frame = 0;
  private seq = 0;
  private configSent = false;
  private readonly counts = { chunks: 0, keyFrames: 0, bytes: 0 };
  private readonly frameMs = { total: 0, count: 0, max: 0 };
  private lastAfter: Maybe<number> = null;
  private readonly drawTimes: number[] = [];
  private lastProgress: number;
  private waiting: Maybe<string> = 'the scene to prepare';
  private error: Maybe<string> = null;
  private note: Maybe<string> = null;
  private readonly startedAt: number;
  private readonly startedIso: string;
  private endedAt: Maybe<number> = null;
  private readonly gpuStart: number;
  private saved: Maybe<{ readonly resolve: (file: MovieExportFile) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }> = null;

  constructor({ id, plan, port, encoder, warnings = [], saveTimeoutMs = EXPORT_SAVE_TIMEOUT_MS }: MovieExportConfig) {
    this.id = id;
    this.plan = plan;
    this.port = port;
    this.encoder = encoder;
    this.warnings = [...warnings];
    this.saveTimeoutMs = saveTimeoutMs;
    this.startedAt = port.now();
    this.lastProgress = this.startedAt;
    this.startedIso = new Date().toISOString();
    this.gpuStart = port.GpuErrors();
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
      this.encoder.Configure(
        { codec: plan.codec, codecString: plan.codecString, width: plan.width, height: plan.height, fps: plan.fps, bitrate: plan.bitrate, hardware: plan.hardware },
        (chunk, metadata) => this.OnChunk(chunk, metadata),
        (error) => this.Fail(`the encoder failed: ${ErrorMessage(error)}`)
      );
      this.configured = true;
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
    this.waiting = this.Waiting();
    if (this.waiting) {
      this.Progress();
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
    this.failedDraws = 0;
    this.last = step;
    this.Measure();
    if (step.encode) {
      try {
        this.encoder.Encode(capture.source, { timestamp: step.timestamp, duration: step.duration, keyFrame: step.index % this.plan.keyframeEvery === 0 });
      } catch (error) {
        this.Fail(`the encoder failed: ${ErrorMessage(error)}`);
        return;
      }
      this.frame = step.index + 1;
    }
    if (this.state === 'prerolling' && stepper.index >= 0) {
      this.state = 'rendering';
      this.port.Changed();
    }
    this.Progress();
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
    if (message['id'] !== this.id) return;
    if (message['kind'] === 'saved') {
      const saved = this.saved;
      this.saved = null;
      if (saved) {
        clearTimeout(saved.timer);
        saved.resolve(message['file'] as MovieExportFile);
      }
    } else if (message['kind'] === 'failed') this.Fail(String(message['error'] ?? 'the hub failed the export'), { quiet: true });
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
    const rate = this.Rate();
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
      encoder: { queue: this.configured ? this.encoder.queue : 0, ...this.counts },
      frameMs: { mean: this.frameMs.count ? Round(this.frameMs.total / this.frameMs.count, 2) : 0, max: Round(this.frameMs.max, 2), retries: this.retries },
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

  private Waiting(): Maybe<string> {
    let waiting: Maybe<string> = null;
    if (this.port.hidden) waiting = 'the tab is hidden: drawing stops until it shows';
    else if (!this.encoder.ready) waiting = 'the encoder to configure';
    else if (this.encoder.queue > MAX_EXPORT_ENCODE_QUEUE) waiting = `the encoder (${this.encoder.queue} frames queued)`;
    else if (this.port.buffered > MAX_EXPORT_SOCKET_BYTES) waiting = `the hub link (${Round(this.port.buffered / 1048576, 1)} MiB buffered)`;
    return waiting;
  }

  private DrawFailed(index: number, error: string): void {
    this.failedDraws += 1;
    this.retries += 1;
    const clock = this.origin + ExportFrameTicks(index, this.plan.fps);
    if (this.failedDraws >= EXPORT_FRAME_RETRIES) this.Fail(`frame ${index} (timeline ${Round(this.TimeOf(clock), 3)} s) failed to draw ${this.failedDraws} times: ${error}`);
  }

  private OnChunk(chunk: ExportChunk, metadata?: ExportChunkMetadata): void {
    if (!this.running) return;
    if (!this.configSent) {
      const config = metadata?.decoderConfig;
      if (!config?.description) {
        this.Fail('the encoder gave no decoder description (avcC / hvcC) with its first chunk');
        return;
      }
      const colorSpace = config.colorSpace;
      const track: MovieExportTrack = {
        codec: this.plan.codec,
        codecString: config.codec,
        width: this.plan.width,
        height: this.plan.height,
        fps: this.plan.fps,
        description: exportBytesToBase64(BytesOf(config.description)),
        ...(colorSpace ? { colorSpace: { primaries: colorSpace.primaries ?? null, transfer: colorSpace.transfer ?? null, matrix: colorSpace.matrix ?? null, fullRange: colorSpace.fullRange ?? null } } : {})
      };
      if (!this.port.Send({ type: 'export', id: this.id, kind: 'config', track })) {
        this.Fail('the hub link closed', { quiet: true });
        return;
      }
      this.configSent = true;
    }
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const key = chunk.type === 'key';
    if (!this.port.SendBinary(encodeExportPacket({ id: this.id, seq: this.seq++, key, timestamp: chunk.timestamp, duration: chunk.duration ?? 0 }, bytes))) {
      this.Fail('the hub link closed', { quiet: true });
      return;
    }
    this.counts.chunks += 1;
    this.counts.bytes += bytes.byteLength;
    if (key) this.counts.keyFrames += 1;
  }

  private async Finish(): Promise<void> {
    this.state = 'finishing';
    this.waiting = 'the encoder to flush';
    this.Unlock();
    this.port.Changed();
    try {
      await this.encoder.Flush();
      if (this.state !== 'finishing') return;
      this.waiting = 'the hub to save the file';
      if (!this.port.Send({ type: 'export', id: this.id, kind: 'end', report: this.Report() })) throw new Error('the hub link closed');
      const file = await new Promise<MovieExportFile>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.saved = null;
          reject(new Error(`the hub did not confirm the file within ${this.saveTimeoutMs / 1000} s`));
        }, this.saveTimeoutMs);
        this.saved = { resolve, reject, timer };
      });
      if (this.state !== 'finishing') return;
      this.file = file;
      this.state = 'done';
      this.waiting = null;
      this.endedAt = this.port.now();
      this.encoder.Close();
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
    if (this.configured) {
      try {
        this.encoder.Close();
      } catch {
        // Already closed.
      }
    }
    const saved = this.saved;
    this.saved = null;
    if (saved) clearTimeout(saved.timer);
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

  private Measure(): void {
    const now = this.port.now();
    if (this.lastAfter != null) {
      const ms = now - this.lastAfter;
      this.frameMs.total += ms;
      this.frameMs.count += 1;
      this.frameMs.max = Math.max(this.frameMs.max, ms);
    }
    this.lastAfter = now;
    this.drawTimes.push(now);
    if (this.drawTimes.length > FRAME_RATE_WINDOW) this.drawTimes.shift();
  }

  private Rate(): { readonly fps: number; readonly realtime: number } {
    const times = this.drawTimes;
    const span = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
    const fps = span > 0 ? (times.length - 1) / span : 0;
    return { fps: Round(fps, 2), realtime: Round(fps / this.plan.fps, 3) };
  }

  private Progress(): void {
    const now = this.port.now();
    if (now - this.lastProgress < EXPORT_PROGRESS_MS) return;
    this.lastProgress = now;
    this.port.Send({ type: 'export', id: this.id, kind: 'progress', report: this.Report() });
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
  const codec = exportCodecString(command);
  const plan: MovieExportPlan = {
    source: command.source,
    from,
    to,
    seconds,
    frames,
    fps: command.fps,
    width: command.width,
    height: command.height,
    picture: exportPictureRect(command.width, command.height, letterbox),
    letterbox,
    codec: command.codec,
    codecString: codec?.codecString ?? '',
    bitrate: command.bitrate ?? defaultExportBitrate(command),
    hardware: 'prefer-hardware',
    restart,
    timeline: timeline != null,
    preroll: { seconds: command.preroll, frames: ExportPrerollFrames(command.preroll, from, command.fps) },
    keyframeEvery: Math.max(1, Math.round(EXPORT_KEYFRAME_SECONDS * command.fps))
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

/**
 * The WebCodecs encoder (the page): a VideoEncoder configured for the plan, H.264 in avcC or HEVC in hvcC form.
 */
export class WebCodecsEncoder implements ExportEncoderPort {
  private encoder: Maybe<VideoEncoder> = null;

  /**
   * Whether this page encodes video at all.
   */
  static get available(): boolean {
    return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
  }

  /**
   * The encoder preference WebCodecs accepts for a plan: prefer-hardware, else no-preference.
   *
   * @param config - The plan's encoder config (its hardware is ignored).
   * @returns The preference.
   * @throws {Error} When neither is supported.
   */
  static async Support(config: Omit<ExportEncoderConfig, 'hardware'>): Promise<MovieExportHardware> {
    if (!WebCodecsEncoder.available) throw new Error('this browser has no WebCodecs VideoEncoder: use a current Chrome or Edge');
    for (const hardware of ['prefer-hardware', 'no-preference'] as const) {
      const support = await VideoEncoder.isConfigSupported(EncoderConfig({ ...config, hardware })).catch(() => null);
      if (support?.supported) return hardware;
    }
    throw new Error(`the encoder does not support ${config.codecString} (${config.codec}) at ${config.width} × ${config.height}, ${config.fps} fps, ${config.bitrate} bits a second`);
  }

  get queue(): number {
    return this.encoder?.encodeQueueSize ?? 0;
  }

  get ready(): boolean {
    return this.encoder?.state === 'configured';
  }

  Configure(config: ExportEncoderConfig, output: (chunk: ExportChunk, metadata?: ExportChunkMetadata) => void, error: (error: Error) => void): void {
    const encoder = new VideoEncoder({ output: (chunk, metadata) => output(chunk as ExportChunk, (metadata as Maybe<ExportChunkMetadata>) ?? undefined), error });
    encoder.configure(EncoderConfig(config));
    this.encoder = encoder;
  }

  Encode(source: unknown, { timestamp, duration, keyFrame }: { readonly timestamp: number; readonly duration: number; readonly keyFrame: boolean }): void {
    const encoder = this.encoder;
    if (!encoder) throw new Error('the encoder is not configured');
    const frame = new VideoFrame(source as CanvasImageSource, { timestamp, duration });
    try {
      encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }

  async Flush(): Promise<void> {
    await this.encoder?.flush();
  }

  Close(): void {
    const encoder = this.encoder;
    this.encoder = null;
    if (encoder && encoder.state !== 'closed') encoder.close();
  }
}

function EncoderConfig(config: ExportEncoderConfig): VideoEncoderConfig {
  const base = { codec: config.codecString, width: config.width, height: config.height, displayWidth: config.width, displayHeight: config.height, bitrate: config.bitrate, bitrateMode: 'variable', framerate: config.fps, latencyMode: 'quality', hardwareAcceleration: config.hardware } as const;
  return (config.codec === 'hevc' ? { ...base, hevc: { format: 'hevc' } } : { ...base, avc: { format: 'avc' } }) as VideoEncoderConfig;
}

function BytesOf(source: ArrayBuffer | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
}

function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
