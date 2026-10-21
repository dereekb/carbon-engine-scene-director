/**
 * The scene clock: one integer 100 ns tick count that both the Destiny parks (destiny.ts) and the renderer sample
 * with. The page's animation loop advances it by the real frame time, then evolves the parks to it, then draws at it.
 */

import type { Maybe } from '@dereekb/util';

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
 * The most one frame may advance the clock. A hidden tab or a debugger pause stalls frames; capping the step pauses
 * the scene instead of fast-forwarding it, and keeps the master park's backlog drop (6+ ticks) from ever firing.
 */
export const MAX_FRAME_STEP_MS = 1000;

export class SceneClock {
  private ticks = CLOCK_EPOCH_TICKS;
  private lastFrameMs: Maybe<number> = null;

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
   * Advances by the time since the previous frame, capped at MAX_FRAME_STEP_MS. The first call only records the
   * frame time.
   *
   * @param frameMs - The animation frame's timestamp, in milliseconds.
   * @returns The new time, in 100 ns ticks.
   */
  Advance(frameMs: number): number {
    if (typeof this.lastFrameMs === 'number' && Number.isFinite(frameMs)) {
      const step = Math.min(Math.max(frameMs - this.lastFrameMs, 0), MAX_FRAME_STEP_MS);
      this.ticks += Math.round(step * TICKS_PER_MS);
    }
    if (Number.isFinite(frameMs)) this.lastFrameMs = frameMs;
    return this.ticks;
  }
}
