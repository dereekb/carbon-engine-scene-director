/**
 * The live prop mod switch: what the switch_prop_mods tool runs, and what a timeline beat will embed.
 */

import { isPlainObject } from '../json';
import { FLEET_SELECTION_KEYS, type FleetSelection, readFleetSelection } from '../fleets/selection';
import { MAX_FLEET_ORDER_DELAY } from '../fleets/orders';
import { SceneError } from '../scene';

export interface PropModSwitch extends FleetSelection {
  /**
   * True switches the selected ships' prop mods on, false off.
   */
  readonly active: boolean;
  /**
   * How slowly the pilots respond, 0 (at once) to 1 (very delayed): each ship switches after its own pseudo-random
   * time, up to `delay` × MAX_FLEET_ORDER_DELAY seconds (toPilotDelays), as fleet orders do. Unset, each pilot answers after
   * its reaction (ships[].pilot, or its personality fleet's draw), else at once.
   */
  readonly delay?: number;
}

const SWITCH_KEYS = new Set<string>(['active', 'delay', ...FLEET_SELECTION_KEYS]);

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
    const delay = input['delay'];
    if (delay != null && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 1)) problems.push(`${where}.delay must be a number in [0, 1]: 0 the pilots respond at once, 1 very delayed (up to ${MAX_FLEET_ORDER_DELAY} s)`);
    result = { ...selection, active: active === true, ...(typeof delay === 'number' ? { delay } : {}) };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}
