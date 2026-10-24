/**
 * The movie export's frame grid (sd-export): frame i of an export sits at exactly T0 + i / fps on the scene clock,
 * however long the page takes to draw it. Each frame's clock is computed from its index (no accumulation, so no drift:
 * frame k × fps lands on k whole seconds), and ExportStepper moves the clock there through TimeControl.FrameTo, which
 * steps every Destiny boundary on the way. Preroll frames (negative indices) are drawn but not encoded.
 *
 * Node-tested (export-frames.spec.ts): it imports no runtime.
 */

import type { Maybe } from '@dereekb/util';
import { TICKS_PER_SECOND } from './clock';
import type { DestinyWorld } from './destiny';
import type { TimeControl } from './time-control';

/**
 * How many steps ExportStepper.Log keeps.
 */
export const EXPORT_STEP_LOG_LIMIT = 2000;

/**
 * A frame's offset from the export's T0.
 *
 * @param index - The frame index (negative in the preroll).
 * @param fps - Frames a second.
 * @returns 100 ns ticks.
 */
export function ExportFrameTicks(index: number, fps: number): number {
  return Math.round((index * TICKS_PER_SECOND) / fps);
}

/**
 * A frame's timestamp in the file. A frame lasts until the next one's.
 *
 * @param index - The frame index.
 * @param fps - Frames a second.
 * @returns Microseconds.
 */
export function ExportFrameMicros(index: number, fps: number): number {
  return Math.round((index * 1e6) / fps);
}

/**
 * How many frames a stretch of scene time encodes to.
 *
 * @param seconds - Scene seconds.
 * @param fps - Frames a second.
 */
export function ExportFrameCount(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * How many frames are drawn, not encoded, before the first encoded one: the preroll, never reaching before t = 0.
 *
 * @param preroll - Seconds asked.
 * @param from - The first encoded frame's timeline seconds.
 * @param fps - Frames a second.
 */
export function ExportPrerollFrames(preroll: number, from: number, fps: number): number {
  return Math.max(0, Math.min(Math.round(preroll * fps), Math.floor(from * fps + 1e-9)));
}

/**
 * Where an export's frames sit.
 */
export interface ExportGrid {
  /**
   * T0: the scene clock (100 ns ticks) of frame 0, the first encoded frame.
   */
  readonly origin: number;
  readonly fps: number;
  /**
   * Frames drawn, not encoded, before frame 0 (indices -preroll to -1).
   */
  readonly preroll: number;
  /**
   * Frames encoded (indices 0 to frames - 1).
   */
  readonly frames: number;
}

/**
 * One export frame, after its clock was reached.
 */
export interface ExportStep {
  readonly index: number;
  /**
   * The scene clock, 100 ns ticks.
   */
  readonly clock: number;
  /**
   * The world tick at the clock.
   */
  readonly tick: number;
  /**
   * Whether the frame goes into the file (index ≥ 0).
   */
  readonly encode: boolean;
  /**
   * The file's timestamp and duration, microseconds.
   */
  readonly timestamp: number;
  readonly duration: number;
}

export interface ExportStepLog {
  readonly index: number;
  readonly clock: number;
  readonly tick: number;
}

export interface ExportStepSummary {
  /**
   * Steps taken (preroll included).
   */
  readonly frames: number;
  /**
   * The smallest and largest clock step between consecutive frames, 100 ns ticks (null before two frames).
   */
  readonly minStepTicks: Maybe<number>;
  readonly maxStepTicks: Maybe<number>;
}

export interface ExportStepperConfig {
  readonly time: Pick<TimeControl, 'FrameTo'>;
  readonly world: Pick<DestinyWorld, 'tick'>;
  readonly grid: ExportGrid;
}

/**
 * Walks an export's grid: each Next moves the clock to the next frame (FrameTo) and says what to do with it.
 */
export class ExportStepper {
  readonly grid: ExportGrid;
  private readonly time: ExportStepperConfig['time'];
  private readonly world: ExportStepperConfig['world'];
  private nextIndex: number;
  private last: Maybe<ExportStep> = null;
  private readonly log: ExportStepLog[] = [];
  private steps = 0;
  private minStep: Maybe<number> = null;
  private maxStep: Maybe<number> = null;

  constructor({ time, world, grid }: ExportStepperConfig) {
    this.time = time;
    this.world = world;
    this.grid = grid;
    this.nextIndex = -grid.preroll;
  }

  /**
   * The index of the next frame Next steps to.
   */
  get index(): number {
    return this.nextIndex;
  }

  /**
   * Whether every frame was stepped.
   */
  get done(): boolean {
    return this.nextIndex >= this.grid.frames;
  }

  /**
   * Moves the clock to the next frame. A FrameTo that throws leaves the index where it was, so the next call retries
   * the same frame.
   *
   * @returns The frame, or null when every frame was stepped.
   */
  Next(): Maybe<ExportStep> {
    if (this.done) return null;
    const { origin, fps } = this.grid;
    const index = this.nextIndex;
    const clock = this.time.FrameTo(origin + ExportFrameTicks(index, fps));
    const timestamp = ExportFrameMicros(index, fps);
    const step: ExportStep = { index, clock, tick: this.world.tick, encode: index >= 0, timestamp, duration: ExportFrameMicros(index + 1, fps) - timestamp };
    if (this.last) {
      const delta = clock - this.last.clock;
      this.minStep = Math.min(this.minStep ?? delta, delta);
      this.maxStep = Math.max(this.maxStep ?? delta, delta);
    }
    this.log.push({ index, clock, tick: step.tick });
    if (this.log.length > EXPORT_STEP_LOG_LIMIT) this.log.shift();
    this.steps += 1;
    this.nextIndex += 1;
    this.last = step;
    return step;
  }

  /**
   * The last frame again, without stepping: a draw that failed is retried at the same clock.
   */
  Again(): Maybe<ExportStep> {
    return this.last;
  }

  /**
   * The last EXPORT_STEP_LOG_LIMIT steps, oldest first.
   */
  Log(): readonly ExportStepLog[] {
    return this.log;
  }

  Summary(): ExportStepSummary {
    return { frames: this.steps, minStepTicks: this.minStep, maxStepTicks: this.maxStep };
  }
}
