/**
 * The live target command: what the set_target tool runs, and what a timeline beat will embed.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject } from '../json';
import { FLEET_SELECTION_KEYS, type FleetSelection, readFleetSelection } from '../fleets/selection';
import { CELESTIAL_TARGET_PREFIX } from '../location/targets';
import { SceneError } from '../scene';

/**
 * Why a location celestial (`celestial:<id>`) cannot be a weapon target yet.
 */
export const CELESTIAL_TARGET_REFUSAL = "the location's stations and gates cannot be targeted yet: target a ship or an authored object (add_objects)";

export interface TargetCommand extends FleetSelection {
  /**
   * The ship or authored object the selected ships target; null clears their targets.
   */
  readonly target: Maybe<string>;
}

const TARGET_KEYS = new Set<string>(['target', ...FLEET_SELECTION_KEYS]);

/**
 * Validates a target command: `target` (a ship or object id, or null to clear) and a selection (exactly one of `ships`
 * and `fleet`, a fleet narrowed by `wing` or `squad`). Unknown keys are problems; a celestial target is refused.
 *
 * @param input - The candidate command.
 * @param where - Where it sits, for messages.
 * @returns The command.
 * @throws {SceneError} With every problem found.
 */
export function normalizeTargetCommand(input: unknown, where = 'set_target'): TargetCommand {
  const problems: string[] = [];
  let result: TargetCommand = { target: null };
  if (!isPlainObject(input)) {
    problems.push(`${where} must be an object { ships | fleet [, wing | squad], target }`);
  } else {
    for (const key of Object.keys(input)) if (!TARGET_KEYS.has(key)) problems.push(`${where}.${key} is not a set_target field`);
    const target = input['target'];
    if (!('target' in input)) problems.push(`${where}.target is required: a ship or object id, or null to clear the targets`);
    else if (target !== null && (typeof target !== 'string' || !target.trim())) problems.push(`${where}.target must be a ship or object id, or null to clear the targets`);
    else if (typeof target === 'string' && target.trim().startsWith(CELESTIAL_TARGET_PREFIX)) problems.push(`${where}.target "${target.trim()}": ${CELESTIAL_TARGET_REFUSAL}`);
    const selection = readFleetSelection(input, where, problems);
    result = { ...selection, target: typeof target === 'string' ? target.trim() : null };
  }
  if (problems.length) throw new SceneError(problems);
  return result;
}
