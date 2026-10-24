/**
 * The scene clock: one integer 100 ns tick count that both the Destiny parks (destiny.ts) and the renderer sample
 * with. The page's animation loop asks it for the frame's target time (Next: the real frame time at its rate), then
 * TimeControl (time-control.ts) steps the parks to it one tick boundary at a time, setting the clock at each (Set),
 * then draws at it.
 */

import type { Maybe } from '@dereekb/util';
import { DEFAULT_TIME_RATE, isTimeRate, MAX_TIME_RATE, MIN_TIME_RATE } from '@scene-director/scene';

/**
 * Destiny and Blue time units: 100 ns ticks.
 */
export const TICKS_PER_SECOND = 10_000_000;
export const TICKS_PER_MS = 10_000;
/**
 * Where the clock starts: past the ClientBall's two-tick sampling shift (2 s), so a new ball's first samples never
 * read its zero-initialized cache.
 */
export const CLOCK_EPOCH_TICKS = 3 * TICKS_PER_SECOND;
/**
 * The most one real frame may count for, before the rate. A hidden tab or a debugger pause stalls frames; capping the
 * step pauses the scene instead of fast-forwarding it. At 1× it also keeps the master park's backlog drop (6+ ticks)
 * from firing; above that TimeControl steps the ticks one by one.
 */
export const MAX_FRAME_STEP_MS = 1000;

export class SceneClock {
  private ticks = CLOCK_EPOCH_TICKS;
  private lastFrameMs: Maybe<number> = null;
  private holding = false;
  private timeRate = DEFAULT_TIME_RATE;
  private pausing = false;

  /**
   * Whether the clock is held (Hold): frames are recorded but add no ticks.
   */
  get held(): boolean {
    return this.holding;
  }

  /**
   * Whether the clock is paused (time control): frames are recorded but add no ticks.
   */
  get paused(): boolean {
    return this.pausing;
  }

  set paused(paused: boolean) {
    this.pausing = paused;
  }

  /**
   * Scene time per real time: 1 is real time, 0.25 slow motion, 4 fast-forward.
   */
  get rate(): number {
    return this.timeRate;
  }

  /**
   * @throws {RangeError} When the rate is outside [MIN_TIME_RATE, MAX_TIME_RATE].
   */
  set rate(rate: number) {
    if (!isTimeRate(rate)) throw new RangeError(`the clock rate must be from ${MIN_TIME_RATE} to ${MAX_TIME_RATE}, not ${rate}`);
    this.timeRate = rate;
  }

  /**
   * The current time, in integer 100 ns ticks.
   */
  get now(): number {
    return this.ticks;
  }

  /**
   * Scene seconds since the epoch.
   */
  get seconds(): number {
    return (this.ticks - CLOCK_EPOCH_TICKS) / TICKS_PER_SECOND;
  }

  /**
   * The frame's target time: now plus the time since the previous frame, capped at MAX_FRAME_STEP_MS, times the rate.
   * The first call, and every call while the clock is held or paused, targets now. It records the frame time but does
   * not move the clock (Set does).
   *
   * @param frameMs - The animation frame's timestamp, in milliseconds.
   * @returns The target, in 100 ns ticks.
   */
  Next(frameMs: number): number {
    let target = this.ticks;
    if (!this.holding && !this.pausing && typeof this.lastFrameMs === 'number' && Number.isFinite(frameMs)) {
      const step = Math.min(Math.max(frameMs - this.lastFrameMs, 0), MAX_FRAME_STEP_MS);
      target += Math.round(step * this.timeRate * TICKS_PER_MS);
    }
    if (Number.isFinite(frameMs)) this.lastFrameMs = frameMs;
    return target;
  }

  /**
   * Forgets the last frame time, so the next Next targets now: after a movie export (sd-export), whose frames never
   * call Next, the first live frame would otherwise count the whole export as one (capped) frame.
   */
  Resync(): void {
    this.lastFrameMs = null;
  }

  /**
   * Moves the clock.
   *
   * @param ticks - The time, in 100 ns ticks (rounded to whole ticks).
   */
  Set(ticks: number): void {
    this.ticks = Math.round(ticks);
  }

  /**
   * Advances to the frame's target (Next, then Set) in one step: the specs' clock.
   *
   * @param frameMs - The animation frame's timestamp, in milliseconds.
   * @returns The new time, in 100 ns ticks.
   */
  Advance(frameMs: number): number {
    this.Set(this.Next(frameMs));
    return this.ticks;
  }

  /**
   * Holds the clock: Advance keeps recording frame times but adds no ticks, so no Destiny boundary is processed and
   * nothing moves. A scripted load holds it while the scene prepares (timeline.ts); the frame after Release advances by
   * its own delta only.
   */
  Hold(): void {
    this.holding = true;
  }

  /**
   * Releases a Hold.
   */
  Release(): void {
    this.holding = false;
  }
}
