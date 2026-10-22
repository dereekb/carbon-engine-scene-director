/**
 * Where staged ships go: the heading frame (yaw only, as fleets use it), headings toward a point, and a point at a
 * range off a ship. Pure; the hub uses the same helpers for points off a celestial.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';

/**
 * Every `near.direction` keyword. The ship-relative ones follow the reference ship's own heading.
 */
export const NEAR_DIRECTIONS = ['ahead', 'behind', 'left', 'right', 'above', 'below', 'sun', 'away', 'origin'] as const;

/**
 * The directions that only mean something off a ship (they follow its heading).
 */
export const SHIP_RELATIVE_DIRECTIONS = ['ahead', 'behind', 'left', 'right', 'above', 'below'] as const;

export type NearDirectionKeyword = (typeof NEAR_DIRECTIONS)[number];

/**
 * A `near.direction`: a keyword, or a vector from the reference toward the lead.
 */
export type NearDirection = NearDirectionKeyword | SceneVector;

/**
 * Metres off a ship's surface a staged lead sits by default.
 */
export const DEFAULT_NEAR_SHIP_RANGE = 5000;

/**
 * The heading frame: forward and right for a yaw; up is +Y.
 */
export interface HeadingVectors {
  readonly forward: SceneVector;
  readonly right: SceneVector;
}

/**
 * Reads a `near.direction`: a keyword (case-insensitive) or three finite numbers.
 *
 * @param value - The candidate.
 * @param where - Where it sits, for messages.
 * @param problems - Receives the problem when it is neither.
 * @returns The direction, or null on a problem.
 */
export function readNearDirection(value: unknown, where: string, problems: string[]): Maybe<NearDirection> {
  let direction: Maybe<NearDirection> = null;
  const keyword = typeof value === 'string' ? value.trim().toLowerCase() : null;
  if (keyword != null && (NEAR_DIRECTIONS as readonly string[]).includes(keyword)) direction = keyword as NearDirectionKeyword;
  else if (Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component))) direction = [value[0], value[1], value[2]];
  else problems.push(`${where} must be one of ${NEAR_DIRECTIONS.join(', ')} or [x, y, z]`);
  return direction;
}

/**
 * The heading frame of a yaw: forward `(sin ψ, 0, cos ψ)` and right `(cos ψ, 0, −sin ψ)`, as fleets/formation.ts uses.
 *
 * @param heading - Yaw degrees: 0 faces +Z, 90 faces +X.
 * @returns Forward and right.
 */
export function headingVectors(heading: number): HeadingVectors {
  const yaw = (heading * Math.PI) / 180;
  return { forward: [Math.sin(yaw), 0, Math.cos(yaw)], right: [Math.cos(yaw), 0, -Math.sin(yaw)] };
}

/**
 * A heading in (−180, 180], rounded to 0.001 degrees.
 *
 * @param heading - Yaw degrees.
 * @returns The normalized yaw.
 */
export function normalizeHeading(heading: number): number {
  let yaw = ((heading % 360) + 360) % 360;
  if (yaw > 180) yaw -= 360;
  yaw = Math.round(yaw * 1000) / 1000;
  return yaw === -180 ? 180 : yaw || 0;
}

/**
 * The yaw that faces from one point toward another.
 *
 * @param from - Where the ship is.
 * @param to - What it faces.
 * @returns The normalized yaw, or null when the target is straight above or below (or the same point).
 */
export function headingToward(from: SceneVector, to: SceneVector): Maybe<number> {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  return Math.hypot(dx, dz) < 1e-9 ? null : normalizeHeading((Math.atan2(dx, dz) * 180) / Math.PI);
}

/**
 * The yaw across the line from one point to another (headingToward plus 90), so two sides facing along it stand
 * beside the first point.
 *
 * @param from - The reference (a ship or a celestial).
 * @param to - The centre.
 * @returns The normalized yaw; 0 when the centre is straight above or below the reference.
 */
export function tangentHeading(from: SceneVector, to: SceneVector): number {
  const toward = headingToward(from, to);
  return toward == null ? 0 : normalizeHeading(toward + 90);
}

export interface NearShipInput {
  /**
   * The reference ship's document placement.
   */
  readonly ship: { readonly position: SceneVector; readonly rotation: SceneVector };
  /**
   * The reference ship's EVE radius; 0 when unknown (the range is then from its centre).
   */
  readonly shipRadius: number;
  /**
   * The lead's EVE radius; 0 when unknown (an engagement centre uses 0).
   */
  readonly leadRadius: number;
  /**
   * Metres, surface to surface. Default DEFAULT_NEAR_SHIP_RANGE.
   */
  readonly range?: Maybe<number>;
  /**
   * Default `ahead`.
   */
  readonly direction?: Maybe<NearDirection>;
  /**
   * The scene location's origin (system metres), for `sun` and `away`: the star is at its negation.
   */
  readonly locationOrigin?: Maybe<SceneVector>;
  /**
   * Where `near` sits, for messages.
   */
  readonly where: string;
}

export interface NearShipPoint {
  /**
   * The lead's centre, rounded to the metre; null on a problem.
   */
  readonly point: Maybe<SceneVector>;
  /**
   * The reference ship's yaw, normalized: the default heading for ships staged off it.
   */
  readonly heading: number;
  readonly problems: string[];
}

/**
 * The lead's centre at a range off a ship: `P + direction × (shipRadius + range + leadRadius)`, so the two surfaces
 * are `range` apart. Ship-relative directions follow the ship's document yaw.
 *
 * @param input - The ship, the radii, the range and the direction.
 * @returns The point and the ship's heading, or the problems.
 */
export function toNearShipPoint(input: NearShipInput): NearShipPoint {
  const { ship, shipRadius, leadRadius, range, direction = 'ahead', locationOrigin, where } = input;
  const problems: string[] = [];
  const heading = normalizeHeading(ship.rotation[0]);
  const reach = range ?? DEFAULT_NEAR_SHIP_RANGE;
  if (!(Number.isFinite(reach) && reach >= 0)) problems.push(`${where}.range must be a finite number of metres, 0 or more`);
  const unit = nearUnit({ direction: direction ?? 'ahead', heading, position: ship.position, locationOrigin, where, problems });

  let point: Maybe<SceneVector> = null;
  if (unit && !problems.length) {
    const distance = shipRadius + reach + leadRadius;
    point = roundVector([ship.position[0] + unit[0] * distance, ship.position[1] + unit[1] * distance, ship.position[2] + unit[2] * distance]);
  }
  return { point, heading, problems };
}

interface NearUnitInput {
  readonly direction: NearDirection;
  readonly heading: number;
  readonly position: SceneVector;
  readonly locationOrigin: Maybe<SceneVector> | undefined;
  readonly where: string;
  readonly problems: string[];
}

function nearUnit(input: NearUnitInput): Maybe<SceneVector> {
  const { direction, heading, position, locationOrigin, where, problems } = input;
  const { forward, right } = headingVectors(heading);
  let unit: Maybe<SceneVector> = null;
  if (Array.isArray(direction)) {
    unit = normalizeVector(direction);
    if (!unit) problems.push(`${where}.direction must not be a zero vector`);
  } else if (direction === 'ahead') unit = forward;
  else if (direction === 'behind') unit = scaleVector(forward, -1);
  else if (direction === 'right') unit = right;
  else if (direction === 'left') unit = scaleVector(right, -1);
  else if (direction === 'above') unit = [0, 1, 0];
  else if (direction === 'below') unit = [0, -1, 0];
  else if (direction === 'origin') {
    unit = normalizeVector(scaleVector(position, -1));
    if (!unit) problems.push(`${where}.direction "origin": the ship is at the scene origin; give another direction`);
  } else if (!locationOrigin) {
    problems.push(`${where}.direction "${direction}" needs the scene's location (set_location) to know where the star is`);
  } else {
    const star: SceneVector = scaleVector(locationOrigin, -1);
    const toward = normalizeVector([star[0] - position[0], star[1] - position[1], star[2] - position[2]]);
    if (!toward) problems.push(`${where}.direction "${direction}": the ship is at the star; give another direction`);
    else unit = direction === 'sun' ? toward : scaleVector(toward, -1);
  }
  return unit;
}

/**
 * A unit vector, or null for a zero or non-finite one.
 *
 * @param vector - The vector.
 * @returns The unit vector, or null.
 */
export function normalizeVector(vector: SceneVector): Maybe<SceneVector> {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return Number.isFinite(length) && length > 1e-9 ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}

function scaleVector(vector: SceneVector, factor: number): SceneVector {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

/**
 * A point rounded to the metre, without negative zeros.
 *
 * @param vector - The point.
 * @returns The rounded point.
 */
export function roundVector(vector: SceneVector): SceneVector {
  return [Math.round(vector[0]) || 0, Math.round(vector[1]) || 0, Math.round(vector[2]) || 0];
}
