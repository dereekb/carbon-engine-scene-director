/**
 * The document's `combat`: the seed every shot's roll is keyed by and what a ship does at 0 structure. Kills are live
 * state like HP and locks; the document stays the setup, and a load revives everyone.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, type JsonObject } from '../json';
import type { FleetOperationContext } from '../fleets/operations';

/**
 * What a ship does at 0 structure: `explode` (the client's explosion, then it leaves the scene) or `flag` (the kill is
 * recorded and it flies on at 0 structure, taking no more damage until a load).
 */
export const COMBAT_DEATH_MODES = ['explode', 'flag'] as const;

export type CombatDeathMode = (typeof COMBAT_DEATH_MODES)[number];

export const DEFAULT_COMBAT_SEED = 1;
export const DEFAULT_COMBAT_DEATH: CombatDeathMode = 'explode';
export const MAX_COMBAT_SEED = 2 ** 32 - 1;

export interface SceneCombat {
  /**
   * An integer 0 … 2³² − 1; omitted: DEFAULT_COMBAT_SEED.
   */
  readonly seed?: number;
  /**
   * Omitted: DEFAULT_COMBAT_DEATH.
   */
  readonly death?: CombatDeathMode;
}

/**
 * The combat settings with the defaults applied.
 */
export interface ResolvedSceneCombat {
  readonly seed: number;
  readonly death: CombatDeathMode;
}

const COMBAT_KEYS = new Set<string>(['seed', 'death']);

export interface NormalizedSceneCombat {
  /**
   * Null when absent or empty (the document omits it).
   */
  readonly combat: Maybe<SceneCombat>;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * Validates a document's `combat`: `seed` an integer in [0, 2³² − 1], `death` one of COMBAT_DEATH_MODES; null is
 * absent, unknown keys warn and are dropped, and an empty object is omitted.
 *
 * @param input - The candidate value.
 * @param where - Where it sits, for messages.
 * @returns The combat settings (or null), problems and warnings.
 */
export function normalizeSceneCombat(input: unknown, where = 'combat'): NormalizedSceneCombat {
  const problems: string[] = [];
  const warnings: string[] = [];
  let combat: Maybe<SceneCombat> = null;
  if (input != null) {
    if (!isPlainObject(input)) {
      problems.push(`${where} must be an object { seed?, death? }`);
    } else {
      for (const key of Object.keys(input)) if (!COMBAT_KEYS.has(key)) warnings.push(`${where}.${key} is not a combat field and was dropped`);
      const { seed, death } = input;
      const result: { seed?: number; death?: CombatDeathMode } = {};
      if (seed != null) {
        if (typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_COMBAT_SEED) result.seed = seed;
        else problems.push(`${where}.seed must be an integer from 0 to ${MAX_COMBAT_SEED}`);
      }
      if (death != null) {
        if (typeof death === 'string' && (COMBAT_DEATH_MODES as readonly string[]).includes(death)) result.death = death as CombatDeathMode;
        else problems.push(`${where}.death must be one of ${COMBAT_DEATH_MODES.join(', ')}`);
      }
      if (Object.keys(result).length) combat = result;
    }
  }
  return { combat, problems, warnings };
}

/**
 * A document's combat settings with the defaults applied.
 *
 * @param scene - The document (or anything with an optional `combat`).
 * @param scene.combat - Its combat settings.
 * @returns The seed and death mode.
 */
export function sceneCombatOf(scene: { readonly combat?: Maybe<SceneCombat> }): ResolvedSceneCombat {
  return { seed: scene.combat?.seed ?? DEFAULT_COMBAT_SEED, death: scene.combat?.death ?? DEFAULT_COMBAT_DEATH };
}

/**
 * The patch operations that edit the document's combat settings.
 */
export const COMBAT_OPERATIONS: ReadonlySet<string> = new Set(['set_combat']);

const SET_COMBAT_KEYS = new Set<string>(['op', 'seed', 'death']);

/**
 * Applies `{ op: "set_combat", seed?: n | null, death?: "explode" | "flag" | null }`: merges into the document's
 * `combat`; null resets a field to its default. An emptied `combat` is removed. The values are checked when the
 * document is normalized.
 *
 * @param operation - The operation.
 * @param context - The draft and where problems and warnings go.
 */
export function applyCombatOperation(operation: JsonObject, context: FleetOperationContext): void {
  const { draft, where, problems, warnings } = context;
  for (const key of Object.keys(operation)) if (!SET_COMBAT_KEYS.has(key)) warnings.push(`${where}.${key} is not a set_combat field and was ignored`);
  if (!('seed' in operation) && !('death' in operation)) {
    problems.push(`${where}: set_combat needs seed (an integer from 0 to ${MAX_COMBAT_SEED}, or null) or death (${COMBAT_DEATH_MODES.join(' or ')}, or null)`);
    return;
  }
  const combat: Record<string, unknown> = isPlainObject(draft['combat']) ? { ...draft['combat'] } : {};
  for (const key of ['seed', 'death'] as const) {
    if (!(key in operation)) continue;
    if (operation[key] === null) delete combat[key];
    else combat[key] = operation[key];
  }
  if (Object.keys(combat).length) draft['combat'] = combat as JsonObject;
  else delete draft['combat'];
}
