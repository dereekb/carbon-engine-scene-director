/**
 * The booster drive. EveShip2 derives its `speed` from the translation curve (the ClientBall) every frame itself, and
 * a booster set's intensity is a low-pass of 0.8 × speed / boosters.maxVel (plus acceleration), capped at 2
 * (EveBoosterSet2Renderable.CalculateIntensity). The runtime defaults `maxVel` to 250 m/s for every hull and drives no
 * `warpIntensity`, so the page sets both per ship every frame: `maxVel` (and EveShip2.maxSpeed, the audio speed
 * scale) is the ship's max velocity, so full speed reads the same on every hull and an MWD or a warp pushes toward the
 * cap, and `warpIntensity` (the glows' warp colours) ramps in only at warp speeds.
 *
 * Node-tested: it imports nothing from ./runtime but types.
 */

import type { EveShip2 } from './runtime';

/**
 * The part of a live ship the drive feeds.
 */
export type BoosterHost = Pick<EveShip2, 'maxSpeed' | 'boosters'>;

/**
 * Multiples of max velocity: warpIntensity is 0 at or below WARP_GLOW_FROM and 1 at or above WARP_GLOW_FULL (a
 * smoothstep between), so no sub-light speed (an MWD is about 6×) shows the warp colours.
 */
export const WARP_GLOW_FROM = 10;
export const WARP_GLOW_FULL = 100;

/**
 * What one frame of the drive takes.
 */
export interface BoosterDrive {
  /**
   * The drawn ball speed, m/s.
   */
  readonly speed: number;
  /**
   * The ship's max velocity, m/s, without a prop mod.
   */
  readonly maxVelocity: number;
}

/**
 * How far into the warp colours a speed is.
 *
 * @param speed - The speed, m/s.
 * @param maxVelocity - The ship's max velocity, m/s; floored at 1 m/s.
 * @returns The blend, 0 to 1.
 */
export function WarpGlow(speed: number, maxVelocity: number): number {
  const ratio = speed / Math.max(1, maxVelocity);
  const x = Math.min(1, Math.max(0, (ratio - WARP_GLOW_FROM) / (WARP_GLOW_FULL - WARP_GLOW_FROM)));
  return Number.isFinite(x) ? x * x * (3 - 2 * x) : 0;
}

/**
 * Feeds a ship's booster set for one frame.
 *
 * @param ship - The live ship.
 * @param drive - Its drawn speed and max velocity.
 */
export function DriveBoosters(ship: BoosterHost, drive: BoosterDrive): void {
  const maxVelocity = Math.max(1, drive.maxVelocity);
  ship.maxSpeed = maxVelocity;
  if (ship.boosters) {
    ship.boosters.maxVel = maxVelocity;
    ship.boosters.warpIntensity = WarpGlow(drive.speed, maxVelocity);
  }
}
