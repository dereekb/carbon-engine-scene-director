/**
 * How a fitted module activates: whether it can (and why not), whether it needs a target, whether it is warp safe, its
 * cycle and reactivation delay, its reach and repair, and its group limits. The page's activation layer
 * (switch_modules) runs on these numbers; they come from the evaluated ship, so skills and hull bonuses apply.
 */

import type { Maybe } from '@dereekb/util';
import { moduleCategoryOf, type ModuleCategory, weaponKindOf, type WeaponKind } from './categories';
import type { DogmaShip } from './dogma';
import type { DogmaBundle } from './dogma-bundle';
import { moduleNumbersOf, type ModuleNumbers } from './defense';
import { moduleTargetEffectOf, type ModuleTargetEffect } from './target-effects';
import { isMissileCharge } from '../weapons/default-missiles';

/**
 * Groups that cannot be activated yet, with why.
 */
export const UNACTIVATABLE_GROUPS: Readonly<Record<number, string>> = {
  1189: 'micro jump drives are not modelled yet',
  1533: 'micro jump field generators are not modelled yet',
  330: 'cloaks are not modelled yet',
  658: 'cynosural fields are not modelled yet',
  899: 'warp disruption field generators are not modelled yet',
  72: 'smartbombs are not modelled yet',
  80: 'ECM bursts are not modelled yet',
  862: 'bomb launchers are not modelled yet'
};

/**
 * Categories that cycle with no effect yet, with the note get_state shows.
 */
export const EFFECTLESS_CATEGORIES: Readonly<Partial<Record<ModuleCategory, string>>> = {
  'command-burst': 'cycles without effect: command burst buffs are not modelled yet',
  'cap-booster': 'cycles without effect: cap boosters do not refill the live capacitor yet',
  'weapon-disruptor': 'cycles without effect: weapons are not modelled yet',
  'sensor-dampener': 'cycles without effect: locks are not modelled yet',
  ecm: 'cycles without effect: locks are not modelled yet'
};

/**
 * The note of a targeted module that does nothing modelled to its target.
 */
export const TARGET_EFFECTLESS_NOTE = 'cycles without effect on its target yet';

/**
 * Why a launcher without a missile loaded cannot be activated.
 */
export const NO_MISSILE_REFUSAL = 'it has no missiles loaded';

/**
 * Seconds per cycle for an activatable module without a duration.
 */
export const DEFAULT_MODULE_CYCLE_TIME = 10;

const MAX_GROUP_ACTIVE = 763;
const MAX_GROUP_ONLINE = 978;
const SHIP_FLIGHT_ATTRIBUTES: ReadonlySet<number> = new Set([4, 37, 70]);

export interface ModuleActivation extends Omit<ModuleNumbers, 'cycleTime'> {
  readonly category: ModuleCategory;
  readonly groupID: number;
  /**
   * Why it cannot be activated; null when it can.
   */
  readonly refusal: Maybe<string>;
  /**
   * Its default effect is a target effect (category 2): it runs on another ship.
   */
  readonly targeted: boolean;
  /**
   * `turret` or `launcher` for a weapon (effects 42 / 40).
   */
  readonly weapon?: WeaponKind;
  /**
   * Metres it may run at: moduleReach for a targeted module, Infinity for a weapon (EVE refuses no turret or launcher
   * by range: shots beyond falloff miss, missiles past their range expire) and for an untargeted module.
   */
  readonly reach: number;
  /**
   * Its default effect is warp safe: entering warp leaves it running.
   */
  readonly warpSafe: boolean;
  /**
   * Seconds; DEFAULT_MODULE_CYCLE_TIME for an activatable module without a duration.
   */
  readonly cycleTime: number;
  /**
   * How many of its group may run at once; 0 when unlimited.
   */
  readonly maxGroupActive: number;
  /**
   * How many of its group may be online at once; 0 when unlimited.
   */
  readonly maxGroupOnline: number;
  /**
   * Running it changes the ship's mass, max velocity or agility (siege, triage): the ship's flight must be recomputed.
   */
  readonly flight: boolean;
  /**
   * What running it does not do yet.
   */
  readonly note?: string;
  /**
   * Its default effect's guid (`effects.ArmorHardening`): the client effect and sounds it plays (effects.ts).
   */
  readonly effectGuid?: string;
  /**
   * What it does to its target (webs, painters, points, scrams, neuts, nos, transmitters: target-effects.ts).
   */
  readonly targetEffect?: ModuleTargetEffect;
}

/**
 * How a fitted module activates.
 *
 * @param ship - The evaluated ship.
 * @param bundle - The bundle it was evaluated from.
 * @param key - The module key.
 * @returns The activation, or null for a key the ship does not fit.
 */
export function moduleActivationOf(ship: DogmaShip, bundle: DogmaBundle, key: string): Maybe<ModuleActivation> {
  const module = ship.modules.get(key);
  const numbers = moduleNumbersOf(ship, bundle, key);
  if (!module || !numbers) return null;
  const { type } = module;
  const effect = type.defaultEffect == null ? null : bundle.effects[type.defaultEffect];
  const category = moduleCategoryOf(type.groupID, type.effects);
  const weapon = weaponKindOf(type.effects);
  let refusal: Maybe<string> = null;
  if (UNACTIVATABLE_GROUPS[type.groupID]) refusal = UNACTIVATABLE_GROUPS[type.groupID];
  else if (weapon === 'launcher' && !(module.charge && isMissileCharge(module.charge))) refusal = NO_MISSILE_REFUSAL;
  else if (!effect || (effect.category !== 1 && effect.category !== 2)) refusal = 'it is passive: it is only online or offline';
  const flight = Boolean(effect?.modifiers.some((modifier) => modifier.domain === 'shipID' && SHIP_FLIGHT_ATTRIBUTES.has(modifier.modifiedAttributeID)));
  // A launcher's useMissiles is category 1 in the SDE, yet it fires at the ship's target like a turret.
  const targeted = effect?.category === 2 || weapon === 'launcher';
  const targetEffect = targeted ? moduleTargetEffectOf(ship, bundle, key) : null;
  const note = EFFECTLESS_CATEGORIES[category] ?? (targeted && !weapon && !numbers.repair && !targetEffect ? TARGET_EFFECTLESS_NOTE : null);
  return {
    ...numbers,
    category,
    groupID: type.groupID,
    refusal,
    ...(weapon ? { weapon } : {}),
    reach: weapon || effect?.category !== 2 ? Number.POSITIVE_INFINITY : moduleReach(numbers),
    targeted,
    warpSafe: effect?.warpSafe === true,
    cycleTime: numbers.cycleTime ?? DEFAULT_MODULE_CYCLE_TIME,
    maxGroupActive: ship.moduleAttribute(key, MAX_GROUP_ACTIVE) ?? 0,
    maxGroupOnline: ship.moduleAttribute(key, MAX_GROUP_ONLINE) ?? 0,
    flight,
    ...(note && !refusal ? { note } : {}),
    ...(effect?.guid ? { effectGuid: effect.guid } : {}),
    ...(targetEffect ? { targetEffect } : {})
  };
}

/**
 * How well a targeted module applies at a distance: 1 within optimal, then EVE's falloff curve.
 *
 * @param input - The surface distance, the optimal range and the falloff (metres).
 * @returns The factor, 0-1.
 */
export function falloffEffectiveness(input: { readonly distance: number; readonly range: Maybe<number>; readonly falloff: Maybe<number> }): number {
  const { distance, range, falloff } = input;
  const beyond = Math.max(0, distance - (range ?? 0));
  let factor = 1;
  if (beyond > 0) factor = falloff && falloff > 0 ? 0.5 ** ((beyond / falloff) ** 2) : 0;
  return factor;
}

/**
 * How far a targeted module reaches: its optimal range, plus twice its falloff when it has one.
 *
 * @param input - The optimal range and the falloff (metres).
 * @returns Metres; Infinity without a range.
 */
export function moduleReach(input: { readonly range: Maybe<number>; readonly falloff: Maybe<number> }): number {
  const { range, falloff } = input;
  return range == null ? Number.POSITIVE_INFINITY : range + 2 * Math.max(0, falloff ?? 0);
}
