/**
 * Stand-in combat: the guns, HP, resists and targeting a stand-in cube fights with when the page has no EVE data
 * (`--eve-data off`). Class values, not dogma, in the spirit of the flight's class hulls: one gun type per class, fitted
 * `guns` times as `high-0 … high-<n−1>`, through the same shapes the dogma path gives the combat pipeline (turret
 * numbers, module activations, a defense and targeting), so locks, hits, the damage model and kills run unchanged.
 *
 * - The class is the document's `ships[].standIn.class`, else the flight's class (a cruiser without EVE data).
 * - Anchors: frigate on the dogma fixture's max-skills Rifter and Punisher default fits, battlecruiser on the Ferox,
 *   battleship on the Megathron; the rest interpolated, capital and titan rough.
 * - Damage is half thermal, half kinetic; every class takes EVE's base T1 hull resonances; every gun's signature
 *   resolution is 40,000 (as optimalSigRadius 620 is on every EVE turret), so Destiny's GetAccuracy reads it unchanged.
 * - No capacitor, no missiles and no other modules.
 */

import type { Maybe } from '@dereekb/util';
import { DAMAGE_TYPES, type DamageType, defenseLayerOf, type DefenseLayerName, type ShipDefense, shipDefenseFrom, type ShipTargeting } from '../fitting/defense';
import type { ModuleActivation } from '../fitting/activation';
import { isPlainObject, reportUnknownKeys } from '../json';
import { SHIP_CLASSES, type ShipClass } from '../stats/ship-classes';
import { damageTotal, type DamageVector } from './damage';
import type { TurretCombatNumbers } from './weapon-numbers';

/**
 * One class's stand-in numbers.
 */
export interface StandInClassCombat {
  /**
   * How many guns it fits.
   */
  readonly guns: number;
  /**
   * Damage per shot, the types summed.
   */
  readonly volley: number;
  /**
   * Seconds per cycle.
   */
  readonly cycleTime: number;
  /**
   * Metres.
   */
  readonly optimal: number;
  readonly falloff: number;
  readonly tracking: number;
  readonly hp: Readonly<Record<DefenseLayerName, number>>;
  /**
   * Seconds for the shield to recharge from empty.
   */
  readonly shieldRecharge: number;
  readonly targeting: ShipTargeting;
}

/**
 * Stand-in numbers by class.
 */
export const STAND_IN_CLASS_COMBAT: Readonly<Record<ShipClass, StandInClassCombat>> = {
  frigate: { guns: 3, volley: 60, cycleTime: 2, optimal: 1500, falloff: 5000, tracking: 300, hp: { shield: 500, armor: 500, structure: 450 }, shieldRecharge: 470, targeting: { maxTargetRange: 30_000, scanResolution: 800, maxLockedTargets: 4 } },
  destroyer: { guns: 6, volley: 45, cycleTime: 2.5, optimal: 2000, falloff: 6000, tracking: 250, hp: { shield: 900, armor: 900, structure: 900 }, shieldRecharge: 600, targeting: { maxTargetRange: 40_000, scanResolution: 600, maxLockedTargets: 5 } },
  cruiser: { guns: 4, volley: 110, cycleTime: 3, optimal: 4000, falloff: 8000, tracking: 60, hp: { shield: 2000, armor: 2000, structure: 2000 }, shieldRecharge: 1000, targeting: { maxTargetRange: 60_000, scanResolution: 350, maxLockedTargets: 6 } },
  battlecruiser: { guns: 6, volley: 180, cycleTime: 4, optimal: 6000, falloff: 10_000, tracking: 25, hp: { shield: 5000, armor: 4500, structure: 5000 }, shieldRecharge: 1250, targeting: { maxTargetRange: 75_000, scanResolution: 250, maxLockedTargets: 7 } },
  battleship: { guns: 7, volley: 330, cycleTime: 4.5, optimal: 8000, falloff: 12_000, tracking: 10, hp: { shield: 8500, armor: 9000, structure: 10_000 }, shieldRecharge: 2000, targeting: { maxTargetRange: 100_000, scanResolution: 150, maxLockedTargets: 7 } },
  capital: { guns: 3, volley: 3000, cycleTime: 10, optimal: 30_000, falloff: 20_000, tracking: 1.5, hp: { shield: 100_000, armor: 100_000, structure: 100_000 }, shieldRecharge: 10_000, targeting: { maxTargetRange: 150_000, scanResolution: 80, maxLockedTargets: 5 } },
  titan: { guns: 4, volley: 15_000, cycleTime: 15, optimal: 50_000, falloff: 30_000, tracking: 0.5, hp: { shield: 2_000_000, armor: 2_000_000, structure: 2_000_000 }, shieldRecharge: 20_000, targeting: { maxTargetRange: 250_000, scanResolution: 50, maxLockedTargets: 3 } }
};

/**
 * EVE's base T1 hull resonances, on every class.
 */
export const STAND_IN_RESONANCES: Readonly<Record<DefenseLayerName, Readonly<Record<DamageType, number>>>> = {
  shield: { em: 1, thermal: 0.8, kinetic: 0.6, explosive: 0.5 },
  armor: { em: 0.5, thermal: 0.65, kinetic: 0.75, explosive: 0.9 },
  structure: { em: 0.67, thermal: 0.67, kinetic: 0.67, explosive: 0.67 }
};

/**
 * The stand-in gun's type id: never looked up (no /weapon graphic, no SDE row).
 */
export const STAND_IN_GUN_TYPE_ID = -1;

/**
 * Every stand-in gun's signature resolution (m).
 */
export const STAND_IN_SIGNATURE_RESOLUTION = 40_000;

/**
 * The share of a volley by damage type.
 */
export const STAND_IN_DAMAGE_SPLIT: DamageVector = { em: 0, thermal: 0.5, kinetic: 0.5, explosive: 0 };

/**
 * The fitting key of a stand-in's guns and its get_state fit key.
 */
export const STAND_IN_FIT_KEY = 'stand-in';

/**
 * A class's gun.
 */
export interface StandInGun {
  readonly name: string;
  readonly damage: DamageVector;
  readonly volley: number;
  readonly cycleTime: number;
  readonly dps: number;
  readonly optimal: number;
  readonly falloff: number;
  readonly tracking: number;
  readonly signatureResolution: number;
}

/**
 * What a stand-in fights with.
 */
export interface StandInCombat {
  readonly shipClass: ShipClass;
  readonly defense: ShipDefense;
  readonly targeting: ShipTargeting;
  readonly gun: StandInGun;
  /**
   * How many guns it fits.
   */
  readonly guns: number;
}

/**
 * A class's stand-in numbers in the pipeline's shapes.
 *
 * @param shipClass - The class.
 * @returns Its defense, targeting and gun.
 */
export function standInCombatOf(shipClass: ShipClass): StandInCombat {
  const numbers = STAND_IN_CLASS_COMBAT[shipClass];
  const damage = Object.fromEntries(DAMAGE_TYPES.map((type) => [type, numbers.volley * STAND_IN_DAMAGE_SPLIT[type]])) as Record<DamageType, number>;
  const volley = damageTotal(damage);
  const layer = (name: DefenseLayerName) => defenseLayerOf(numbers.hp[name], STAND_IN_RESONANCES[name]);
  return {
    shipClass,
    defense: shipDefenseFrom({ shield: layer('shield'), armor: layer('armor'), structure: layer('structure'), shieldRecharge: numbers.shieldRecharge }),
    targeting: { ...numbers.targeting },
    gun: {
      name: `Stand-in ${shipClass} gun`,
      damage,
      volley,
      cycleTime: numbers.cycleTime,
      dps: volley / numbers.cycleTime,
      optimal: numbers.optimal,
      falloff: numbers.falloff,
      tracking: numbers.tracking,
      signatureResolution: STAND_IN_SIGNATURE_RESOLUTION
    },
    guns: numbers.guns
  };
}

/**
 * The module key of a stand-in's gun.
 *
 * @param index - The gun, from 0.
 * @returns `high-<index>`.
 */
export function standInGunKeyOf(index: number): string {
  return `high-${index}`;
}

/**
 * One stand-in gun's turret numbers: a tracking turret with no charge and no note.
 *
 * @param combat - The stand-in.
 * @param index - The gun, from 0.
 * @returns The numbers combat reads.
 */
export function standInTurretNumbersOf(combat: StandInCombat, index: number): TurretCombatNumbers {
  const { gun } = combat;
  return {
    key: standInGunKeyOf(index),
    typeID: STAND_IN_GUN_TYPE_ID,
    name: gun.name,
    kind: 'tracking',
    damage: gun.damage,
    volley: gun.volley,
    cycleTime: gun.cycleTime,
    dps: gun.dps,
    optimal: gun.optimal,
    falloff: gun.falloff,
    tracking: gun.tracking,
    signatureResolution: gun.signatureResolution
  };
}

/**
 * One stand-in gun's activation: a targeted turret with no capacitor need, no reactivation delay and no effect (so
 * module effects and audio stay silent).
 *
 * @param combat - The stand-in.
 * @param key - The gun's module key.
 * @returns The activation the cycle reads.
 */
export function standInActivationOf(combat: StandInCombat, key: string): ModuleActivation {
  const { gun } = combat;
  return {
    key,
    category: 'weapon',
    groupID: 0,
    refusal: null,
    weapon: 'turret',
    targeted: true,
    reach: Number.POSITIVE_INFINITY,
    warpSafe: false,
    cycleTime: gun.cycleTime,
    capacitorNeed: 0,
    range: gun.optimal,
    falloff: gun.falloff,
    repair: null,
    reactivationDelay: 0,
    maxGroupActive: 0,
    maxGroupOnline: 0,
    flight: false
  };
}

/**
 * A ship's stand-in settings, used only without EVE data.
 */
export interface SceneShipStandIn {
  /**
   * The class its stand-in guns, HP, targeting and flight numbers come from; a cruiser when omitted.
   */
  class?: ShipClass;
}

export interface NormalizeShipStandInInput {
  readonly input: unknown;
  readonly where: string;
}

export interface NormalizedShipStandIn {
  /**
   * The settings; null when absent or empty.
   */
  readonly standIn: Maybe<SceneShipStandIn>;
  readonly problems: string[];
  readonly warnings: string[];
}

const STAND_IN_KEYS = new Set<string>(['class']);

/**
 * Reads a ship's `standIn`.
 *
 * @param config - The value and where it sits.
 * @returns The settings, problems and warnings.
 */
export function normalizeShipStandIn(config: NormalizeShipStandInInput): NormalizedShipStandIn {
  const { input, where } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  const standIn: SceneShipStandIn = {};
  if (isPlainObject(input)) {
    reportUnknownKeys(input, STAND_IN_KEYS, where, warnings);
    const value = input['class'];
    if (value != null) {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : null;
      if (text != null && (SHIP_CLASSES as readonly string[]).includes(text)) standIn.class = text as ShipClass;
      else problems.push(`${where}.class must be one of ${SHIP_CLASSES.join(', ')}`);
    }
  } else if (input != null) {
    problems.push(`${where} must be an object { class? }`);
  }
  return { standIn: Object.keys(standIn).length ? standIn : null, problems, warnings };
}

/**
 * Whether two ships' stand-in settings are the same.
 *
 * @param a - One ship's `standIn`.
 * @param b - The other's.
 * @returns True when they pick the same class.
 */
export function sameStandIn(a: Maybe<SceneShipStandIn>, b: Maybe<SceneShipStandIn>): boolean {
  return (a?.class ?? null) === (b?.class ?? null);
}
