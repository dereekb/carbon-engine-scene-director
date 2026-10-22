/**
 * Warp math for the page's Destiny warps (DestinyWorld runs the park calls): the warp factor Destiny takes, where a
 * warp lands, and the phases of Destiny's three-phase warp profile (SetupWarpConstants: accelerate, cruise,
 * decelerate). Destiny drops a ball out of warp on the first tick sample whose speed is under min(maxVelocity / 2,
 * WARP_EXIT_SPEED).
 *
 * Node-tested: it imports nothing from ./runtime.
 */

import type { SceneVector } from '@scene-director/scene';

/**
 * AU/s: the cruiser class, for a ship whose physics name none.
 */
export const DEFAULT_WARP_SPEED = 4;

/**
 * m/s: Destiny drops a ball out of warp once its speed is below min(maxVelocity / 2, this).
 */
export const WARP_EXIT_SPEED = 100;

/**
 * The subset of Destiny's SetupWarpConstants record the page reads.
 */
export interface WarpProfile {
  /**
   * Seconds accelerating.
   */
  readonly accelDuration: number;
  /**
   * Seconds at warp speed; about 0 (or a little below) for a short warp.
   */
  readonly cruiseDuration: number;
  /**
   * The deceleration's exponential rate, 1/s.
   */
  readonly decelRate: number;
  /**
   * m/s: the top speed, capped for a short warp.
   */
  readonly warpSpeed: number;
}

/**
 * In-warp phases: accelerating and cruising, then slowing out of warp.
 */
export type InWarpPhase = 'warping' | 'exiting';

const INT32_MAX = 2 ** 31 - 1;

/**
 * Destiny's warp factor: 1000 × AU/s, a positive int32 (WarpTo throws a RangeError for anything else).
 *
 * @param warpSpeed - AU/s.
 * @returns The factor, at least 1.
 * @throws {RangeError} For a non-finite warp speed, or one too large for an int32 factor.
 */
export function WarpFactor(warpSpeed: number): number {
  const factor = Math.max(1, Math.round(warpSpeed * 1000));
  if (!Number.isFinite(warpSpeed) || factor > INT32_MAX) throw new RangeError(`warp speed must be a finite number of AU/s up to ${INT32_MAX / 1000}: ${warpSpeed}`);
  return factor;
}

/**
 * Where a warp lands: `range` metres from the destination, back toward `from` (RealWarp's offset).
 *
 * @param destination - The warp's destination.
 * @param range - Metres back from it.
 * @param from - Where warp begins.
 * @returns The landing point; the destination itself when `from` is on it.
 */
export function LandingPoint(destination: ArrayLike<number>, range: number, from: ArrayLike<number>): SceneVector {
  const back = [from[0] - destination[0], from[1] - destination[1], from[2] - destination[2]];
  const length = Math.hypot(back[0], back[1], back[2]);
  const scale = length > 0 ? range / length : 0;
  return [destination[0] + back[0] * scale, destination[1] + back[1] * scale, destination[2] + back[2] * scale];
}

/**
 * Metres a warp from `from` covers.
 *
 * @param destination - The warp's destination.
 * @param range - Metres short of it.
 * @param from - Where warp begins.
 * @returns The distance, |destination − from| − range; negative when the range overshoots.
 */
export function WarpLength(destination: ArrayLike<number>, range: number, from: ArrayLike<number>): number {
  return Math.hypot(destination[0] - from[0], destination[1] - from[1], destination[2] - from[2]) - range;
}

/**
 * When a warp drops out: the first tick sample after warp start whose speed is under the exit speed.
 *
 * @param profile - The warp's profile.
 * @param maxVelocity - The ship's max velocity, m/s.
 * @param dt - Seconds per tick.
 * @returns Seconds after warp start; Infinity for a max velocity of 0.
 */
export function WarpExitTime(profile: WarpProfile, maxVelocity: number, dt = 1): number {
  const exitSpeed = Math.min(maxVelocity / 2, WARP_EXIT_SPEED);
  let time = Infinity;
  if (exitSpeed > 0) {
    const slow = profile.accelDuration + profile.cruiseDuration + Math.log(profile.warpSpeed / exitSpeed) / profile.decelRate;
    time = (Math.floor(slow / dt) + 1) * dt;
  }
  return time;
}

/**
 * The in-warp phase at a time.
 *
 * @param profile - The warp's profile.
 * @param t - Seconds after warp start.
 * @returns Warping while accelerating and cruising, then exiting.
 */
export function WarpPhaseAt(profile: WarpProfile, t: number): InWarpPhase {
  return t < profile.accelDuration + profile.cruiseDuration ? 'warping' : 'exiting';
}
