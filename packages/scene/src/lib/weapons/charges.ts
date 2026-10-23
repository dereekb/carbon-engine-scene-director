/**
 * Charges: which ammo a turret fires. A turret with no loaded charge (`Module, Charge` in EFT) loads the first cargo
 * charge, in written order, that fits it: the module's chargeGroup1-5 hold the charge's group and the chargeSize
 * matches. Launchers are left alone (the Missiles entry).
 */

import type { Maybe } from '@dereekb/util';
import { weaponKindOf } from '../fitting/categories';
import type { DogmaBundle, DogmaTypeRecord } from '../fitting/dogma-bundle';
import type { FitItem, FittedModule } from '../fitting/typed-fit';

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

export type ChargeNote = typeof CHARGE_LOADED_FROM_CARGO | typeof NO_CHARGE_LOADED;

/**
 * A fitted module with the charge it fires.
 */
export interface ChargedModule extends FittedModule {
  /**
   * Set on a turret that loaded its charge from cargo, or found none to load.
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

/**
 * Loads each turret without a charge with the first fitting cargo charge. A loaded charge is kept; a turret with no
 * fitting charge fires on its own numbers. Modules or charges the bundle lacks are left as they are.
 *
 * @param modules - The fit's modules.
 * @param charges - The fit's cargo charges (ShipFitting.charges), in written order.
 * @param bundle - The dogma bundle holding the modules and charges.
 * @returns The modules, turrets with their charges and notes.
 */
export function loadCargoCharges(modules: readonly FittedModule[], charges: readonly FitItem[], bundle: Maybe<DogmaBundle>): ChargedModule[] {
  return modules.map((module): ChargedModule => {
    const record = module.typeID == null ? null : bundle?.types[module.typeID];
    let loaded: ChargedModule = module;
    if (record && !module.charge && weaponKindOf(record.effects) === 'turret') {
      const charge = charges.find((item) => {
        const chargeRecord = item.typeID == null ? null : bundle?.types[item.typeID];
        return chargeRecord != null && chargeFitsModule(record, chargeRecord);
      });
      loaded = charge ? { ...module, charge: { name: charge.name, typeID: charge.typeID }, chargeNote: CHARGE_LOADED_FROM_CARGO } : { ...module, chargeNote: NO_CHARGE_LOADED };
    }
    return loaded;
  });
}
