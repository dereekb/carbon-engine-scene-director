/**
 * A turret's combat numbers on an evaluated ship: damage per shot by type, volley, cycle, paper DPS, and what its hit
 * chance or application reads (tracking, optimal, falloff, signature resolution; a vorton's explosion; a
 * disintegrator's spool). Skills, hull bonuses and damage mods are already in the max-skills evaluation. The hub's
 * ship_stats and the page's module specs read the same numbers.
 */

import type { Maybe } from '@dereekb/util';
import { weaponKindOf } from '../fitting/categories';
import { DAMAGE_TYPES, type DamageType } from '../fitting/defense';
import type { DogmaShip } from '../fitting/dogma';
import type { DogmaBundle } from '../fitting/dogma-bundle';
import { damageTotal, type DamageVector, NO_DAMAGE } from './damage';

/**
 * The attributes the combat numbers read: damageMultiplier (64) on the module; EM 114, explosive 116, kinetic 117 and
 * thermal 118 on the charge; optimalSigRadius (620); aoeVelocity (653), aoeCloudSize (654) and
 * aoeDamageReductionFactor (1353) on vortons; damageMultiplierBonusPerCycle (2733) and damageMultiplierBonusMax (2734)
 * on disintegrators.
 */
export const TURRET_COMBAT_ATTRIBUTES = {
  damageMultiplier: 64,
  damage: { em: 114, thermal: 118, kinetic: 117, explosive: 116 } as Readonly<Record<DamageType, number>>,
  optimalSigRadius: 620,
  aoeVelocity: 653,
  aoeCloudSize: 654,
  aoeDamageReductionFactor: 1353,
  damageMultiplierBonusPerCycle: 2733,
  damageMultiplierBonusMax: 2734
} as const;

/**
 * How a turret's shots apply: `tracking` (EVE's hit chance and damage roll), `disintegrator` (the same with no
 * falloff, plus spool-up) or `vorton` (missile-style application, no roll).
 */
export type TurretCombatKind = 'tracking' | 'disintegrator' | 'vorton';

export interface TurretCombatNumbers {
  readonly key: string;
  readonly typeID: number;
  readonly name: string;
  readonly kind: TurretCombatKind;
  /**
   * Per shot by type, before quality and spool: damageMultiplier × the charge's damage. Zeros without a charge.
   */
  readonly damage: DamageVector;
  /**
   * Per shot, the types summed.
   */
  readonly volley: number;
  /**
   * Seconds per cycle (the rate of fire).
   */
  readonly cycleTime: number;
  /**
   * Paper DPS: volley / cycleTime.
   */
  readonly dps: number;
  /**
   * Metres.
   */
  readonly optimal: number;
  /**
   * Metres; null for disintegrators and vortons (they have none).
   */
  readonly falloff: Maybe<number>;
  /**
   * trackingSpeed; null for vortons.
   */
  readonly tracking: Maybe<number>;
  /**
   * optimalSigRadius (m); null for vortons.
   */
  readonly signatureResolution: Maybe<number>;
  /**
   * A vorton's explosion radius (m), velocity (m/s) and damage reduction factor.
   */
  readonly explosion?: { readonly radius: number; readonly velocity: number; readonly drf: number };
  /**
   * A disintegrator's damage bonus per consecutive cycle and its cap (fractions: 0.07, 2.125).
   */
  readonly spool?: { readonly perCycle: number; readonly max: number };
  readonly charge?: { readonly typeID: number; readonly name: string };
  readonly note?: string;
}

/**
 * Why a turret does no damage.
 */
export const NO_CHARGE_DAMAGE_NOTE = 'no charge loaded: it does no damage';

/**
 * A fitted turret's combat numbers.
 *
 * @param ship - The evaluated ship.
 * @param bundle - The bundle it was evaluated from.
 * @param key - The module key.
 * @returns The numbers, or null for a key the ship does not fit, a module that is not a turret, or one without a cycle.
 */
export function turretCombatNumbersOf(ship: DogmaShip, bundle: DogmaBundle, key: string): Maybe<TurretCombatNumbers> {
  const module = ship.modules.get(key);
  const effect = module?.type.defaultEffect == null ? null : bundle.effects[module.type.defaultEffect];
  if (!module || !effect || weaponKindOf(module.type.effects) !== 'turret') return null;
  const read = (attribute: Maybe<number>): Maybe<number> => (attribute == null ? null : ship.moduleAttribute(key, attribute));
  const has = (attribute: number): boolean => module.type.attributes[attribute] != null;
  const duration = read(effect.durationAttributeID) ?? 0;
  if (!(duration > 0)) return null;
  const cycleTime = duration / 1000;
  const multiplier = read(TURRET_COMBAT_ATTRIBUTES.damageMultiplier) ?? 1;
  const damage: DamageVector = module.charge ? (Object.fromEntries(DAMAGE_TYPES.map((type) => [type, (ship.chargeAttribute(key, TURRET_COMBAT_ATTRIBUTES.damage[type]) ?? 0) * multiplier])) as Record<DamageType, number>) : NO_DAMAGE;
  const volley = damageTotal(damage);
  const vorton = effect.trackingSpeedAttributeID == null && has(TURRET_COMBAT_ATTRIBUTES.aoeCloudSize);
  const disintegrator = !vorton && has(TURRET_COMBAT_ATTRIBUTES.damageMultiplierBonusPerCycle);
  const kind: TurretCombatKind = vorton ? 'vorton' : disintegrator ? 'disintegrator' : 'tracking';
  return {
    key,
    typeID: module.type.typeID,
    name: module.type.name,
    kind,
    damage,
    volley,
    cycleTime,
    dps: volley / cycleTime,
    optimal: read(effect.rangeAttributeID) ?? 0,
    falloff: read(effect.falloffAttributeID),
    tracking: read(effect.trackingSpeedAttributeID),
    signatureResolution: vorton ? null : read(TURRET_COMBAT_ATTRIBUTES.optimalSigRadius),
    ...(vorton ? { explosion: { radius: read(TURRET_COMBAT_ATTRIBUTES.aoeCloudSize) ?? 0, velocity: read(TURRET_COMBAT_ATTRIBUTES.aoeVelocity) ?? 0, drf: read(TURRET_COMBAT_ATTRIBUTES.aoeDamageReductionFactor) ?? 1 } } : {}),
    ...(disintegrator ? { spool: { perCycle: read(TURRET_COMBAT_ATTRIBUTES.damageMultiplierBonusPerCycle) ?? 0, max: read(TURRET_COMBAT_ATTRIBUTES.damageMultiplierBonusMax) ?? 0 } } : {}),
    ...(module.charge ? { charge: { typeID: module.charge.typeID, name: module.charge.name } } : { note: NO_CHARGE_DAMAGE_NOTE })
  };
}

export interface ShipWeapons {
  /**
   * How many turrets count.
   */
  readonly turrets: number;
  /**
   * Their volleys summed.
   */
  readonly volley: number;
  /**
   * Their paper DPS summed.
   */
  readonly dps: number;
  /**
   * Paper DPS by type.
   */
  readonly damage: DamageVector;
}

/**
 * A ship's turrets summed: volley, paper DPS, and DPS by type.
 *
 * @param ship - The evaluated ship.
 * @param bundle - Its bundle.
 * @param keys - The turrets to count; omitted: every turret that is not offline.
 * @returns The sums.
 */
export function shipWeaponsOf(ship: DogmaShip, bundle: DogmaBundle, keys?: Iterable<string>): ShipWeapons {
  const chosen = keys ? [...keys] : [...ship.modules].filter(([, module]) => module.state !== 'offline').map(([key]) => key);
  const damage: Record<DamageType, number> = { ...NO_DAMAGE };
  let turrets = 0;
  let volley = 0;
  for (const key of chosen) {
    const numbers = turretCombatNumbersOf(ship, bundle, key);
    if (!numbers) continue;
    turrets += 1;
    volley += numbers.volley;
    for (const type of DAMAGE_TYPES) damage[type] += numbers.damage[type] / numbers.cycleTime;
  }
  return { turrets, volley, dps: damageTotal(damage), damage };
}
