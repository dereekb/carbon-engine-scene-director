/**
 * A launcher's combat numbers on an evaluated ship: damage per missile by type, volley, rate of fire, paper DPS, the
 * missile's flight (velocity, flight time, range, mass, agility, radius) and its explosion (radius, velocity, drf).
 * Skills, hull bonuses, Ballistic Control Systems and rigs are already in the evaluation. The hub's ship_stats and
 * the page's module specs read the same numbers.
 *
 * EVE's rules (sd-combat): flight time = explosionDelay + shipRadius / velocity (missiles start at the shooter's
 * centre, Pyfa issue 2083); a missile flies whole 1 s ticks, floor(T) or ceil(T) of them, the longer with chance
 * T − floor(T); paper DPS leaves reloads out.
 */

import type { Maybe } from '@dereekb/util';
import { weaponKindOf } from '../fitting/categories';
import { DAMAGE_TYPES, type DamageType } from '../fitting/defense';
import { CHARACTER_ATTRIBUTES, type DogmaShip } from '../fitting/dogma';
import type { DogmaBundle } from '../fitting/dogma-bundle';
import { isMissileCharge } from '../weapons/default-missiles';
import { damageTotal, type DamageVector, NO_DAMAGE } from './damage';

/**
 * The attributes the missile numbers read: on the charge, damage EM 114, explosive 116, kinetic 117, thermal 118,
 * maxVelocity 37, explosionDelay 281 (ms), aoeCloudSize 654, aoeVelocity 653, aoeDamageReductionFactor 1353, mass 4,
 * agility 70 and radius 162 (the evaluator fills 4 and 162 from the type's columns); on the character,
 * missileDamageMultiplier 212.
 */
export const MISSILE_COMBAT_ATTRIBUTES = {
  damage: { em: 114, thermal: 118, kinetic: 117, explosive: 116 } as Readonly<Record<DamageType, number>>,
  maxVelocity: 37,
  explosionDelay: 281,
  aoeCloudSize: 654,
  aoeVelocity: 653,
  aoeDamageReductionFactor: 1353,
  mass: 4,
  agility: 70,
  radius: 162,
  missileDamageMultiplier: CHARACTER_ATTRIBUTES.missileDamageMultiplier
} as const;

/**
 * Why a launcher fires nothing.
 */
export const NO_MISSILE_NOTE = 'no missile loaded: it fires nothing';

/**
 * Seconds per Destiny tick: a missile flies whole ticks.
 */
export const MISSILE_TICK_SECONDS = 1;

/**
 * A missile's reach (m): the shorter whole-tick flight, the longer one, the longer one's chance, and their mean.
 */
export interface MissileRange {
  readonly lower: number;
  readonly upper: number;
  readonly upperChance: number;
  readonly mean: number;
}

/**
 * A missile's explosion: radius (aoeCloudSize, m), velocity (aoeVelocity, m/s) and damage reduction factor.
 */
export interface MissileExplosion {
  readonly radius: number;
  readonly velocity: number;
  readonly drf: number;
}

export interface MissileCombatNumbers {
  readonly key: string;
  readonly typeID: number;
  readonly name: string;
  readonly kind: 'missile';
  /**
   * Per missile by type: the charge's damage × the character's missileDamageMultiplier. Zeros without a missile.
   */
  readonly damage: DamageVector;
  /**
   * Per missile, the types summed.
   */
  readonly volley: number;
  /**
   * Seconds per cycle (the rate of fire).
   */
  readonly cycleTime: number;
  /**
   * Paper DPS: volley / cycleTime, reloads left out.
   */
  readonly dps: number;
  /**
   * The missile's max velocity (m/s).
   */
  readonly velocity: number;
  /**
   * Seconds: explosionDelay plus the ship-radius bonus.
   */
  readonly flightTime: number;
  /**
   * The missile ball's mass (kg), agility and radius (m).
   */
  readonly mass: number;
  readonly agility: number;
  readonly radius: number;
  readonly range: MissileRange;
  readonly explosion: MissileExplosion;
  readonly charge?: { readonly typeID: number; readonly name: string };
  readonly note?: string;
}

export interface MissileFlightTimeInput {
  /**
   * explosionDelay (281), evaluated, in milliseconds.
   */
  readonly explosionDelay: number;
  /**
   * The missile's max velocity (m/s).
   */
  readonly velocity: number;
  /**
   * The launching ship's radius (m).
   */
  readonly shipRadius: number;
}

/**
 * A missile's flight time: explosionDelay plus the time to cross the launching ship's radius.
 *
 * @param input - The explosion delay (ms), velocity and ship radius.
 * @returns Seconds; 0 for a missile that does not fly.
 */
export function missileFlightTime(input: MissileFlightTimeInput): number {
  const { explosionDelay, velocity, shipRadius } = input;
  return velocity > 0 ? explosionDelay / 1000 + shipRadius / velocity : 0;
}

export interface MissileRangeInput {
  readonly velocity: number;
  /**
   * Seconds (missileFlightTime).
   */
  readonly flightTime: number;
  readonly mass: number;
  readonly agility: number;
  readonly shipRadius: number;
}

/**
 * A missile's range on EVE's whole-tick rule: it flies floor(T) or ceil(T) ticks, the longer with chance T − floor(T).
 * Each case is `v / 2 × a + v × (t − a) − shipRadius`, a = min(t, mass × agility / 1e6) its acceleration time.
 *
 * @param input - The velocity, flight time, missile mass and agility, and the ship radius.
 * @returns The two cases, the longer's chance and the mean (m).
 */
export function missileRange(input: MissileRangeInput): MissileRange {
  const { velocity, flightTime, mass, agility, shipRadius } = input;
  const reach = (seconds: number): number => {
    const accelerating = Math.min(seconds, (mass * agility) / 1e6);
    return Math.max(0, (velocity / 2) * accelerating + velocity * (seconds - accelerating) - shipRadius);
  };
  const ticks = flightTime / MISSILE_TICK_SECONDS;
  const lowerTicks = Math.floor(ticks);
  const upperChance = ticks - lowerTicks;
  const lower = reach(lowerTicks * MISSILE_TICK_SECONDS);
  const upper = upperChance > 0 ? reach(Math.ceil(ticks) * MISSILE_TICK_SECONDS) : lower;
  return { lower, upper, upperChance, mean: lower * (1 - upperChance) + upper * upperChance };
}

/**
 * A fitted launcher's combat numbers.
 *
 * @param ship - The evaluated ship.
 * @param bundle - The bundle it was evaluated from.
 * @param key - The module key.
 * @returns The numbers, or null for a key the ship does not fit, a module that is no launcher, or one without a
 * cycle. A launcher without a missile gets zeros and NO_MISSILE_NOTE.
 */
export function missileCombatNumbersOf(ship: DogmaShip, bundle: DogmaBundle, key: string): Maybe<MissileCombatNumbers> {
  const module = ship.modules.get(key);
  const effect = module?.type.defaultEffect == null ? null : bundle.effects[module.type.defaultEffect];
  if (!module || !effect || weaponKindOf(module.type.effects) !== 'launcher') return null;
  const duration = effect.durationAttributeID == null ? 0 : (ship.moduleAttribute(key, effect.durationAttributeID) ?? 0);
  if (!(duration > 0)) return null;
  const cycleTime = duration / 1000;
  const charge = module.charge && isMissileCharge(module.charge) ? module.charge : null;
  const read = (attribute: number): number => (charge ? (ship.chargeAttribute(key, attribute) ?? 0) : 0);
  const multiplier = ship.characterAttribute(MISSILE_COMBAT_ATTRIBUTES.missileDamageMultiplier) ?? 1;
  const damage: DamageVector = charge ? (Object.fromEntries(DAMAGE_TYPES.map((type) => [type, read(MISSILE_COMBAT_ATTRIBUTES.damage[type]) * multiplier])) as Record<DamageType, number>) : NO_DAMAGE;
  const volley = damageTotal(damage);
  const velocity = read(MISSILE_COMBAT_ATTRIBUTES.maxVelocity);
  const shipRadius = ship.attribute(MISSILE_COMBAT_ATTRIBUTES.radius);
  const flightTime = missileFlightTime({ explosionDelay: read(MISSILE_COMBAT_ATTRIBUTES.explosionDelay), velocity, shipRadius });
  const mass = read(MISSILE_COMBAT_ATTRIBUTES.mass);
  const agility = read(MISSILE_COMBAT_ATTRIBUTES.agility);
  return {
    key,
    typeID: module.type.typeID,
    name: module.type.name,
    kind: 'missile',
    damage,
    volley,
    cycleTime,
    dps: volley / cycleTime,
    velocity,
    flightTime,
    mass,
    agility,
    radius: read(MISSILE_COMBAT_ATTRIBUTES.radius),
    range: missileRange({ velocity, flightTime, mass, agility, shipRadius }),
    explosion: { radius: read(MISSILE_COMBAT_ATTRIBUTES.aoeCloudSize), velocity: read(MISSILE_COMBAT_ATTRIBUTES.aoeVelocity), drf: charge ? (ship.chargeAttribute(key, MISSILE_COMBAT_ATTRIBUTES.aoeDamageReductionFactor) ?? 1) : 1 },
    ...(charge ? { charge: { typeID: charge.typeID, name: charge.name } } : { note: NO_MISSILE_NOTE })
  };
}
