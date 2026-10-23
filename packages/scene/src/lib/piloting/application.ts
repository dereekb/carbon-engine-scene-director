import type { Maybe } from '@dereekb/util';
import { missileApplication, NO_FALLOFF_METRES, QUALITY_OFFSET, turretHitChance, vortonApplication, WRECKING_QUALITY, WRECKING_ROLL } from '../combat/accuracy';
import type { MissileCombatNumbers, MissileExplosion } from '../combat/missile-numbers';
import type { TurretCombatNumbers } from '../combat/weapon-numbers';

/**
 * Applied DPS: what a weapon set does to a target at a geometry, on average. Turrets apply their paper DPS times EVE's
 * expected damage factor at their hit chance; missiles and vortons apply it times their explosion application, inside
 * their reach. The same rules the page's combat rolls (sd-combat), as expectations.
 */

export type PilotWeaponKind = 'tracking' | 'disintegrator' | 'vorton' | 'missile';

/**
 * A weapon as the piloting math reads it: plain numbers, from TurretCombatNumbers or MissileCombatNumbers.
 */
export interface PilotWeapon {
  readonly key?: string;
  readonly kind: PilotWeaponKind;
  /**
   * Paper DPS.
   */
  readonly dps: number;
  /**
   * Turrets and vortons: optimal (m). Missiles: the shorter whole-tick flight range.
   */
  readonly optimal: number;
  /**
   * Tracking turrets: falloff (m). Disintegrators: NO_FALLOFF_METRES. Missiles: the longer flight range − the shorter.
   */
  readonly falloff: number;
  /**
   * Turrets: tracking speed and signature resolution.
   */
  readonly tracking?: Maybe<number>;
  readonly signatureResolution?: Maybe<number>;
  /**
   * Missiles and vortons.
   */
  readonly explosion?: Maybe<MissileExplosion>;
  /**
   * Missiles: the chance a missile flies the longer whole-tick range.
   */
  readonly upperChance?: number;
}

/**
 * A turret's numbers for the piloting math.
 *
 * @param numbers - The turret's combat numbers.
 * @returns The plain weapon.
 */
export function pilotWeaponOfTurret(numbers: TurretCombatNumbers): PilotWeapon {
  return {
    key: numbers.key,
    kind: numbers.kind,
    dps: numbers.dps,
    optimal: numbers.optimal,
    falloff: numbers.kind === 'tracking' ? (numbers.falloff ?? NO_FALLOFF_METRES) : NO_FALLOFF_METRES,
    tracking: numbers.tracking,
    signatureResolution: numbers.signatureResolution,
    explosion: numbers.explosion ?? null
  };
}

/**
 * A launcher's numbers for the piloting math.
 *
 * @param numbers - The launcher's combat numbers.
 * @returns The plain weapon.
 */
export function pilotWeaponOfMissile(numbers: MissileCombatNumbers): PilotWeapon {
  return { key: numbers.key, kind: 'missile', dps: numbers.dps, optimal: numbers.range.lower, falloff: numbers.range.upper - numbers.range.lower, explosion: numbers.explosion, upperChance: numbers.range.upperChance };
}

/**
 * EVE's expected damage factor of a turret shot at hit chance p: 1 % of rolls wreck at 3×, a hit rolled r does r +
 * 0.49, so E(p) = 3p below 1 % and `0.5 × (p² + 0.98p + 0.0501)` above (1.015 at p = 1).
 *
 * @param chance - The hit chance, 0 to 1.
 * @returns The mean damage over the base damage.
 */
export function expectedTurretDamageFactor(chance: number): number {
  const p = Math.max(0, Math.min(1, chance));
  return p < WRECKING_ROLL ? WRECKING_QUALITY * p : WRECKING_QUALITY * WRECKING_ROLL + (p * p - WRECKING_ROLL * WRECKING_ROLL) / 2 + QUALITY_OFFSET * (p - WRECKING_ROLL);
}

/**
 * Where a weapon is shot at.
 */
export interface ApplicationGeometry {
  /**
   * Surface to surface (m).
   */
  readonly distance: number;
  /**
   * rad/s between shooter and target.
   */
  readonly angular: number;
  /**
   * The target's live signature radius (m).
   */
  readonly signature: number;
  /**
   * The target's speed (m/s): what missile and vorton application read.
   */
  readonly speed: number;
}

/**
 * The share of a missile's damage that reaches a target at a distance: all of it within the shorter flight, the longer
 * flight's chance up to it, none beyond.
 *
 * @param weapon - The launcher.
 * @param distance - Surface distance (m).
 * @returns 0 to 1.
 */
export function missileReachChance(weapon: Pick<PilotWeapon, 'optimal' | 'falloff' | 'upperChance'>, distance: number): number {
  let chance = 0;
  if (distance <= weapon.optimal) chance = 1;
  else if (distance <= weapon.optimal + weapon.falloff) chance = weapon.upperChance ?? 0;
  return chance;
}

/**
 * A weapon's mean damage factor at a geometry: E(hit chance) for turrets, reach × explosion application for missiles,
 * explosion application within optimal for vortons.
 *
 * @param weapon - The weapon.
 * @param geometry - Distance, angular velocity, the target's signature and speed.
 * @returns The factor on its paper DPS (0 to ~1.015).
 */
export function weaponApplicationOf(weapon: PilotWeapon, geometry: ApplicationGeometry): number {
  const { distance, angular, signature, speed } = geometry;
  const explosion = weapon.explosion;
  const applied = () => (explosion ? missileApplication({ signatureRadius: signature, targetSpeed: speed, explosionRadius: explosion.radius, explosionVelocity: explosion.velocity, drf: explosion.drf }) : 1);
  let factor: number;
  if (weapon.kind === 'missile') factor = missileReachChance(weapon, distance) * applied();
  else if (weapon.kind === 'vorton') factor = distance > weapon.optimal ? 0 : explosion ? vortonApplication({ signatureRadius: signature, targetSpeed: speed, explosionRadius: explosion.radius, explosionVelocity: explosion.velocity, drf: explosion.drf }) : 1;
  else {
    const chance = turretHitChance({ angularVelocity: angular, tracking: weapon.tracking ?? 0, signatureRadius: signature, signatureResolution: weapon.signatureResolution ?? 0, distance, optimal: weapon.optimal, falloff: weapon.falloff });
    factor = expectedTurretDamageFactor(chance);
  }
  return factor;
}

/**
 * A weapon set's applied DPS at a geometry.
 *
 * @param weapons - The weapons.
 * @param geometry - Distance, angular velocity, the target's signature and speed.
 * @returns DPS.
 */
export function appliedDpsOf(weapons: readonly PilotWeapon[], geometry: ApplicationGeometry): number {
  return weapons.reduce((sum, weapon) => sum + weapon.dps * weaponApplicationOf(weapon, geometry), 0);
}

/**
 * Turret falloffs past optimal still counted as reach: at optimal + 2 × falloff a turret hits 6 % of the time.
 */
export const REACH_FALLOFFS = 2;

/**
 * How far a weapon reaches: turrets optimal + REACH_FALLOFFS × falloff, disintegrators and vortons optimal, missiles
 * their longer flight.
 *
 * @param weapon - The weapon.
 * @returns Metres.
 */
export function weaponReachOf(weapon: PilotWeapon): number {
  let reach: number;
  if (weapon.kind === 'tracking') reach = weapon.optimal + REACH_FALLOFFS * weapon.falloff;
  else if (weapon.kind === 'missile') reach = weapon.optimal + (weapon.upperChance ? weapon.falloff : 0);
  else reach = weapon.optimal;
  return reach;
}

/**
 * The farthest reach of a weapon set that does damage.
 *
 * @param weapons - The weapons.
 * @returns Metres; 0 without weapons.
 */
export function maxWeaponReachOf(weapons: readonly PilotWeapon[]): number {
  return weapons.reduce((reach, weapon) => (weapon.dps > 0 ? Math.max(reach, weaponReachOf(weapon)) : reach), 0);
}
