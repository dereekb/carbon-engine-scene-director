/**
 * Where a scene is in New Eden: a solar system and the point in it that the scene's [0, 0, 0] sits on.
 *
 * Map positions are tools-core's map frame: float64 metres with the system's star at [0, 0, 0], Y up, +Z forward,
 * right-handed. A system is at most ~1e14 m across; galactic coordinates (a system's own `position`) are 1e16-1e17 m,
 * so every location coordinate is bounded at MAX_LOCATION_COORDINATE to refuse one passed by mistake.
 */

import type { Maybe } from '@dereekb/util';
import { isPlainObject, readOptionalString, readVector, reportUnknownKeys } from '../json';
import type { SceneVector } from '../scene';

/**
 * The celestial kinds tools-core's map serves, named as it names them.
 */
export const CELESTIAL_KINDS = ['star', 'planet', 'moon', 'asteroidBelt', 'station', 'stargate'] as const;
export type CelestialKind = (typeof CELESTIAL_KINDS)[number];

/**
 * m: the bound on every location coordinate. A system is at most ~1e14 m across, and galactic coordinates are
 * 1e16-1e17 m, so a galactic position passed by mistake is refused.
 */
export const MAX_LOCATION_COORDINATE = 1e15;

export interface SceneLocation {
  /**
   * The solar system's EVE id (mapSolarSystems). Required; names are resolved by the set_location tool.
   */
  system: number;
  /**
   * The system's name, as the EVE data gives it. For people: the id is what counts.
   */
  name?: string;
  /**
   * The region's name. For people.
   */
  region?: string;
  /**
   * Where the scene's [0, 0, 0] sits, in system metres: float64, the star at [0, 0, 0], Y up, +Z forward,
   * right-handed (tools-core's map `frame`). Scene axes are the system's axes: a location only translates.
   */
  origin: SceneVector;
  /**
   * The celestial the origin was placed from. Provenance only: `origin` is authoritative.
   */
  anchor?: SceneLocationAnchor;
}

export interface SceneLocationAnchor {
  /**
   * The celestial's EVE id (a star, planet, moon, asteroid belt, NPC station or stargate).
   */
  celestial: number;
  name?: string;
  kind?: CelestialKind;
  /**
   * Metres from the celestial's centre to the origin, in system axes, as it was set.
   */
  offset?: SceneVector;
}

export interface NormalizeSceneLocationInput {
  readonly input: unknown;
  /**
   * Where it sits, for messages; `location` by default.
   */
  readonly where?: string;
}

export interface NormalizedSceneLocation {
  /**
   * The location in canonical key order; null when absent or when there are problems.
   */
  readonly location: Maybe<SceneLocation>;
  readonly problems: string[];
  readonly warnings: string[];
}

const LOCATION_KEYS = new Set<string>(['system', 'name', 'region', 'origin', 'anchor']);
const ANCHOR_KEYS = new Set<string>(['celestial', 'name', 'kind', 'offset']);

/**
 * Whether a value is one of tools-core's celestial kinds (exact case).
 *
 * @param value - The candidate.
 * @returns Whether it is a CelestialKind.
 */
export function isCelestialKind(value: unknown): value is CelestialKind {
  return typeof value === 'string' && (CELESTIAL_KINDS as readonly string[]).includes(value);
}

/**
 * Validates a scene's location. Null or undefined is absent; unknown keys warn and are dropped; the output is built in
 * a fixed key order (location: system, name, region, origin, anchor; anchor: celestial, name, kind, offset), so equal
 * locations serialize the same whatever the input order.
 *
 * @param config - The candidate and where it sits.
 * @returns The location, or null, with its problems and warnings.
 */
export function normalizeSceneLocation(config: NormalizeSceneLocationInput): NormalizedSceneLocation {
  const { input, where = 'location' } = config;
  const problems: string[] = [];
  const warnings: string[] = [];
  let location: Maybe<SceneLocation> = null;

  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object`);
  } else if (input != null) {
    reportUnknownKeys(input, LOCATION_KEYS, where, warnings);
    const system = readEveId(input['system'], `${where}.system`, problems, 'an EVE solar system id (a positive integer); the set_location tool resolves a system name');
    const name = readOptionalString(input['name'], `${where}.name`, problems);
    const region = readOptionalString(input['region'], `${where}.region`, problems);
    let origin: SceneVector = [0, 0, 0];
    if (input['origin'] == null) problems.push(`${where}.origin is required: the scene origin in system metres (the set_location tool computes it from a celestial)`);
    else origin = readLocationVector(input['origin'], `${where}.origin`, problems);
    const anchor = normalizeAnchor(input['anchor'], `${where}.anchor`, problems, warnings);

    location = { system, ...(name ? { name } : {}), ...(region ? { region } : {}), origin, ...(anchor ? { anchor } : {}) };
  }

  return { location: problems.length ? null : location, problems, warnings };
}

function normalizeAnchor(input: unknown, where: string, problems: string[], warnings: string[]): Maybe<SceneLocationAnchor> {
  let anchor: Maybe<SceneLocationAnchor> = null;
  if (input != null && !isPlainObject(input)) {
    problems.push(`${where} must be an object`);
  } else if (input != null) {
    reportUnknownKeys(input, ANCHOR_KEYS, where, warnings);
    const celestial = readEveId(input['celestial'], `${where}.celestial`, problems, 'an EVE celestial id (a positive integer)');
    const name = readOptionalString(input['name'], `${where}.name`, problems);
    const kind = input['kind'];
    if (kind != null && !isCelestialKind(kind)) problems.push(`${where}.kind must be one of ${CELESTIAL_KINDS.join(', ')}`);
    const offset = input['offset'] == null ? null : readLocationVector(input['offset'], `${where}.offset`, problems);
    anchor = { celestial, ...(name ? { name } : {}), ...(isCelestialKind(kind) ? { kind } : {}), ...(offset ? { offset } : {}) };
  }
  return anchor;
}

/**
 * Reads an EVE id: a positive safe integer.
 */
function readEveId(value: unknown, where: string, problems: string[], expectation: string): number {
  let id = 0;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) id = value;
  else problems.push(`${where} must be ${expectation}`);
  return id;
}

/**
 * Reads a system-metre vector bounded by MAX_LOCATION_COORDINATE.
 */
function readLocationVector(value: unknown, where: string, problems: string[]): SceneVector {
  const before = problems.length;
  const vector = readVector(value, where, problems);
  if (problems.length === before && vector.some((component) => Math.abs(component) > MAX_LOCATION_COORDINATE)) {
    problems.push(`${where} must be within 1e15 m of the star (system metres, not galactic coordinates)`);
  }
  return vector;
}
