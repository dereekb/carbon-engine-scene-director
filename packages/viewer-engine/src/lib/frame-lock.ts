/**
 * The frame lock's grid pacer (sd-time): with the lock at F the scene clock moves on a 1/F grid. A drawn frame advances
 * the scene by exactly one grid frame, and only once real time × rate has reached it; never two in one drawn frame, and
 * a slow spell is never paid back (at most one frame is ever owed). So a page drawing faster than F steps the scene at
 * the rate and draws nothing between grid frames, and a page drawing slower steps one grid frame a drawn frame: the
 * scene slows to (draw fps / F) × the rate, every frame still exactly 1/F apart. TimeControl.LockedFrame steps the
 * clock to each grid frame; the grid's clocks come from the export's (ExportFrameTicks: no accumulation, no drift).
 *
 * Node-tested (frame-lock.spec.ts): it imports no runtime.
 */

import { ExportFrameTicks } from './export-frames';

export class FrameLock {
  readonly fps: number;
  private origin = 0;
  private index = -1;
  private due = 0;

  /**
   * @param fps - Grid frames a scene second.
   * @param now - The clock to anchor at (frame 0), 100 ns ticks.
   */
  constructor(fps: number, now: number) {
    this.fps = fps;
    this.Anchor(now);
  }

  /**
   * Starts the grid at a clock: frame 0 sits there and is due at once.
   *
   * @param now - 100 ns ticks.
   */
  Anchor(now: number): void {
    this.origin = now;
    this.index = -1;
    this.due = now;
  }

  /**
   * The last grid frame reached (-1 before frame 0).
   */
  get frame(): number {
    return this.index;
  }

  /**
   * The next grid frame's clock, 100 ns ticks.
   */
  NextClock(): number {
    return this.origin + ExportFrameTicks(this.index + 1, this.fps);
  }

  /**
   * Adds a drawn frame's real time at the rate.
   *
   * @param ticks - The frame's real delta × rate, 100 ns ticks (0 while paused or held).
   */
  Advance(ticks: number): void {
    this.due += ticks;
  }

  /**
   * Whether real time × rate has reached the next grid frame.
   */
  IsDue(): boolean {
    return this.due >= this.NextClock();
  }

  /**
   * The next grid frame was drawn: the index moves on, and what is owed is capped at that one frame.
   */
  Reached(): void {
    this.index += 1;
    this.due = Math.min(this.due, this.NextClock());
  }
}
