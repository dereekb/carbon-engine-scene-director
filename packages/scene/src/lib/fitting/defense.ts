/**
 * The numbers an evaluated ship gives the stats and the damage model: HP and resists per layer with omni EHP, the
 * capacitor (numbers and its capacitor warfare resistances; the page keeps the live level), targeting, and each
 * module's cycle, capacitor need, range and repair.
 */

import type { Maybe } from '@dereekb/util';
import type { DogmaBundle } from './dogma-bundle';
import { dogmaResistanceOf, type DogmaShip } from './dogma';

export type DamageType = 'em' | 'thermal' | 'kinetic' | 'explosive';

export const DAMAGE_TYPES: readonly DamageType[] = ['em', 'thermal', 'kinetic', 'explosive'];

export type DefenseLayerName = 'shield' | 'armor' | 'structure';

export const DEFENSE_LAYERS: readonly DefenseLayerName[] = ['shield', 'armor', 'structure'];

/**
 * Each layer's HP attribute and its resonance attributes by damage type.
 */
export const DEFENSE_ATTRIBUTES: Readonly<Record<DefenseLayerName, { readonly hp: number; readonly resonances: Readonly<Record<DamageType, number>> }>> = {
  shield: { hp: 263, resonances: { em: 271, thermal: 274, kinetic: 273, explosive: 272 } },
  armor: { hp: 265, resonances: { em: 267, thermal: 270, kinetic: 269, explosive: 268 } },
  structure: { hp: 9, resonances: { em: 113, thermal: 110, kinetic: 109, explosive: 111 } }
};

export interface DefenseLayer {
  readonly hp: number;
  /**
   * The fraction of damage taken, by type.
   */
  readonly resonances: Readonly<Record<DamageType, number>>;
  /**
   * Percent resisted, 2 decimals.
   */
  readonly resists: Readonly<Record<DamageType, number>>;
  /**
   * Omni EHP: hp over the mean resonance.
   */
  readonly ehp: number;
}

export interface ShipDefense {
  readonly shield: DefenseLayer;
  readonly armor: DefenseLayer;
  readonly structure: DefenseLayer;
  /**
   * The layers' omni EHP summed.
   */
  readonly ehp: number;
  /**
   * Seconds for the shield to recharge from empty (EVE's shieldRechargeRate).
   */
  readonly shieldRecharge: number;
}

export interface ShipCapacitor {
  /**
   * GJ.
   */
  readonly capacity: number;
  /**
   * Seconds to recharge from empty.
   */
  readonly rechargeTime: number;
  /**
   * GJ/s at 25 %: 2.5 × capacity / rechargeTime.
   */
  readonly peakRecharge: number;
  /**
   * GJ/s the running modules use (capacitor need over cycle time).
   */
  readonly drain: number;
  readonly stable: boolean;
  /**
   * The fraction of capacity it settles at, when stable.
   */
  readonly stableAt?: number;
  /**
   * Seconds from full until empty, when not stable.
   */
  readonly lastsFor?: number;
  /**
   * The fraction of a neut's or nos' amount it takes (energyWarfareResistance, 2045; 1 when the hull lacks it).
   */
  readonly energyWarfareResistance: number;
  /**
   * The fraction of a remote capacitor transmitter's amount it takes (remoteCapacitorImpedance, 6463; 1 when the hull
   * lacks it).
   */
  readonly remoteCapacitorImpedance: number;
}

export interface ShipTargeting {
  /**
   * Metres.
   */
  readonly maxTargetRange: number;
  /**
   * mm.
   */
  readonly scanResolution: number;
  readonly maxLockedTargets: number;
}

export interface ModuleNumbers {
  readonly key: string;
  /**
   * Seconds per cycle (the default effect's duration), or null for a module that does not cycle.
   */
  readonly cycleTime: Maybe<number>;
  /**
   * GJ per cycle.
   */
  readonly capacitorNeed: number;
  /**
   * Metres: optimal range and falloff (targeted modules).
   */
  readonly range: Maybe<number>;
  readonly falloff: Maybe<number>;
  /**
   * HP per cycle for repairers (shield at cycle start, armor and hull at cycle end), with an ancillary armor
   * repairer's multiplier while it has paste loaded.
   */
  readonly repair: Maybe<{ readonly layer: DefenseLayerName; readonly amount: number; readonly remote: boolean }>;
  /**
   * Seconds before it can start again after stopping.
   */
  readonly reactivationDelay: number;
}

const SHIELD_RECHARGE_RATE = 479;
const CAPACITOR_CAPACITY = 482;
const CAPACITOR_RECHARGE_RATE = 55;
const MAX_TARGET_RANGE = 76;
const SCAN_RESOLUTION = 564;
const MAX_LOCKED_TARGETS = 192;
const SHIELD_BONUS = 68;
const ARMOR_DAMAGE_AMOUNT = 84;
const STRUCTURE_DAMAGE_AMOUNT = 83;
const CHARGED_ARMOR_DAMAGE_MULTIPLIER = 1886;
const REACTIVATION_DELAY = 669;
const ENERGY_WARFARE_RESISTANCE = 2045;
const REMOTE_CAPACITOR_IMPEDANCE = 6463;

/**
 * Repairer groups by the layer they repair and whether they repair another ship.
 */
const REPAIRER_GROUPS: Readonly<Record<number, { readonly layer: DefenseLayerName; readonly remote: boolean; readonly ancillary?: true }>> = {
  40: { layer: 'shield', remote: false },
  1156: { layer: 'shield', remote: false },
  62: { layer: 'armor', remote: false },
  1199: { layer: 'armor', remote: false, ancillary: true },
  63: { layer: 'structure', remote: false },
  41: { layer: 'shield', remote: true },
  325: { layer: 'armor', remote: true },
  2018: { layer: 'armor', remote: true },
  585: { layer: 'structure', remote: true }
};

const REPAIR_ATTRIBUTES: Readonly<Record<DefenseLayerName, number>> = { shield: SHIELD_BONUS, armor: ARMOR_DAMAGE_AMOUNT, structure: STRUCTURE_DAMAGE_AMOUNT };

/**
 * A ship's HP, resists and omni EHP per layer.
 *
 * @param ship - The evaluated ship.
 * @returns The defense.
 */
export function shipDefenseOf(ship: DogmaShip): ShipDefense {
  const layer = (name: DefenseLayerName): DefenseLayer => {
    const ids = DEFENSE_ATTRIBUTES[name];
    const resonances = Object.fromEntries(DAMAGE_TYPES.map((type) => [type, ship.attribute(ids.resonances[type])])) as Record<DamageType, number>;
    return defenseLayerOf(ship.attribute(ids.hp), resonances);
  };
  return shipDefenseFrom({ shield: layer('shield'), armor: layer('armor'), structure: layer('structure'), shieldRecharge: ship.attribute(SHIELD_RECHARGE_RATE) / 1000 });
}

/**
 * One defense layer from its HP and resonances: the resists in percent and its omni EHP.
 *
 * @param hp - The layer's HP.
 * @param resonances - The fraction of damage taken, by type.
 * @returns The layer.
 */
export function defenseLayerOf(hp: number, resonances: Readonly<Record<DamageType, number>>): DefenseLayer {
  const mean = DAMAGE_TYPES.reduce((total, type) => total + resonances[type], 0) / DAMAGE_TYPES.length;
  return { hp, resonances: { ...resonances }, resists: Object.fromEntries(DAMAGE_TYPES.map((type) => [type, Math.round((1 - resonances[type]) * 10000) / 100])) as Record<DamageType, number>, ehp: mean > 0 ? hp / mean : hp };
}

/**
 * A ship's defense from its layers: their omni EHP summed.
 *
 * @param input - The three layers and the shield recharge time (s).
 * @returns The defense.
 */
export function shipDefenseFrom(input: Pick<ShipDefense, 'shield' | 'armor' | 'structure' | 'shieldRecharge'>): ShipDefense {
  const { shield, armor, structure, shieldRecharge } = input;
  return { shield, armor, structure, ehp: shield.ehp + armor.ehp + structure.ehp, shieldRecharge };
}

/**
 * A ship's targeting numbers.
 *
 * @param ship - The evaluated ship.
 * @returns Range, scan resolution and lock count.
 */
export function shipTargetingOf(ship: DogmaShip): ShipTargeting {
  return { maxTargetRange: ship.attribute(MAX_TARGET_RANGE), scanResolution: ship.attribute(SCAN_RESOLUTION), maxLockedTargets: ship.attribute(MAX_LOCKED_TARGETS) };
}

/**
 * A fitted module's numbers.
 *
 * @param ship - The evaluated ship.
 * @param bundle - The bundle it was evaluated from (for the module's default effect).
 * @param key - The module key.
 * @returns The numbers, or null for a key the ship does not fit.
 */
export function moduleNumbersOf(ship: DogmaShip, bundle: DogmaBundle, key: string): Maybe<ModuleNumbers> {
  const module = ship.modules.get(key);
  if (!module) return null;
  const effect = module.type.defaultEffect == null ? null : bundle.effects[module.type.defaultEffect];
  const read = (attribute: Maybe<number>): Maybe<number> => (attribute == null ? null : ship.moduleAttribute(key, attribute));
  const duration = read(effect?.durationAttributeID);
  const repairer = REPAIRER_GROUPS[module.type.groupID];
  let repair: ModuleNumbers['repair'] = null;
  if (repairer) {
    const amount = ship.moduleAttribute(key, REPAIR_ATTRIBUTES[repairer.layer]) ?? 0;
    const multiplier = repairer.ancillary && module.charge ? (ship.moduleAttribute(key, CHARGED_ARMOR_DAMAGE_MULTIPLIER) ?? 1) : 1;
    repair = { layer: repairer.layer, amount: amount * multiplier, remote: repairer.remote };
  }
  return {
    key,
    cycleTime: duration ? duration / 1000 : null,
    capacitorNeed: read(effect?.dischargeAttributeID) ?? 0,
    range: read(effect?.rangeAttributeID),
    falloff: read(effect?.falloffAttributeID),
    repair,
    reactivationDelay: (ship.moduleAttribute(key, REACTIVATION_DELAY) ?? 0) / 1000
  };
}

/**
 * The HP/s a ship's running local repairers give each layer.
 *
 * @param ship - The evaluated ship.
 * @param bundle - Its bundle.
 * @param active - The keys of the running modules.
 * @returns HP/s by layer.
 */
export function localRepairRates(ship: DogmaShip, bundle: DogmaBundle, active: Iterable<string>): Record<DefenseLayerName, number> {
  const rates: Record<DefenseLayerName, number> = { shield: 0, armor: 0, structure: 0 };
  for (const key of active) {
    const numbers = moduleNumbersOf(ship, bundle, key);
    if (numbers?.repair && !numbers.repair.remote && numbers.cycleTime) rates[numbers.repair.layer] += numbers.repair.amount / numbers.cycleTime;
  }
  return rates;
}

/**
 * A ship's capacitor with the given modules running: EVE's recharge curve `dC/dt = 10·C/τ·(√c − c)` (c the fraction
 * full) against a constant drain. Stable when the drain is at most the peak recharge; it then settles where they meet.
 * Numbers only: nothing tracks a live level, and nothing stops for want of capacitor.
 *
 * @param ship - The evaluated ship.
 * @param bundle - Its bundle.
 * @param active - The keys of the running modules.
 * @returns The capacitor.
 */
export function shipCapacitorOf(ship: DogmaShip, bundle: DogmaBundle, active: Iterable<string>): ShipCapacitor {
  const capacity = ship.attribute(CAPACITOR_CAPACITY);
  const rechargeTime = ship.attribute(CAPACITOR_RECHARGE_RATE) / 1000;
  const peakRecharge = rechargeTime > 0 ? (2.5 * capacity) / rechargeTime : 0;
  let drain = 0;
  for (const key of active) {
    const numbers = moduleNumbersOf(ship, bundle, key);
    if (numbers?.cycleTime && numbers.capacitorNeed > 0) drain += numbers.capacitorNeed / numbers.cycleTime;
  }
  const capacitor = { capacity, rechargeTime, peakRecharge, drain, energyWarfareResistance: dogmaResistanceOf(ship, bundle, ENERGY_WARFARE_RESISTANCE), remoteCapacitorImpedance: dogmaResistanceOf(ship, bundle, REMOTE_CAPACITOR_IMPEDANCE) };
  let result: ShipCapacitor;
  if (drain <= peakRecharge || capacity <= 0) {
    const k = capacity > 0 && rechargeTime > 0 ? (drain * rechargeTime) / (10 * capacity) : 0;
    const root = (1 + Math.sqrt(Math.max(0, 1 - 4 * k))) / 2;
    result = { ...capacitor, stable: true, stableAt: Math.round(root * root * 10000) / 10000 };
  } else {
    result = { ...capacitor, stable: false, lastsFor: capacitorLastsFor({ capacity, rechargeTime, drain }) };
  }
  return result;
}

const CAPACITOR_STEP_S = 0.1;
const CAPACITOR_HORIZON_S = 86_400;

function capacitorLastsFor(input: { readonly capacity: number; readonly rechargeTime: number; readonly drain: number }): number {
  const { capacity, rechargeTime, drain } = input;
  let level = capacity;
  let time = 0;
  while (level > 0 && time < CAPACITOR_HORIZON_S) {
    const fraction = level / capacity;
    level += ((10 * capacity) / rechargeTime) * (Math.sqrt(fraction) - fraction) * CAPACITOR_STEP_S - drain * CAPACITOR_STEP_S;
    time += CAPACITOR_STEP_S;
  }
  return Math.round(time * 10) / 10;
}
