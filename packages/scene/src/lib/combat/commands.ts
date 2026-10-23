/**
 * The live combat commands: what the engage and cease_fire tools run, and what a timeline beat will embed.
 */

import { isPlainObject } from '../json';
import { FLEET_SELECTION_KEYS, type FleetSelection, readFleetSelection } from '../fleets/selection';
import { CELESTIAL_TARGET_PREFIX } from '../location/targets';
import { SceneError } from '../scene';
import { CELESTIAL_TARGET_REFUSAL } from '../weapons/target';

/**
 * The weapons an engagement arms when the command names none.
 */
export const DEFAULT_ENGAGE_MODULES: readonly string[] = ['turret', 'launcher'];

export interface EngageCommand extends FleetSelection {
  /**
   * The ship or authored object the selected ships lock and shoot.
   */
  readonly target: string;
  /**
   * Module selectors for the weapons to arm (as switch_modules); default `["turret", "launcher"]`.
   */
  readonly modules: readonly string[];
}

export interface CeaseFireCommand extends FleetSelection {
  /**
   * Also clear the ships' targets (as set_target null), so their locks drop.
   */
  readonly unlock: boolean;
}

const ENGAGE_KEYS = new Set<string>(['target', 'modules', ...FLEET_SELECTION_KEYS]);
const CEASE_FIRE_KEYS = new Set<string>(['unlock', ...FLEET_SELECTION_KEYS]);

/**
 * Validates an engage command: `target` (a ship or object id), optional `modules` (selectors, default `["turret",
 * "launcher"]`) and a selection (exactly one of `ships` and `fleet`, a fleet narrowed by `wing` or `squad`). Unknown
 * keys are problems; a celestial target is refused.
 *
 * @param input - The candidate command.
 * @param where - Where it sits, for messages.
 * @returns The command.
 * @throws {SceneError} With every problem found.
 */
export function normalizeEngageCommand(input: unknown, where = 'engage'): EngageCommand {
  const problems: string[] = [];
  let result: EngageCommand = { target: '', modules: DEFAULT_ENGAGE_MODULES };
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { ships | fleet [, wing | squad], target, modules? }`);
  } else {
    for (const key of Object.keys(input)) if (!ENGAGE_KEYS.has(key)) problems.push(`${where}.${key} is not an engage field`);
    const target = input['target'];
    if (typeof target !== 'string' || !target.trim()) problems.push(`${where}.target must be a ship or object id`);
    else if (target.trim().startsWith(CELESTIAL_TARGET_PREFIX)) problems.push(`${where}.target "${target.trim()}": ${CELESTIAL_TARGET_REFUSAL}`);
    const modules = input['modules'];
    let selectors = DEFAULT_ENGAGE_MODULES;
    if (modules != null) {
      const read = Array.isArray(modules) ? modules.filter((selector): selector is string => typeof selector === 'string' && selector.trim() !== '').map((selector) => selector.trim()) : [];
      if (!Array.isArray(modules) || !read.length || read.length !== modules.length) problems.push(`${where}.modules must be a non-empty array of module selectors ("turret", a module key such as "high-0", or a module name)`);
      else selectors = read;
    }
    const selection = readFleetSelection(input, where, problems);
    result = { ...selection, target: typeof target === 'string' ? target.trim() : '', modules: selectors };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}

/**
 * Validates a cease_fire command: a selection and optional `unlock` (a boolean, default false).
 *
 * @param input - The candidate command.
 * @param where - Where it sits, for messages.
 * @returns The command.
 * @throws {SceneError} With every problem found.
 */
export function normalizeCeaseFireCommand(input: unknown, where = 'cease_fire'): CeaseFireCommand {
  const problems: string[] = [];
  let result: CeaseFireCommand = { unlock: false };
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { ships | fleet [, wing | squad], unlock? }`);
  } else {
    for (const key of Object.keys(input)) if (!CEASE_FIRE_KEYS.has(key)) problems.push(`${where}.${key} is not a cease_fire field`);
    const unlock = input['unlock'];
    if (unlock != null && typeof unlock !== 'boolean') problems.push(`${where}.unlock must be true or false`);
    const selection = readFleetSelection(input, where, problems);
    result = { ...selection, unlock: unlock === true };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}
