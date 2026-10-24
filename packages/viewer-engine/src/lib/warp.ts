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
 * The whole SetupWarpConstants record's distances too, for where a warp is at a time (WarpRemainingAt).
 */
export interface WarpProfileDistances extends WarpProfile {
  /**
   * The acceleration's exponential rate, 1/s (AU/s).
   */
  readonly accelRate: number;
  readonly accelDistance: number;
  readonly cruiseDistance: number;
  readonly decelDistance: number;
}

/**
 * Ticks Destiny's EntityWarpIn backdates a warp's start (its effect stamp), clamped at tick 0: an arriving ship starts
 * its warp this far into the profile, already in warp.
 */
export const WARP_IN_BACKDATE_TICKS = 5;

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
 * When a warp's speed falls under the exit speed, continuously: acceleration, cruise, then ln(top speed / exit speed)
 * over the deceleration rate.
 *
 * @param profile - The warp's profile.
 * @param maxVelocity - The ship's max velocity, m/s.
 * @returns Seconds after warp start; Infinity for a max velocity of 0.
 */
export function WarpDropOutTime(profile: WarpProfile, maxVelocity: number): number {
  const exitSpeed = Math.min(maxVelocity / 2, WARP_EXIT_SPEED);
  return exitSpeed > 0 ? profile.accelDuration + profile.cruiseDuration + Math.log(profile.warpSpeed / exitSpeed) / profile.decelRate : Infinity;
}

/**
 * When a warp drops out: the first tick sample after warp start whose speed is under the exit speed (WarpDropOutTime
 * floored to the tick, plus one). The exit event comes after the evolve that samples it: at master tick effect stamp +
 * this + 1.
 *
 * @param profile - The warp's profile.
 * @param maxVelocity - The ship's max velocity, m/s.
 * @param dt - Seconds per tick.
 * @returns Seconds after warp start; Infinity for a max velocity of 0.
 */
export function WarpExitTime(profile: WarpProfile, maxVelocity: number, dt = 1): number {
  const slow = WarpDropOutTime(profile, maxVelocity);
  return Number.isFinite(slow) ? (Math.floor(slow / dt) + 1) * dt : Infinity;
}

/**
 * Metres a warp still has to go at a time, by Destiny's WarpDistance: e^(accelRate·t) covered while accelerating, the
 * top speed while cruising, then the exponential deceleration; 0 past it.
 *
 * @param profile - Destiny's whole profile (SetupWarpConstants).
 * @param t - Seconds after warp start.
 * @returns Metres to the landing, at least 0.
 */
export function WarpRemainingAt(profile: WarpProfileDistances, t: number): number {
  const { accelDuration, cruiseDuration, decelRate, warpSpeed, accelRate, accelDistance, cruiseDistance, decelDistance } = profile;
  const total = accelDistance + cruiseDistance + decelDistance;
  const slowing = t - accelDuration - cruiseDuration;
  let covered = total;
  if (t < accelDuration) covered = Math.exp(accelRate * Math.max(0, t));
  else if (t - accelDuration < cruiseDuration) covered = warpSpeed * (t - accelDuration) + accelDistance;
  else if (slowing < Math.log(warpSpeed / decelRate) / decelRate + 1) covered = warpSpeed / decelRate - (warpSpeed / decelRate) * Math.exp(-decelRate * slowing) + accelDistance + cruiseDistance;
  return Math.max(0, total - covered);
}

/**
 * The ticks EntityWarpIn backdates a warp-in starting at a tick boundary.
 *
 * @param boundary - The master tick count at the boundary.
 * @returns min(WARP_IN_BACKDATE_TICKS, boundary).
 */
export function WarpInBackdate(boundary: number): number {
  return Math.max(0, Math.min(WARP_IN_BACKDATE_TICKS, boundary));
}

/**
 * Ticks from the boundary a warp-in starts at to the tick its exit event reports: WarpExitTime + 1 − the backdate.
 *
 * @param profile - The warp's profile.
 * @param maxVelocity - The ship's max velocity, m/s.
 * @param backdate - WarpInBackdate of the start boundary.
 * @returns Whole ticks (at least 1); Infinity for a max velocity of 0.
 */
export function WarpInExitTicks(profile: WarpProfile, maxVelocity: number, backdate: number): number {
  return Math.max(1, WarpExitTime(profile, maxVelocity) + 1 - backdate);
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
