/**
 * Default missiles: the Tech I missile a launcher fires when its fit loads none and its cargo holds none that fits it.
 * The damage type follows the hull's race (Caldari Scourge, Minmatar Nova, Amarr Mjolnir, Gallente Inferno), else
 * kinetic. Ids from SDE build 3632936 (the spec resolves every name through the fixture).
 */

import type { Maybe } from '@dereekb/util';
import type { DamageType } from '../fitting/defense';
import type { DogmaTypeRecord } from '../fitting/dogma-bundle';
import { CHARGE_GROUP_ATTRIBUTES } from './charges';
import type { DefaultWeaponType } from './default-weapons';

/**
 * The missile charge groups with a default: light 384, heavy 385, cruise 386, rocket 387, torpedo 89, heavy assault
 * 772, XL torpedo 476 and XL cruise 1019.
 */
export const DEFAULT_MISSILES: Readonly<Record<number, Readonly<Record<DamageType, DefaultWeaponType>>>> = {
  384: {
    kinetic: { name: 'Scourge Light Missile', typeID: 210 },
    thermal: { name: 'Inferno Light Missile', typeID: 211 },
    em: { name: 'Mjolnir Light Missile', typeID: 212 },
    explosive: { name: 'Nova Light Missile', typeID: 213 }
  },
  385: {
    kinetic: { name: 'Scourge Heavy Missile', typeID: 209 },
    thermal: { name: 'Inferno Heavy Missile', typeID: 208 },
    em: { name: 'Mjolnir Heavy Missile', typeID: 207 },
    explosive: { name: 'Nova Heavy Missile', typeID: 206 }
  },
  386: {
    kinetic: { name: 'Scourge Cruise Missile', typeID: 203 },
    thermal: { name: 'Inferno Cruise Missile', typeID: 204 },
    em: { name: 'Mjolnir Cruise Missile', typeID: 202 },
    explosive: { name: 'Nova Cruise Missile', typeID: 205 }
  },
  387: {
    kinetic: { name: 'Scourge Rocket', typeID: 266 },
    thermal: { name: 'Inferno Rocket', typeID: 2514 },
    em: { name: 'Mjolnir Rocket', typeID: 2512 },
    explosive: { name: 'Nova Rocket', typeID: 2516 }
  },
  89: {
    kinetic: { name: 'Scourge Torpedo', typeID: 267 },
    thermal: { name: 'Inferno Torpedo', typeID: 2510 },
    em: { name: 'Mjolnir Torpedo', typeID: 2506 },
    explosive: { name: 'Nova Torpedo', typeID: 2508 }
  },
  772: {
    kinetic: { name: 'Scourge Heavy Assault Missile', typeID: 20307 },
    thermal: { name: 'Inferno Heavy Assault Missile', typeID: 20308 },
    em: { name: 'Mjolnir Heavy Assault Missile', typeID: 20306 },
    explosive: { name: 'Nova Heavy Assault Missile', typeID: 21867 }
  },
  476: {
    kinetic: { name: 'Scourge XL Torpedo', typeID: 17859 },
    thermal: { name: 'Inferno XL Torpedo', typeID: 17861 },
    em: { name: 'Mjolnir XL Torpedo', typeID: 17857 },
    explosive: { name: 'Nova XL Torpedo', typeID: 17863 }
  },
  1019: {
    kinetic: { name: 'Scourge XL Cruise Missile', typeID: 32436 },
    thermal: { name: 'Inferno XL Cruise Missile', typeID: 32440 },
    em: { name: 'Mjolnir XL Cruise Missile', typeID: 32442 },
    explosive: { name: 'Nova XL Cruise Missile', typeID: 32438 }
  }
};

/**
 * The SDE race's missile damage type: 1 Caldari kinetic, 2 Minmatar explosive, 4 Amarr EM, 8 Gallente thermal.
 */
export const RACE_MISSILE_DAMAGE_TYPES: Readonly<Record<number, DamageType>> = { 1: 'kinetic', 2: 'explosive', 4: 'em', 8: 'thermal' };

/**
 * The SOF race's missile damage type, for hulls without an SDE race.
 */
export const SOF_RACE_MISSILE_DAMAGE_TYPES: Readonly<Record<string, DamageType>> = {
  caldari: 'kinetic',
  guristas: 'kinetic',
  minmatar: 'explosive',
  angel: 'explosive',
  amarr: 'em',
  sansha: 'em',
  bloodraider: 'em',
  gallente: 'thermal',
  serpentis: 'thermal'
};

export const DEFAULT_MISSILE_DAMAGE_TYPE: DamageType = 'kinetic';

/**
 * Charge attributes a missile carries: maxVelocity 37, explosionDelay 281, and the damage 114 / 116 / 117 / 118.
 */
const MISSILE_VELOCITY_ATTRIBUTE = 37;
const MISSILE_EXPLOSION_DELAY_ATTRIBUTE = 281;
const MISSILE_DAMAGE_ATTRIBUTES: readonly number[] = [114, 116, 117, 118];

/**
 * A hull's missile damage type: by its SDE race, then its SOF race, else kinetic.
 *
 * @param raceID - The SDE race, when known.
 * @param sofRace - The DNA's SOF race, when known.
 * @returns The damage type.
 */
export function missileDamageTypeOf(raceID: Maybe<number>, sofRace: Maybe<string> = null): DamageType {
  return (raceID == null ? null : RACE_MISSILE_DAMAGE_TYPES[raceID]) ?? (sofRace ? SOF_RACE_MISSILE_DAMAGE_TYPES[sofRace.trim().toLowerCase()] : null) ?? DEFAULT_MISSILE_DAMAGE_TYPE;
}

/**
 * A launcher's default missile: the first of its charge groups (chargeGroup1-5) with a default, at the damage type.
 *
 * @param launcher - The launcher's record.
 * @param damageType - The damage type (missileDamageTypeOf).
 * @returns The missile; null for probe, bomb and interdiction launchers.
 */
export function defaultMissileOf(launcher: Pick<DogmaTypeRecord, 'attributes'>, damageType: DamageType): Maybe<DefaultWeaponType> {
  const group = CHARGE_GROUP_ATTRIBUTES.map((id) => launcher.attributes[id]).find((candidate) => candidate != null && DEFAULT_MISSILES[candidate] != null);
  return group == null ? null : DEFAULT_MISSILES[group][damageType];
}

/**
 * Whether a charge is a missile: it flies (maxVelocity > 0), has a flight time (explosionDelay > 0) and does damage.
 * Probes fail it; bombs pass it (their launchers are refused by group).
 *
 * @param charge - The charge's record.
 * @returns True for a missile.
 */
export function isMissileCharge(charge: Pick<DogmaTypeRecord, 'attributes'>): boolean {
  const positive = (id: number): boolean => (charge.attributes[id] ?? 0) > 0;
  return positive(MISSILE_VELOCITY_ATTRIBUTE) && positive(MISSILE_EXPLOSION_DELAY_ATTRIBUTE) && MISSILE_DAMAGE_ATTRIBUTES.some(positive);
}
