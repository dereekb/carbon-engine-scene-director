/**
 * The `ship_stats` hub tool and the `GET /ship-stats` route: a hull's published flight
 * values from tools-core's SDE, and the numbers it flies by with a pilot (every skill at
 * V unless told otherwise), optionally with a prop mod running. The math is the shared,
 * runtime-free `computeShipStats`, so the page computes the same numbers.
 */

import type { Maybe } from '@dereekb/util';
import { computeShipStats, createPilotContext, findHullSizedPropMod, HULL_STAT_OVERRIDE_KEYS, type HullStatOverrides, MAX_SKILLS_PILOT, normalizeHullStatOverrides, type PilotContext, type PilotContextConfig, type PropModKind, type PropModStats, readPropModKind, SceneError, type ShipStats } from '@scene-director/scene';
import { type ResolvedHull, ShipDataError, type ShipDataApi } from './ship-data';
import { ErrorMessage, ToolError, type ToolArgs } from './tool-call';

const DNA_PATTERN = /^[^:\s]+:[^:\s]+:[^:\s]+(:\S+)*$/u;
const TYPE_ID_TEXT = /^\d+$/u;

export interface ShipStatsAnswer {
  readonly hull: {
    readonly typeID?: number;
    readonly name?: string;
    readonly group?: Maybe<string>;
    readonly dna?: Maybe<string>;
    /**
     * How the EVE type was picked: an explicit type, the DNA, or none (all four stats given).
     */
    readonly resolvedFrom: 'type' | 'dna' | 'stats';
    readonly candidates: readonly { readonly typeID: number }[];
    readonly sdeBuild?: string;
    readonly published?: ResolvedHull['published'];
    readonly overrides?: HullStatOverrides;
    /**
     * Why the published values are missing although a hull was named.
     */
    readonly note?: string;
  };
  readonly pilot: string;
  readonly propMod: Maybe<PropModStats>;
  /**
   * As flown by the pilot, with no prop mod running.
   */
  readonly stats: ShipStats;
  /**
   * As flown by the pilot with the prop mod running.
   */
  readonly withPropMod?: ShipStats;
}

/**
 * A prop mod argument: a kind sized for the hull, a module type id, or explicit values.
 */
type PropModArgument = { readonly kind: PropModKind } | { readonly typeID: number } | { readonly stats: PropModStats };

interface ShipStatsArguments {
  readonly dna: Maybe<string>;
  readonly type: Maybe<number | string>;
  readonly propMod: Maybe<PropModArgument>;
  readonly overrides: Maybe<HullStatOverrides>;
  readonly pilot: PilotContext;
}

/**
 * Answers `ship_stats`.
 *
 * @param shipData - The SDE lookups.
 * @param args - Dna, type, propMod, stats and pilot.
 * @returns The hull, the pilot, the prop mod and the stats with and without it.
 * @throws {SceneError} When the arguments are invalid.
 * @throws {ShipDataError} When the hull or the prop mod cannot be resolved.
 */
export async function AnswerShipStats(shipData: ShipDataApi, args: ToolArgs): Promise<ShipStatsAnswer> {
  const { dna, type, propMod: propModArgument, overrides, pilot } = ReadShipStatsArguments(args);
  const complete = HULL_STAT_OVERRIDE_KEYS.every((key) => overrides?.[key] != null);

  let hull: Maybe<ResolvedHull> = null;
  let note: Maybe<string> = null;
  if (dna || type != null) {
    try {
      hull = await shipData.Hull({ dna, type });
    } catch (error) {
      if (!(complete && error instanceof ShipDataError && error.failure === 'unavailable')) throw error;
      note = `${error.message} The four stats were used instead.`;
    }
  }

  let propMod: Maybe<PropModStats> = null;
  if (propModArgument && 'stats' in propModArgument) {
    propMod = propModArgument.stats;
  } else if (propModArgument) {
    const sized = 'kind' in propModArgument ? findHullSizedPropMod({ rigSize: hull?.published.rigSize, kind: propModArgument.kind }) : null;
    const typeID = 'typeID' in propModArgument ? propModArgument.typeID : sized?.typeID;
    if (typeID == null) throw new ToolError("the hull's size is unknown; pass a module type id or explicit prop mod values");
    propMod = await shipData.PropMod(typeID);
  }

  const compute = (running: Maybe<PropModStats>): ShipStats => {
    try {
      return computeShipStats({ hull: hull?.published ?? null, overrides, pilot, propMod: running });
    } catch (error) {
      throw new ToolError(ErrorMessage(error));
    }
  };

  return {
    hull: hull
      ? { typeID: hull.typeID, name: hull.name, group: hull.group, dna: hull.dna, resolvedFrom: hull.resolvedFrom, candidates: hull.candidates, sdeBuild: hull.sdeBuild, published: hull.published, ...(overrides ? { overrides } : {}) }
      : { resolvedFrom: 'stats', candidates: [], ...(overrides ? { overrides } : {}), ...(note ? { note } : {}) },
    pilot: pilot.name,
    propMod,
    stats: compute(null),
    ...(propMod ? { withPropMod: compute(propMod) } : {})
  };
}

function ReadShipStatsArguments(args: ToolArgs): ShipStatsArguments {
  const problems: string[] = [];

  const dnaValue = args['dna'];
  let dna: Maybe<string> = null;
  if (typeof dnaValue === 'string' && DNA_PATTERN.test(dnaValue.trim())) dna = dnaValue.trim();
  else if (dnaValue != null) problems.push('dna must be a SOF DNA string, hull:faction:race[:commands]');

  const typeValue = args['type'];
  let type: Maybe<number | string> = null;
  if (typeof typeValue === 'number' && Number.isSafeInteger(typeValue) && typeValue > 0) type = typeValue;
  else if (typeof typeValue === 'string' && TYPE_ID_TEXT.test(typeValue.trim()) && Number(typeValue) > 0) type = Number(typeValue);
  else if (typeof typeValue === 'string' && typeValue.trim()) type = typeValue.trim();
  else if (typeValue != null) problems.push('type must be a positive integer type id or an EVE type name');

  const propMod = ReadPropModArgument(args['propMod'], problems);

  const stats = normalizeHullStatOverrides({ input: args['stats'], where: 'stats' });
  problems.push(...stats.problems);
  const complete = HULL_STAT_OVERRIDE_KEYS.every((key) => stats.overrides?.[key] != null);
  if (!dna && type == null && !complete) problems.push('name the hull by dna or type, or give all four stats (mass, maxVelocity, agility, signatureRadius)');

  const pilot = ReadPilot(args['pilot'], problems);

  if (problems.length) throw new SceneError(problems);
  return { dna, type, propMod, overrides: stats.overrides, pilot };
}

function ReadPropModArgument(value: unknown, problems: string[]): Maybe<PropModArgument> {
  const kind = readPropModKind(value);
  let propMod: Maybe<PropModArgument> = null;
  if (kind) {
    propMod = { kind };
  } else if ((typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && TYPE_ID_TEXT.test(value.trim()) && Number(value) > 0)) {
    propMod = { typeID: Number(value) };
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Readonly<Record<string, unknown>>;
    const numbers = ['speedFactor', 'speedBoostFactor', 'massAddition', 'signatureRadiusBonus'].map((key) => {
      const field = object[key] ?? (key === 'signatureRadiusBonus' ? 0 : undefined);
      const valid = typeof field === 'number' && Number.isFinite(field) && field >= 0;
      if (!valid) problems.push(`propMod.${key} must be a number of 0 or more`);
      return valid ? field : 0;
    });
    const explicitKind = object['kind'] == null ? null : readPropModKind(object['kind']);
    if (object['kind'] != null && !explicitKind) problems.push('propMod.kind must be "mwd" or "ab"');
    const [speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus] = numbers;
    const name = typeof object['name'] === 'string' ? object['name'] : null;
    propMod = { stats: { kind: explicitKind ?? (signatureRadiusBonus > 0 ? 'microwarpdrive' : 'afterburner'), speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus, name } };
  } else if (value != null) {
    problems.push('propMod must be "mwd", "ab", a module type id, or { speedFactor, speedBoostFactor, massAddition, signatureRadiusBonus? }');
  }
  return propMod;
}

function ReadPilot(value: unknown, problems: string[]): PilotContext {
  let pilot: PilotContext = MAX_SKILLS_PILOT;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Readonly<Record<string, unknown>>;
    try {
      pilot = createPilotContext({
        name: typeof object['name'] === 'string' ? object['name'] : 'custom',
        skills: (object['skills'] ?? undefined) as PilotContextConfig['skills'],
        defaultLevel: (object['defaultLevel'] ?? undefined) as number | undefined
      });
    } catch (error) {
      problems.push(`pilot: ${ErrorMessage(error)}`);
    }
  } else if (value != null) {
    problems.push('pilot must be an object: { "skills": { "<skill name or type id>": level }, "defaultLevel"? }');
  }
  return pilot;
}
