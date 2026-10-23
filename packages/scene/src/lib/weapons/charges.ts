/**
 * Charges: which ammo a weapon fires. A turret or launcher with no loaded charge (`Module, Charge` in EFT) loads the
 * first cargo charge, in written order, that fits it: the module's chargeGroup1-5 hold the charge's group and the
 * chargeSize matches (a launcher takes only a missile). A launcher with none in cargo loads the caller's default
 * missile (default-missiles.ts), so every launcher fires something; turrets get no default.
 */

import type { Maybe } from '@dereekb/util';
import { weaponKindOf } from '../fitting/categories';
import type { DogmaBundle, DogmaTypeRecord } from '../fitting/dogma-bundle';
import type { FitItem, FittedModule } from '../fitting/typed-fit';
import { isMissileCharge } from './default-missiles';

/**
 * chargeGroup1-5: the charge groups a module takes.
 */
export const CHARGE_GROUP_ATTRIBUTES: readonly number[] = [604, 605, 606, 609, 610];

/**
 * chargeSize: on a module the size it takes, on a charge its own.
 */
export const CHARGE_SIZE_ATTRIBUTE = 128;

export const CHARGE_LOADED_FROM_CARGO = 'loaded from cargo';
export const NO_CHARGE_LOADED = 'no charge loaded';
export const DEFAULT_MISSILE_LOADED = 'default missile';

export type ChargeNote = typeof CHARGE_LOADED_FROM_CARGO | typeof NO_CHARGE_LOADED | typeof DEFAULT_MISSILE_LOADED;

/**
 * A fitted module with the charge it fires.
 */
export interface ChargedModule extends FittedModule {
  /**
   * Set on a weapon that loaded its charge from cargo or (a launcher) its default missile, or found none to load.
   */
  readonly chargeNote?: ChargeNote;
}

/**
 * Whether a charge fits a module: its group is one of the module's charge groups, and the sizes match when the
 * module names one.
 *
 * @param module - The module's record.
 * @param charge - The charge's record.
 * @returns True when the module can load it.
 */
export function chargeFitsModule(module: Pick<DogmaTypeRecord, 'attributes'>, charge: Pick<DogmaTypeRecord, 'groupID' | 'attributes'>): boolean {
  const groups = CHARGE_GROUP_ATTRIBUTES.map((id) => module.attributes[id]).filter((group): group is number => group != null && group > 0);
  const size = module.attributes[CHARGE_SIZE_ATTRIBUTE];
  return groups.includes(charge.groupID) && (size == null || charge.attributes[CHARGE_SIZE_ATTRIBUTE] === size);
}

export interface LoadCargoChargesOptions {
  /**
   * The missile a launcher with none loaded and none in cargo takes (defaultMissileOf at the hull's damage type); null
   * for a launcher with no default (probes, bombs).
   */
  readonly defaultMissile?: Maybe<(launcher: DogmaTypeRecord) => Maybe<{ readonly name: string; readonly typeID: number }>>;
}

/**
 * Loads each turret and launcher without a charge with the first fitting cargo charge (a launcher: the first fitting
 * missile), else a launcher with the option's default missile. A loaded charge is kept; a turret with no fitting
 * charge fires on its own numbers. Modules or cargo charges the bundle lacks are left as they are; a default missile
 * the bundle lacks still loads (the caller fetches its dogma).
 *
 * @param modules - The fit's modules.
 * @param charges - The fit's cargo charges (ShipFitting.charges), in written order.
 * @param bundle - The dogma bundle holding the modules and charges.
 * @param options - The launchers' default missile.
 * @returns The modules, weapons with their charges and notes.
 */
export function loadCargoCharges<T extends FittedModule>(modules: readonly T[], charges: readonly FitItem[], bundle: Maybe<DogmaBundle>, options: LoadCargoChargesOptions = {}): (T & ChargedModule)[] {
  return modules.map((module): T & ChargedModule => {
    const record = module.typeID == null ? null : bundle?.types[module.typeID];
    const kind = record ? weaponKindOf(record.effects) : null;
    let loaded: T & ChargedModule = module;
    if (record && !module.charge && kind != null) {
      const charge = charges.find((item) => {
        const chargeRecord = item.typeID == null ? null : bundle?.types[item.typeID];
        return chargeRecord != null && chargeFitsModule(record, chargeRecord) && (kind === 'turret' || isMissileCharge(chargeRecord));
      });
      const missile = !charge && kind === 'launcher' ? (options.defaultMissile?.(record) ?? null) : null;
      if (charge) loaded = { ...module, charge: { name: charge.name, typeID: charge.typeID }, chargeNote: CHARGE_LOADED_FROM_CARGO };
      else if (missile) loaded = { ...module, charge: { name: missile.name, typeID: missile.typeID }, chargeNote: DEFAULT_MISSILE_LOADED };
      else loaded = { ...module, chargeNote: NO_CHARGE_LOADED };
    }
    return loaded;
  });
}
