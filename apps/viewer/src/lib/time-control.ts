/**
 * Time control on the scene clock (sd-time): pause, slow motion and fast-forward. Each animation frame asks the clock
 * for its target (SceneClock.Next: the real frame time at the rate), then steps the Destiny parks to it one tick
 * boundary at a time, setting the clock at each boundary first. So every pending order, Follow the FC steering, module
 * cycle, lock and combat roll runs at exactly the time it does at 1×, however fast the scene runs: fast-forward never
 * jumps the clock. A frame that runs out of its step budget leaves the clock at the last boundary it stepped and the
 * next frame steps on from there; Report gives the rate actually kept.
 *
 * The frame drivers (main.ts) still run once per frame, at the frame's final time: at 4× the shots and moments of the
 * frame's ticks draw together.
 *
 * Node-tested (time-control.spec.ts): it imports no runtime.
 */

import type { Maybe } from '@dereekb/util';
import { AUDIBLE_MAX_RATE, MAX_TIME_RATE, MIN_TIME_RATE, isTimeRate, type TimeAudioState, type TimeReport } from '@scene-director/scene';
import { MAX_FRAME_STEP_MS, TICKS_PER_MS, type SceneClock } from './clock';
import type { DestinyWorld } from './destiny';

/**
 * The most real time one frame spends stepping ticks. Past it the clock waits at the last boundary stepped.
 */
export const FRAME_STEP_BUDGET_MS = 40;
/**
 * How much real time the effective rate is measured over.
 */
export const EFFECTIVE_RATE_WINDOW_MS = 1000;
/**
 * Below this share of the asked rate, Report gives the effective rate.
 */
export const BEHIND_SHARE = 0.95;

/**
 * What the page's presentation does with the clock's state: the AudioContext suspends while paused, and the sounds
 * mute above AUDIBLE_MAX_RATE.
 */
export interface TimePresentation {
  readonly paused: boolean;
  readonly muted: boolean;
}

/**
 * The page side of time control (the Director attaches it once it exists).
 */
export interface TimeControlPort {
  /**
   * Called on attach and whenever pause or the muting changes.
   */
  Presentation(presentation: TimePresentation): void;
}

export interface TimeControlConfig {
  readonly clock: SceneClock;
  readonly world: Pick<DestinyWorld, 'Tick' | 'NextBoundaryTime' | 'tick'>;
  /**
   * Real time in milliseconds, for the step budget (default performance.now).
   */
  readonly realNow?: () => number;
  /**
   * The step budget, ms (default FRAME_STEP_BUDGET_MS).
   */
  readonly budgetMs?: number;
}

export class TimeControl {
  private readonly clock: SceneClock;
  private readonly world: TimeControlConfig['world'];
  private readonly realNow: () => number;
  private readonly budgetMs: number;
  private port: Maybe<TimeControlPort> = null;
  private presented = '';
  private tickError: Maybe<string> = null;
  private lastFrameMs: Maybe<number> = null;
  private windowReal = 0;
  private windowScene = 0;
  private measured: Maybe<number> = null;

  constructor({ clock, world, realNow = () => performance.now(), budgetMs = FRAME_STEP_BUDGET_MS }: TimeControlConfig) {
    this.clock = clock;
    this.world = world;
    this.realNow = realNow;
    this.budgetMs = budgetMs;
  }

  get rate(): number {
    return this.clock.rate;
  }

  get paused(): boolean {
    return this.clock.paused;
  }

  /**
   * Whether the page's sounds are muted for the rate.
   */
  get muted(): boolean {
    return this.clock.rate > AUDIBLE_MAX_RATE;
  }

  /**
   * The rate kept over the last measured second, or null before one was measured, while paused or held.
   */
  get effectiveRate(): Maybe<number> {
    return this.measured;
  }

  /**
   * Attaches the page side and hands it the current presentation.
   *
   * @param port - The Director.
   */
  AttachPort(port: TimeControlPort): void {
    this.port = port;
    this.presented = '';
    this.Present();
  }

  /**
   * One animation frame: steps every tick boundary up to the frame's target, setting the clock at each, then sets the
   * clock to the target. A world.Tick failure is logged once per distinct message and ends the frame's stepping.
   *
   * @param frameMs - The animation frame's timestamp, in milliseconds.
   * @returns The clock's time after the frame, in 100 ns ticks: what the frame draws at.
   */
  Frame(frameMs: number): number {
    const before = this.clock.now;
    const target = this.clock.Next(frameMs);
    const start = this.realNow();
    try {
      for (;;) {
        const boundary = this.world.NextBoundaryTime();
        if (boundary == null || boundary > target) {
          // Before the first evolve this Tick anchors the tick grid at the clock (the page's first frame).
          this.clock.Set(target);
          this.world.Tick(target);
          break;
        }
        this.clock.Set(boundary);
        this.world.Tick(boundary);
        // Behind: the clock waits at this boundary and the next frame steps on from it.
        if (this.realNow() - start > this.budgetMs) break;
      }
      this.tickError = null;
    } catch (error) {
      // A failed tick must not end the loop; log each distinct failure once.
      const message = error instanceof Error ? error.message : String(error);
      if (this.tickError !== message) console.error(`destiny tick failed: ${message}\n${(error as Maybe<Error>)?.stack ?? ''}`);
      this.tickError = message;
    }
    this.Measure(frameMs, this.clock.now - before);
    return this.clock.now;
  }

  /**
   * Pauses or plays. Paused, no tick runs; the frames go on drawing at the frozen time.
   *
   * @param paused - True pauses.
   */
  Pause(paused: boolean): void {
    this.clock.paused = paused;
    this.ResetMeasure();
    this.Present();
  }

  /**
   * Sets the clock's rate.
   *
   * @param rate - Scene time per real time, MIN_TIME_RATE to MAX_TIME_RATE.
   * @throws {RangeError} When the rate is out of bounds.
   */
  SetRate(rate: number): void {
    if (!isTimeRate(rate)) throw new RangeError(`the rate must be from ${MIN_TIME_RATE} to ${MAX_TIME_RATE}, not ${rate}`);
    this.clock.rate = rate;
    this.ResetMeasure();
    this.Present();
  }

  /**
   * get_state's `time`.
   */
  Report(): TimeReport {
    const rate = this.clock.rate;
    const paused = this.clock.paused;
    const effective = this.measured;
    const behind = !paused && !this.clock.held && effective != null && effective < BEHIND_SHARE * rate;
    let audio: Maybe<TimeAudioState> = null;
    if (paused) audio = 'suspended';
    else if (this.muted) audio = 'muted';
    return {
      seconds: Math.round(this.clock.seconds * 100) / 100,
      tick: this.world.tick,
      rate,
      paused,
      state: paused ? 'paused' : 'playing',
      ...(behind ? { effectiveRate: Math.round(effective * 100) / 100 } : {}),
      ...(this.clock.held ? { held: true as const } : {}),
      ...(audio ? { audio } : {})
    };
  }

  private Present(): void {
    const presentation: TimePresentation = { paused: this.clock.paused, muted: this.muted };
    const key = `${presentation.paused}:${presentation.muted}`;
    if (!this.port || key === this.presented) return;
    this.presented = key;
    this.port.Presentation(presentation);
  }

  private Measure(frameMs: number, sceneTicks: number): void {
    const last = this.lastFrameMs;
    if (Number.isFinite(frameMs)) this.lastFrameMs = frameMs;
    if (typeof last !== 'number' || !Number.isFinite(frameMs) || this.clock.paused || this.clock.held) {
      if (this.clock.paused || this.clock.held) this.ResetMeasure();
      return;
    }
    this.windowReal += Math.min(Math.max(frameMs - last, 0), MAX_FRAME_STEP_MS);
    this.windowScene += sceneTicks;
    if (this.windowReal >= EFFECTIVE_RATE_WINDOW_MS) {
      this.measured = this.windowScene / (this.windowReal * TICKS_PER_MS);
      this.windowReal = 0;
      this.windowScene = 0;
    }
  }

  private ResetMeasure(): void {
    this.windowReal = 0;
    this.windowScene = 0;
    this.measured = null;
  }
}

/**
 * A rate as the HUD and messages write it.
 *
 * @param rate - Scene time per real time.
 * @returns Such as "4×", "0.25×" or "0.0625×".
 */
export function RateText(rate: number): string {
  return `${Number(rate.toFixed(4))}×`;
}

/**
 * The overlay's time row.
 *
 * @param report - TimeControl.Report.
 * @returns Such as "1×", "paused at 0.25×" or "4× (2.7× actual) · muted".
 */
export function TimeText(report: TimeReport): string {
  let text = report.paused ? `paused at ${RateText(report.rate)}` : RateText(report.rate);
  if (report.effectiveRate != null) text += ` (${RateText(report.effectiveRate)} actual)`;
  if (report.held) text += ' · held for the timeline';
  if (report.audio === 'muted') text += ' · muted';
  return text;
}
