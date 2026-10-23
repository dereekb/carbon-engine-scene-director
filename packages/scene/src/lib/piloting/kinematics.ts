import { ALIGN_VELOCITY_FRACTION, DESTINY_FRICTION } from '../stats/ship-stats';

/**
 * Destiny's straight-line motion: velocity relaxes toward the ordered velocity as
 * `v(t) = target + (v0 − target) × e^(−t / τ)`, τ = mass × agility / 1e6 (CjsBallparkController Integrate), on 1 s
 * ticks. Speeds here are along one line: positive toward the thrust, negative against it.
 */

/**
 * Seconds per Destiny tick.
 */
export const DESTINY_TICK_SECONDS = 1;

/**
 * The time constant τ: the seconds Destiny's velocity takes to close 1 − 1/e of the gap to its target velocity.
 *
 * @param mass - Mass (kg).
 * @param agility - The inertia modifier.
 * @returns Seconds.
 */
export function agilityTimeConstant(mass: number, agility: number): number {
  return (mass * agility) / DESTINY_FRICTION;
}

/**
 * The align time: from rest to ALIGN_VELOCITY_FRACTION of max velocity, `τ × ln(1 / (1 − 0.75))` (before EVE rounds
 * it up to whole ticks).
 *
 * @param tau - The time constant τ (s).
 * @returns Seconds.
 */
export function alignTimeOf(tau: number): number {
  return tau * Math.log(1 / (1 - ALIGN_VELOCITY_FRACTION));
}

export interface StraightMotionInput {
  readonly tau: number;
  /**
   * m/s now.
   */
  readonly from: number;
  /**
   * The ordered velocity the ship relaxes toward (m/s).
   */
  readonly to: number;
  readonly seconds: number;
}

/**
 * The speed after a time.
 *
 * @param input - The time constant τ, the speed now, the target speed and the time.
 * @returns Speed (m/s).
 */
export function speedAfter(input: StraightMotionInput): number {
  const { tau, from, to, seconds } = input;
  return tau > 0 ? to + (from - to) * Math.exp(-seconds / tau) : to;
}

/**
 * The distance flown over a time: `to × t + (from − to) × τ × (1 − e^(−t / τ))`.
 *
 * @param input - The time constant τ, the speed now, the target speed and the time.
 * @returns Metres along the line.
 */
export function distanceAfter(input: StraightMotionInput): number {
  const { tau, from, to, seconds } = input;
  return to * seconds + (tau > 0 ? (from - to) * tau * (1 - Math.exp(-seconds / tau)) : 0);
}

export interface TimeToSpeedInput {
  readonly tau: number;
  readonly from: number;
  /**
   * The ordered velocity.
   */
  readonly to: number;
  /**
   * The speed to reach, between `from` and `to`.
   */
  readonly speed: number;
}

/**
 * The time to reach a speed: `τ × ln((to − from) / (to − speed))`.
 *
 * @param input - The time constant τ, the speed now, the ordered speed and the speed to reach.
 * @returns Seconds; 0 when already there, Infinity when the ordered speed never gets there.
 */
export function timeToSpeed(input: TimeToSpeedInput): number {
  const { tau, from, to, speed } = input;
  const ratio = (to - from) / (to - speed);
  let seconds = Number.POSITIVE_INFINITY;
  if (speed === from) seconds = 0;
  else if (ratio > 1) seconds = tau * Math.log(ratio);
  return seconds;
}

/**
 * The time a ship at full speed takes to stop closing when it burns the other way at full speed: `τ × ln 2`.
 *
 * @param tau - The time constant τ (s).
 * @returns Seconds until its velocity passes through zero.
 */
export function reversalTimeOf(tau: number): number {
  return tau * Math.LN2;
}

/**
 * How fast a straight chase closes.
 *
 * @param chaserSpeed - The chaser's speed (m/s).
 * @param runnerSpeed - The runner's speed (m/s), straight away from the chaser.
 * @returns The speed the gap closes at (m/s; negative: it opens).
 */
export function closingRateOf(chaserSpeed: number, runnerSpeed: number): number {
  return chaserSpeed - runnerSpeed;
}

/**
 * How long a straight chase takes to close a gap at full speeds.
 *
 * @param gap - Metres.
 * @param chaserSpeed - The chaser's speed (m/s).
 * @param runnerSpeed - The runner's speed (m/s).
 * @returns Seconds; Infinity when the runner is as fast or faster.
 */
export function timeToCloseOf(gap: number, chaserSpeed: number, runnerSpeed: number): number {
  const rate = closingRateOf(chaserSpeed, runnerSpeed);
  return gap <= 0 ? 0 : rate > 0 ? gap / rate : Number.POSITIVE_INFINITY;
}
