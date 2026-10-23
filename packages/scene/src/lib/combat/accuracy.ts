/**
 * EVE's turret hit chance and damage roll, and the missile-style application vorton projectors use. Runtime-free: the
 * page feeds it Destiny's live geometry (GetAccuracy computes the same chance on the balls).
 */

/**
 * The falloff an entropic disintegrator passes Destiny (it has none): attribute 158's SDE default, so its chance is
 * ~0 past optimal. Never 0: GetAccuracy answers 0 for a zero falloff even within optimal.
 */
export const NO_FALLOFF_METRES = 1;

/**
 * A roll under this is a wrecking shot.
 */
export const WRECKING_ROLL = 0.01;

/**
 * A wrecking shot's damage quality: three times the base damage.
 */
export const WRECKING_QUALITY = 3;

/**
 * A hit's quality is its roll plus this (0.50 to 1.49).
 */
export const QUALITY_OFFSET = 0.49;

export interface TurretHitChanceInput {
  /**
   * rad/s: the transversal speed over the centre distance.
   */
  readonly angularVelocity: number;
  /**
   * The turret's evaluated trackingSpeed (160).
   */
  readonly tracking: number;
  /**
   * The target's live signature radius (m).
   */
  readonly signatureRadius: number;
  /**
   * The turret's optimalSigRadius (620): 40,000 on every turret.
   */
  readonly signatureResolution: number;
  /**
   * Metres, surface to surface.
   */
  readonly distance: number;
  readonly optimal: number;
  readonly falloff: number;
}

/**
 * EVE's turret hit chance: `0.5 ^ ((ω × sigRes / (tracking × S))² + (max(0, d − optimal) / falloff)²)`, with Destiny's
 * guards (0 for a zero or negative falloff, tracking or signature, or a negative optimal).
 *
 * @param input - The geometry and the turret's numbers.
 * @returns The chance to hit, 0 to 1.
 */
export function turretHitChance(input: TurretHitChanceInput): number {
  const { angularVelocity, tracking, signatureRadius, signatureResolution, distance, optimal, falloff } = input;
  let chance = 0;
  if (falloff > 0 && tracking > 0 && signatureRadius > 0 && optimal >= 0) {
    const trackingTerm = (angularVelocity * signatureResolution) / (tracking * signatureRadius);
    const rangeTerm = Math.max(0, distance - optimal) / falloff;
    chance = 0.5 ** (trackingTerm * trackingTerm + rangeTerm * rangeTerm);
  }
  return chance;
}

/**
 * The client's combat-log tiers by damage quality, lowest first.
 */
export const HIT_RESULTS = ['grazes', 'glances off', 'hits', 'penetrates', 'smashes', 'wrecks'] as const;

export type HitResult = (typeof HIT_RESULTS)[number];

/**
 * What a shot did: a miss, a hit tier, or `overkill` (its target was already dead: no roll, no damage).
 */
export type ShotResult = 'misses' | HitResult | 'overkill';

/**
 * The tier of a hit's damage quality: grazes below 0.625, glances off below 0.75, hits below 1, penetrates below 1.25,
 * smashes up to 1.49, wrecks at 3.
 *
 * @param quality - The damage quality.
 * @returns The tier.
 */
export function hitResultOf(quality: number): HitResult {
  let result: HitResult;
  if (quality >= WRECKING_QUALITY) result = 'wrecks';
  else if (quality >= 1.25) result = 'smashes';
  else if (quality >= 1) result = 'penetrates';
  else if (quality >= 0.75) result = 'hits';
  else if (quality >= 0.625) result = 'glances off';
  else result = 'grazes';
  return result;
}

export interface ShotRoll {
  readonly hit: boolean;
  /**
   * The damage factor: 0 for a miss, the roll + 0.49 for a hit, 3 for a wrecking shot.
   */
  readonly quality: number;
  readonly wrecking: boolean;
  readonly result: ShotResult;
}

/**
 * EVE's damage roll: one uniform r in [0, 1) per shot hits when r < chance; r < 0.01 wrecks at 3 × base damage, any
 * other hit does (r + 0.49) × base.
 *
 * @param roll - The shot's uniform roll in [0, 1).
 * @param chance - Its hit chance.
 * @returns Hit or miss, the quality and the tier.
 */
export function rollShot(roll: number, chance: number): ShotRoll {
  let result: ShotRoll;
  if (!(roll < chance)) result = { hit: false, quality: 0, wrecking: false, result: 'misses' };
  else if (roll < WRECKING_ROLL) result = { hit: true, quality: WRECKING_QUALITY, wrecking: true, result: 'wrecks' };
  else {
    const quality = roll + QUALITY_OFFSET;
    result = { hit: true, quality, wrecking: false, result: hitResultOf(quality) };
  }
  return result;
}

export interface MissileApplicationInput {
  /**
   * The target's live signature radius (m).
   */
  readonly signatureRadius: number;
  /**
   * The target's speed (m/s): absolute, not angular.
   */
  readonly targetSpeed: number;
  /**
   * aoeCloudSize (654), evaluated: the explosion radius.
   */
  readonly explosionRadius: number;
  /**
   * aoeVelocity (653), evaluated: the explosion velocity.
   */
  readonly explosionVelocity: number;
  /**
   * aoeDamageReductionFactor (1353): the SDE's combined exponent, ln(old DRF) / ln(5.5).
   */
  readonly drf: number;
}

/**
 * EVE's missile application: `min(1, S / E, (S / E × Ve / Vt) ^ drf)`. No roll, no wrecking: a missile that reaches
 * its target always does this share of its damage. Guards: a signature of 0 or less takes nothing; no explosion
 * radius applies fully; a target at rest or an explosion velocity of 0 leaves the radius term only.
 *
 * @param input - The target's signature and speed and the missile's explosion numbers.
 * @returns The damage factor, 0 to 1.
 */
export function missileApplication(input: MissileApplicationInput): number {
  const { signatureRadius, targetSpeed, explosionRadius, explosionVelocity, drf } = input;
  let factor = 1;
  if (signatureRadius <= 0) factor = 0;
  else if (explosionRadius > 0) {
    const ratio = signatureRadius / explosionRadius;
    factor = Math.min(1, ratio);
    if (targetSpeed > 0 && explosionVelocity > 0) factor = Math.min(factor, ((ratio * explosionVelocity) / targetSpeed) ** drf);
  }
  return factor;
}

export type VortonApplicationInput = MissileApplicationInput;

/**
 * A vorton projector applies like a missile (missileApplication).
 */
export const vortonApplication: (input: VortonApplicationInput) => number = missileApplication;
