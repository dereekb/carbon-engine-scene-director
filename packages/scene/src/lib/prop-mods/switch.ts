/**
 * The live prop mod switch: what the switch_prop_mods tool runs, and what a timeline beat will embed.
 */

import { isPlainObject } from '../json';
import { FLEET_SELECTION_KEYS, type FleetSelection, readFleetSelection } from '../fleets/selection';
import { SceneError } from '../scene';

export interface PropModSwitch extends FleetSelection {
  /**
   * True switches the selected ships' prop mods on, false off.
   */
  readonly active: boolean;
}

const SWITCH_KEYS = new Set<string>(['active', ...FLEET_SELECTION_KEYS]);

/**
 * Validates a prop mod switch: `active` (required) and a selection (exactly one of `ships` and `fleet`, a fleet
 * narrowed by `wing` or `squad`). Unknown keys are problems.
 *
 * @param input - The candidate switch.
 * @param where - Where it sits, for messages.
 * @returns The switch.
 * @throws {SceneError} With every problem found.
 */
export function normalizePropModSwitch(input: unknown, where = 'switch'): PropModSwitch {
  const problems: string[] = [];
  let result: PropModSwitch = { active: false };
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { active, ships | fleet [, wing | squad] }`);
  } else {
    for (const key of Object.keys(input)) if (!SWITCH_KEYS.has(key)) problems.push(`${where}.${key} is not a switch_prop_mods field`);
    const active = input['active'];
    if (typeof active !== 'boolean') problems.push(`${where}.active is required: true switches prop mods on, false off`);
    const selection = readFleetSelection(input, where, problems);
    result = { ...selection, active: active === true };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}
