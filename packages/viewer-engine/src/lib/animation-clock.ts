/**
 * The animation clock (sd-time, sd-runtime): Blue's frame clock, so the runtime's own animations run on the scene clock.
 * The engine installs it as blue.os.frameClock; PumpOS (once per engine frame) takes the frame's time from Sample(), and
 * every reader of Blue's frame time follows: the controllers' state machines and actions, dynamic bindings, lights,
 * booster behaviors, and the device's animation time (TriDevice.OnTick adds the frame time's delta), which the shaders
 * read as Time: beam textures and flares, hull glows, turret barrels, booster flicker, blinking lights, planet clouds.
 *
 * Each frame it advances by the scene clock's advance since the frame before, at most MAX_ANIMATION_STEP_TICKS: not at
 * all while time control pauses or a timeline holds the clock, the rate's share in slow motion and fast-forward, never
 * backwards, and never across a time-control jump (Rebase takes the landing). It starts at Blue's actual time, so
 * Blue's frame time never runs backwards at the install.
 *
 * Node-tested (animation-clock.spec.ts): it imports no runtime.
 */

import type { Maybe } from '@dereekb/util';
import { TICKS_PER_SECOND } from './clock';
import type { BlueFrameClock } from './runtime';

/**
 * The most one frame advances it, 100 ns ticks: Carbon's TriDevice clamps its animation step to a second too.
 */
export const MAX_ANIMATION_STEP_TICKS = TICKS_PER_SECOND;

export interface AnimationClockReport {
  /** Seconds it advanced since the install. */
  readonly seconds: number;
  /** True when the last frame did not advance it: paused, held, or the first frame. */
  readonly frozen: boolean;
}

export class AnimationClock implements BlueFrameClock {
  private readonly start: number;
  private current: number;
  private lastScene: Maybe<number> = null;
  private lastStep = 0;
  private readonly sample: [number] = [0];

  /** @param start - Blue ticks to start at: blue.os.GetActualTime() at the install. */
  constructor(start: number) {
    this.start = Math.round(start);
    this.current = this.start;
  }

  /** Blue ticks now. */
  get ticks(): number {
    return this.current;
  }

  /**
   * The engine frame at scene clock `now`: advances by the scene clock's advance since the last frame.
   *
   * @param now - The scene clock, 100 ns ticks.
   * @returns Blue ticks after the frame.
   */
  Frame(now: number): number {
    const step = this.lastScene == null ? 0 : Math.min(Math.max(Math.round(now - this.lastScene), 0), MAX_ANIMATION_STEP_TICKS);
    this.lastScene = now;
    this.lastStep = step;
    this.current += step;
    return this.current;
  }

  /**
   * A time-control jump moved the scene clock: the next frame advances from `now`, never across the jump.
   */
  Rebase(now: number): void {
    this.lastScene = now;
  }

  /**
   * IBlueOS frameClock (a runtime-called name): PumpOS reads the frame's time from the first entry.
   */
  Sample(): ArrayLike<number> {
    this.sample[0] = this.current;
    return this.sample;
  }

  Report(): AnimationClockReport {
    return { seconds: Math.round(((this.current - this.start) / TICKS_PER_SECOND) * 100) / 100, frozen: this.lastStep === 0 };
  }
}
