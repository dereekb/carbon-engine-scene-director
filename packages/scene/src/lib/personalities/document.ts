import type { Maybe } from '@dereekb/util';
import { ID_PATTERN, isPlainObject, type JsonObject } from '../json';
import type { FleetOperationContext } from '../fleets/operations';
import { builtInFleetPersonalities, normalizeFleetPersonality, resolveFleetPersonality } from './normalize';
import { FLEET_PERSONALITY_SCHEMA, type FleetPersonality } from './personality';

/**
 * The patch operations that edit the document's personalities.
 */
export const PERSONALITY_OPERATIONS: ReadonlySet<string> = new Set(['set_personalities']);

const SET_PERSONALITIES_KEYS = new Set<string>(['op', 'personalities']);

export interface NormalizedScenePersonalities {
  /**
   * The templates by key, or null when there are none.
   */
  readonly personalities: Maybe<Record<string, FleetPersonality>>;
  /**
   * Every name a fleet may pick: the built-ins and the keys.
   */
  readonly names: ReadonlySet<string>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates the document's `personalities`: custom `cjs-fleet-personality/1` templates by key (like `fits`), each
 * resolving through its `extends` chain. A key is an id that is not a built-in name.
 *
 * @param input - The candidate map.
 * @param where - Where it sits. Default "personalities".
 * @returns The templates, the names fleets may pick, and the problems and warnings found.
 */
export function normalizeScenePersonalities(input: unknown, where = 'personalities'): NormalizedScenePersonalities {
  const problems: string[] = [];
  const warnings: string[] = [];
  const builtIns = builtInFleetPersonalities();
  let personalities: Maybe<Record<string, FleetPersonality>> = null;
  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object of ${FLEET_PERSONALITY_SCHEMA} templates by key`);
  } else if (input != null) {
    const read: Record<string, FleetPersonality> = {};
    for (const [key, value] of Object.entries(input)) {
      const at = `${where}["${key}"]`;
      if (!ID_PATTERN.test(key)) problems.push(`${where} key "${key}" must be 1-64 letters, digits, "_", "-" or "."`);
      else if (builtIns.has(key)) problems.push(`${where} key "${key}" is a built-in personality; pick another key and extend it`);
      else {
        const normalized = normalizeFleetPersonality({ input: value, where: at, key });
        problems.push(...normalized.problems);
        warnings.push(...normalized.warnings);
        if (normalized.personality) read[key] = normalized.personality;
      }
    }
    if (!problems.length) {
      for (const key of Object.keys(read)) problems.push(...resolveFleetPersonality({ name: key, personalities: read, where: `${where}["${key}"]` }).problems);
    }
    if (Object.keys(read).length) personalities = read;
  }
  return { personalities, names: new Set([...builtIns.keys(), ...Object.keys(personalities ?? {})]), problems, warnings };
}

/**
 * Applies `{ op: "set_personalities", personalities: { "<key>": template | null } }`: merges the templates into the
 * document's `personalities`; `null` deletes a key. Deleting a key a fleet uses is a problem (a template extending it
 * fails the document's check), and an emptied map is removed. A fleet picks one with update_fleet `{ set: {
 * personality } }`.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyPersonalityOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems, warnings } = context;
  for (const key of Object.keys(operation)) if (!SET_PERSONALITIES_KEYS.has(key)) warnings.push(`${where}.${key} is not a set_personalities field and was ignored`);
  const input = operation['personalities'];
  if (!isPlainObject(input) || !Object.keys(input).length) {
    problems.push(`${where}.personalities must be an object of cjs-fleet-personality/1 templates (or null to delete) by key`);
    return;
  }
  const personalities: Record<string, unknown> = isPlainObject(draft['personalities']) ? draft['personalities'] : {};
  const used = new Map<string, string>();
  for (const fleet of Array.isArray(draft['fleets']) ? draft['fleets'] : []) {
    if (isPlainObject(fleet) && typeof fleet['personality'] === 'string' && !used.has(fleet['personality'])) used.set(fleet['personality'], String(fleet['id']));
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === null) {
      if (used.has(key)) problems.push(`${where}: personality "${key}" is used by fleet "${used.get(key)}"; change or clear that fleet's personality first`);
      else if (!(key in personalities)) warnings.push(`${where}: the scene has no personality "${key}" to delete`);
      else delete personalities[key];
    } else {
      personalities[key] = structuredClone(value);
    }
  }
  if (Object.keys(personalities).length) draft['personalities'] = personalities;
  else delete draft['personalities'];
}
