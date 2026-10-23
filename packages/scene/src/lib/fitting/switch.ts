/**
 * The live module switch: what the switch_modules tool runs, and what a timeline beat will embed.
 */

import { isPlainObject } from '../json';
import { FLEET_SELECTION_KEYS, type FleetSelection, readFleetSelection } from '../fleets/selection';
import { MAX_FLEET_ORDER_DELAY } from '../fleets/orders';
import { SceneError } from '../scene';

/**
 * What switch_modules asks of the selected modules: run them, stop them (online) or take them offline.
 */
export const MODULE_SWITCH_STATES = ['active', 'online', 'offline'] as const;

export type ModuleSwitchState = (typeof MODULE_SWITCH_STATES)[number];

export interface ModuleSwitch extends FleetSelection {
  /**
   * Module selectors: a module key (`mid-2`), a category keyword (`hardener`, MODULE_CATEGORIES), a weapon kind
   * (`turret`, `launcher`), `all`, or a module's exact name in any case (selectFittedModules).
   */
  readonly modules: readonly string[];
  readonly state: ModuleSwitchState;
  /**
   * The ship a targeted module (remote repairer, web, scram, neut, ...) runs on. For turrets it becomes the ship's
   * target (set_target), and may be an object; turrets without it fire at the ship's target.
   */
  readonly target?: string;
  /**
   * How slowly the pilots respond, 0 (at once, the default) to 1 (very delayed): each ship switches after its own
   * pseudo-random time, up to `delay` × MAX_FLEET_ORDER_DELAY seconds (toPilotDelays), as switch_prop_mods does.
   */
  readonly delay?: number;
}

const SWITCH_KEYS = new Set<string>(['modules', 'state', 'target', 'delay', ...FLEET_SELECTION_KEYS]);

/**
 * Validates a module switch: `modules` (one or more selectors), `state`, an optional `target` and `delay`, and a
 * selection (exactly one of `ships` and `fleet`, a fleet narrowed by `wing` or `squad`). Unknown keys are problems.
 *
 * @param input - The candidate switch.
 * @param where - Where it sits, for messages.
 * @returns The switch.
 * @throws {SceneError} With every problem found.
 */
export function normalizeModuleSwitch(input: unknown, where = 'switch'): ModuleSwitch {
  const problems: string[] = [];
  let result: ModuleSwitch = { modules: [], state: 'online' };
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { ships | fleet [, wing | squad], modules, state, target?, delay? }`);
  } else {
    for (const key of Object.keys(input)) if (!SWITCH_KEYS.has(key)) problems.push(`${where}.${key} is not a switch_modules field`);
    const modules = input['modules'];
    const selectors = Array.isArray(modules) ? modules.filter((selector): selector is string => typeof selector === 'string' && selector.trim() !== '').map((selector) => selector.trim()) : [];
    if (!Array.isArray(modules) || !selectors.length || selectors.length !== modules.length) problems.push(`${where}.modules must be a non-empty array of module selectors: a module key ("mid-2"), a category ("hardener", "remote-armor-repairer", "prop", ...), "turret", "launcher", "all" or a module name`);
    const state = input['state'];
    if (typeof state !== 'string' || !(MODULE_SWITCH_STATES as readonly string[]).includes(state)) problems.push(`${where}.state must be one of ${MODULE_SWITCH_STATES.join(', ')}`);
    const target = input['target'];
    if (target != null && (typeof target !== 'string' || !target.trim())) problems.push(`${where}.target must be a ship id (or, for turrets, an object id)`);
    const selection = readFleetSelection(input, where, problems);
    const delay = input['delay'];
    if (delay != null && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 1)) problems.push(`${where}.delay must be a number in [0, 1]: 0 the pilots respond at once, 1 very delayed (up to ${MAX_FLEET_ORDER_DELAY} s)`);
    result = {
      ...selection,
      modules: selectors,
      state: state as ModuleSwitchState,
      ...(typeof target === 'string' && target.trim() ? { target: target.trim() } : {}),
      ...(typeof delay === 'number' && delay > 0 ? { delay } : {})
    };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}
