/**
 * The typed fit: a parsed EFT fit with each name resolved to its EVE type (the hub's `/fit/type`). Modules take their
 * real slot from their type's slot effect and a key `<slot>-<n>` (written order within the slot); quantity lines split
 * by category into drones, charges (the ammo pool) and cargo.
 */

import type { Maybe } from '@dereekb/util';
import { moduleCategoryOf, type ModuleCategory, weaponKindOf, type WeaponKind } from './categories';
import type { DogmaBundle, FitTypeAnswer, FitTypeCategory } from './dogma-bundle';
import type { DogmaModuleInput, DogmaModuleState } from './dogma';
import type { EftFit, EftItemLine, EftLine, EftSlot } from './eft';

const PROP_MOD_GROUP = 46;

export interface FittedModuleCharge {
  readonly name: string;
  readonly typeID: Maybe<number>;
}

export interface FittedModule {
  /**
   * `<slot>-<n>`: the n-th (from 0) fitted module of its slot in written order.
   */
  readonly key: string;
  /**
   * The canonical name, or the name as written when it did not resolve.
   */
  readonly name: string;
  readonly typeID: Maybe<number>;
  readonly groupID: Maybe<number>;
  readonly slot: EftSlot;
  readonly category: ModuleCategory;
  /**
   * A turret or launcher (effect 42 / 40), when the bundle knows the module's effects.
   */
  readonly weapon?: WeaponKind;
  readonly offline?: true;
  readonly charge?: FittedModuleCharge;
  /**
   * The fit's first prop mod (group 46): the module the ship's `propMod` stands for.
   */
  readonly prop?: true;
  readonly line: number;
}

export interface FitItem {
  readonly name: string;
  readonly typeID: Maybe<number>;
  readonly quantity: number;
  readonly category: FitTypeCategory | 'unknown';
  readonly line: number;
}

export interface ShipFitting {
  readonly hull: string;
  readonly name: string;
  readonly modules: FittedModule[];
  /**
   * Drone and fighter lines.
   */
  readonly drones: FitItem[];
  /**
   * Cargo items of category Charge: the ammo pool weapons load from.
   */
  readonly charges: FitItem[];
  readonly cargo: FitItem[];
  /**
   * Implants and boosters (reported, not applied).
   */
  readonly implants: EftLine[];
  /**
   * Names that did not resolve; their lines are left out of dogma.
   */
  readonly unknown: string[];
  readonly empty: Record<EftSlot, number>;
  readonly warnings: string[];
}

export interface TypeEftFitConfig {
  /**
   * The type a name resolves to, or null when it does not (yet).
   */
  readonly answer: (name: string) => Maybe<FitTypeAnswer>;
  /**
   * The dogma bundle, to tell a scram from a point, siege from triage, and weapons by their effects.
   */
  readonly bundle?: Maybe<DogmaBundle>;
}

/**
 * Types a parsed fit.
 *
 * @param fit - The parsed EFT fit (parseEftFit).
 * @param config - The name answers and, optionally, the bundle.
 * @returns The typed fit.
 */
export function typeEftFit(fit: EftFit, config: TypeEftFitConfig): ShipFitting {
  const { answer, bundle } = config;
  const unknown = new Set<string>();
  const resolve = (name: string): Maybe<FitTypeAnswer> => {
    const found = answer(name);
    if (!found) unknown.add(name);
    return found;
  };
  const typed: ShipFitting = { hull: fit.hull, name: fit.name, modules: [], drones: [], charges: [], cargo: [], implants: [...fit.implants], unknown: [], empty: { ...fit.empty }, warnings: [...fit.warnings] };
  const counts: Partial<Record<EftSlot, number>> = {};
  let prop = false;
  const items: EftItemLine[] = [...fit.drones, ...fit.cargo];
  for (const line of fit.modules) {
    const type = resolve(line.name);
    if (type && type.category !== 'module' && type.category !== 'subsystem' && type.category !== 'structure-module') {
      typed.warnings.push(`line ${line.line}: "${line.name}" is a ${type.category}, not a module; counted as cargo`);
      items.push({ name: line.name, quantity: 1, line: line.line });
      continue;
    }
    const slot = type?.slot ?? line.slot;
    const index = counts[slot] ?? 0;
    counts[slot] = index + 1;
    const isProp = !prop && type?.groupID === PROP_MOD_GROUP;
    if (isProp) prop = true;
    const charge = line.charge ? resolve(line.charge) : null;
    const effects = type?.typeID == null ? null : bundle?.types[type.typeID]?.effects;
    const weapon = weaponKindOf(effects);
    typed.modules.push({
      key: `${slot}-${index}`,
      name: type?.name ?? line.name,
      typeID: type?.typeID ?? null,
      groupID: type?.groupID ?? null,
      slot,
      category: type ? moduleCategoryOf(type.groupID, effects) : 'other',
      ...(weapon ? { weapon } : {}),
      ...(line.offline ? { offline: true as const } : {}),
      ...(line.charge ? { charge: { name: charge?.name ?? line.charge, typeID: charge?.typeID ?? null } } : {}),
      ...(isProp ? { prop: true as const } : {}),
      line: line.line
    });
  }
  for (const line of items) {
    const type = resolve(line.name);
    const item: FitItem = { name: type?.name ?? line.name, typeID: type?.typeID ?? null, quantity: line.quantity, category: type?.category ?? 'unknown', line: line.line };
    if (item.category === 'drone' || item.category === 'fighter') typed.drones.push(item);
    else if (item.category === 'charge') typed.charges.push(item);
    else typed.cargo.push(item);
  }
  typed.unknown.push(...unknown);
  return typed;
}

/**
 * The EVE type names a parsed fit needs resolved: modules, charges, drones and cargo, once each.
 *
 * @param fit - The parsed fit.
 * @returns The names in written order.
 */
export function eftTypeNames(fit: EftFit): string[] {
  const names = new Set<string>();
  for (const line of fit.modules) {
    names.add(line.name);
    if (line.charge) names.add(line.charge);
  }
  for (const line of [...fit.drones, ...fit.cargo]) names.add(line.name);
  return [...names];
}

/**
 * The type ids the dogma of a typed fit needs: its modules and their charges, and the cargo charges a turret with
 * none loaded takes its ammo from (loadCargoCharges). Drones and other cargo play no part.
 *
 * @param fitting - The typed fit.
 * @returns The ids, once each.
 */
export function fittingTypeIDs(fitting: ShipFitting): number[] {
  const ids = new Set<number>();
  for (const module of fitting.modules) {
    if (module.typeID != null) ids.add(module.typeID);
    if (module.charge?.typeID != null) ids.add(module.charge.typeID);
  }
  for (const charge of fitting.charges) if (charge.typeID != null) ids.add(charge.typeID);
  return [...ids];
}

/**
 * The dogma modules of a typed fit: every resolved module, `/OFFLINE` ones offline, the rest online unless `state`
 * says otherwise.
 *
 * @param fitting - The typed fit.
 * @param state - A module's state, given its default (offline or online).
 * @returns The modules for evaluateShipDogma.
 */
export function toDogmaModules(fitting: ShipFitting, state: (module: FittedModule, fallback: DogmaModuleState) => DogmaModuleState = (_module, fallback) => fallback): DogmaModuleInput[] {
  return fitting.modules.flatMap((module): DogmaModuleInput[] => (module.typeID == null ? [] : [{ key: module.key, typeID: module.typeID, state: state(module, module.offline ? 'offline' : 'online'), ...(module.charge?.typeID == null ? {} : { chargeTypeID: module.charge.typeID }) }]));
}

/**
 * The selector that names every fitted module.
 */
export const ALL_MODULES_SELECTOR = 'all';

export interface SelectFittedModulesResult {
  /**
   * The modules named, each once, in fit order.
   */
  readonly modules: FittedModule[];
  /**
   * The selectors that named no fitted module.
   */
  readonly unmatched: string[];
}

/**
 * The fitted modules a list of selectors names. A selector is a module key (`mid-2`), a category keyword
 * (`hardener`, MODULE_CATEGORIES), a weapon kind (`turret`, `launcher`), `all`, or a module's exact name in any case.
 *
 * @param fitting - The typed fit (its modules).
 * @param selectors - The selectors.
 * @returns The modules and the selectors that matched none.
 */
export function selectFittedModules(fitting: Pick<ShipFitting, 'modules'>, selectors: readonly string[]): SelectFittedModulesResult {
  const picked = new Set<FittedModule>();
  const unmatched: string[] = [];
  for (const selector of selectors) {
    const word = selector.trim().toLowerCase();
    const matches = fitting.modules.filter((module) => word === ALL_MODULES_SELECTOR || module.key === word || module.category === word || module.weapon === word || module.name.toLowerCase() === word);
    if (!matches.length) unmatched.push(selector);
    for (const module of matches) picked.add(module);
  }
  return { modules: fitting.modules.filter((module) => picked.has(module)), unmatched };
}
