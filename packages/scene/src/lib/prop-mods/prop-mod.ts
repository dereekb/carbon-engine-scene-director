/**
 * A scene ship's propulsion module (`ships[].propMod`): which module it fits and whether it runs when the scene
 * loads. The page flies the module's numbers (stats/ship-stats.ts) while it runs; switch_prop_mods switches it live
 * and set_prop_mods edits the document.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, reportUnknownKeys } from '../json';
import { isPropModModuleKeyword, PROP_MOD_MODULE_NONE, type PropModModule, propModKindOfName, readPropModModule } from '../stats/prop-mods';

export interface SceneShipPropMod {
  /**
   * An EVE type name, a type id, "mwd" / "ab" (the Tech II module of that kind sized for the hull) or "none".
   * Omitted: DEFAULT_PROP_MOD_MODULE, the hull-sized microwarpdrive.
   */
  module?: PropModModule;
  /**
   * Running when the scene loads. Omitted: off.
   */
  active?: true;
}

const PROP_MOD_KEYS = new Set<string>(['module', 'active']);

export interface NormalizeShipPropModInput {
  readonly input: unknown;
  /**
   * Where the prop mod sits, for messages, e.g. "ships[0].propMod".
   */
  readonly where: string;
}

export interface NormalizedShipPropMod {
  /**
   * The canonical prop mod, or null when absent or empty.
   */
  readonly propMod: Maybe<SceneShipPropMod>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates a ship's prop mod. A string or a number is shorthand for `{ module }`; `active: false` is the default
 * and is dropped; unknown keys warn and are dropped; a module name that names neither a microwarpdrive nor an
 * afterburner warns (the page falls back to the hull-sized module, with a note).
 *
 * @param config - The candidate prop mod and where it sits.
 * @returns The canonical prop mod with every problem and warning found.
 */
export function normalizeShipPropMod(config: NormalizeShipPropModInput): NormalizedShipPropMod {
  const { input, where } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  const propMod: SceneShipPropMod = {};

  if (typeof input === 'string' || typeof input === 'number') {
    readModule(input, `${where}.module`, { propMod, problems, warnings });
  } else if (isPlainObject(input)) {
    reportUnknownKeys(input, PROP_MOD_KEYS, where, warnings);
    if (input['module'] != null) readModule(input['module'], `${where}.module`, { propMod, problems, warnings });
    const active = input['active'];
    if (active === true) propMod.active = true;
    else if (active != null && active !== false) problems.push(`${where}.active must be true or false`);
  } else if (input != null) {
    problems.push(`${where} must be a module (a name, a type id, "mwd", "ab" or "none") or an object { module?, active? }`);
  }

  return { propMod: Object.keys(propMod).length ? propMod : null, problems, warnings };
}

interface ReadModuleContext {
  readonly propMod: SceneShipPropMod;
  readonly problems: string[];
  readonly warnings: string[];
}

function readModule(value: unknown, where: string, context: ReadModuleContext): void {
  const module = readPropModModule(value, where, context.problems);
  if (module == null) return;
  context.propMod.module = module;
  if (typeof module === 'string' && !isPropModModuleKeyword(module) && !propModKindOfName(module)) {
    context.warnings.push(`${where} "${module}" does not look like a microwarpdrive or an afterburner; the ship flies the hull-sized module of that kind if the EVE data does not know it`);
  }
}

/**
 * Whether a ship fits a prop mod at all.
 *
 * @param propMod - The ship's prop mod.
 * @returns False only for module "none".
 */
export function fitsPropMod(propMod: Maybe<SceneShipPropMod>): boolean {
  return propMod?.module !== PROP_MOD_MODULE_NONE;
}
