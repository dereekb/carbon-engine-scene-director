/**
 * How a fitted module activates: whether it can (and why not), whether it needs a target, whether it is warp safe, its
 * cycle and reactivation delay, its reach and repair, and its group limits. The page's activation layer
 * (switch_modules) runs on these numbers; they come from the evaluated ship, so skills and hull bonuses apply.
 */

import type { Maybe } from '@dereekb/util';
import { moduleCategoryOf, type ModuleCategory } from './categories';
import type { DogmaShip } from './dogma';
import type { DogmaBundle } from './dogma-bundle';
import { moduleNumbersOf, type ModuleNumbers } from './defense';

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
  80: 'ECM bursts are not modelled yet'
};

/**
 * Categories that cycle with no effect yet, with the note get_state shows.
 */
export const EFFECTLESS_CATEGORIES: Readonly<Partial<Record<ModuleCategory, string>>> = {
  'command-burst': 'cycles without effect: command burst buffs are not modelled yet',
  'cap-booster': 'cycles without effect: the capacitor is not live yet',
  web: 'cycles without effect on its target yet',
  scram: 'cycles without effect on its target yet',
  point: 'cycles without effect on its target yet',
  neut: 'cycles without effect on its target yet',
  nos: 'cycles without effect on its target yet',
  'weapon-disruptor': 'cycles without effect on its target yet',
  'sensor-dampener': 'cycles without effect on its target yet',
  'target-painter': 'cycles without effect on its target yet',
  ecm: 'cycles without effect on its target yet',
  'remote-capacitor': 'cycles without effect on its target yet'
};

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
  let refusal: Maybe<string> = null;
  if (category === 'weapon') refusal = 'weapons are not modelled yet (the Turrets entry)';
  else if (UNACTIVATABLE_GROUPS[type.groupID]) refusal = UNACTIVATABLE_GROUPS[type.groupID];
  else if (!effect || (effect.category !== 1 && effect.category !== 2)) refusal = 'it is passive: it is only online or offline';
  const flight = Boolean(effect?.modifiers.some((modifier) => modifier.domain === 'shipID' && SHIP_FLIGHT_ATTRIBUTES.has(modifier.modifiedAttributeID)));
  const note = EFFECTLESS_CATEGORIES[category];
  return {
    ...numbers,
    category,
    groupID: type.groupID,
    refusal,
    targeted: effect?.category === 2,
    warpSafe: effect?.warpSafe === true,
    cycleTime: numbers.cycleTime ?? DEFAULT_MODULE_CYCLE_TIME,
    maxGroupActive: ship.moduleAttribute(key, MAX_GROUP_ACTIVE) ?? 0,
    maxGroupOnline: ship.moduleAttribute(key, MAX_GROUP_ONLINE) ?? 0,
    flight,
    ...(note && !refusal ? { note } : {})
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
