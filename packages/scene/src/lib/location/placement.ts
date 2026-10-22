/**
 * Where a scene's origin goes near a celestial: a range off its surface along a direction (toward the sun by
 * default), or an explicit offset from its centre. Pure float64 math; the hub's set_location tool runs it on
 * tools-core's map data, and the fleet warp-in can run it for "land on a celestial at a range".
 *
 * The default ranges frame a scene; they are not EVE's warp-in points.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import { type CelestialKind, MAX_LOCATION_COORDINATE } from './location';

/**
 * m off a station's surface.
 */
export const DEFAULT_STATION_LOCATION_RANGE = 5000;
/**
 * m off a stargate's surface.
 */
export const DEFAULT_STARGATE_LOCATION_RANGE = 2500;
/**
 * Stars, planets and moons: radii off the surface (one radius: the body spans 60° from the origin).
 */
export const DEFAULT_BODY_LOCATION_RANGE_RADII = 1;

/**
 * From the celestial toward the origin: toward the star ('sun'), away from it ('away'), or a vector in system axes.
 */
export type LocationDirection = 'sun' | 'away' | SceneVector;

export interface LocationPlacementInput {
  readonly kind: CelestialKind;
  /**
   * System metres.
   */
  readonly position: SceneVector;
  /**
   * Metres; null when unknown.
   */
  readonly radius: Maybe<number>;
  /**
   * Metres off the surface (an asteroid belt: off its centre). Default by kind (defaultLocationRange).
   */
  readonly range?: Maybe<number>;
  /**
   * From the celestial toward the origin, system axes. Default 'sun'.
   */
  readonly direction?: Maybe<LocationDirection>;
  /**
   * Metres from the celestial's centre to the origin, instead of range and direction.
   */
  readonly offset?: Maybe<SceneVector>;
  /**
   * For messages, e.g. "Jita IV - Moon 4".
   */
  readonly name?: string;
}

export interface LocationPlacement {
  /**
   * System metres, rounded to the millimetre. Null when there are problems.
   */
  readonly origin: Maybe<SceneVector>;
  /**
   * Metres from the celestial's centre to the origin, rounded to the millimetre. Null when there are problems.
   */
  readonly offset: Maybe<SceneVector>;
  /**
   * Metres off the surface (|offset| minus the standoff radius); negative inside the body.
   */
  readonly range: number;
  /**
   * |offset|.
   */
  readonly distance: number;
  readonly problems: string[];
  readonly warnings: string[];
}

/**
 * The default range off a celestial: stations DEFAULT_STATION_LOCATION_RANGE, stargates
 * DEFAULT_STARGATE_LOCATION_RANGE, stars, planets and moons DEFAULT_BODY_LOCATION_RANGE_RADII radii (0 with no
 * radius), asteroid belts 0 from the belt's centre.
 *
 * @param input - The celestial's kind and radius.
 * @returns Metres off the surface.
 */
export function defaultLocationRange(input: { readonly kind: CelestialKind; readonly radius: Maybe<number> }): number {
  let range = 0;
  if (input.kind === 'station') range = DEFAULT_STATION_LOCATION_RANGE;
  else if (input.kind === 'stargate') range = DEFAULT_STARGATE_LOCATION_RANGE;
  else if (input.kind !== 'asteroidBelt') range = (isPositive(input.radius) ? input.radius : 0) * DEFAULT_BODY_LOCATION_RANGE_RADII;
  return range;
}

/**
 * Places a scene origin off a celestial: `origin = position + direction × (standoff + range)`, or `position + offset`.
 * The standoff is the radius for the solid kinds and 0 for an asteroid belt (its radius is the belt's extent; EVE
 * lands you in it) or an unknown radius.
 *
 * @param input - The celestial, and the range, direction or offset.
 * @returns The origin and offset (rounded to the millimetre), the range and distance, problems and warnings.
 */
export function toLocationPlacement(input: LocationPlacementInput): LocationPlacement {
  const { kind, position, radius, range, direction, offset, name = 'the celestial' } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  const known = isPositive(radius);
  const standoff = kind === 'asteroidBelt' || !known ? 0 : radius;
  if (!known && kind !== 'asteroidBelt') warnings.push(`${name}'s radius is unknown, so range is measured from its centre`);

  let rawOffset: Maybe<SceneVector> = null;
  if (offset != null && (range != null || direction != null)) {
    problems.push('give offset, or range and/or direction, not both');
  } else if (offset == null) {
    const unit = toDirection(direction ?? 'sun', position);
    const reach = range ?? defaultLocationRange({ kind, radius });
    if (!(typeof reach === 'number' && Number.isFinite(reach) && reach >= 0)) problems.push('range must be a finite number of metres, 0 or more');
    if (!unit) problems.push('direction must be "sun", "away" or a non-zero [x, y, z]');
    if (unit && !problems.length) rawOffset = scale(unit, standoff + reach);
  } else if (isFiniteVector(offset)) {
    rawOffset = [offset[0], offset[1], offset[2]];
    if (length(rawOffset) < standoff) warnings.push(`the origin is inside ${name} (radius ${standoff} m)`);
  } else {
    problems.push('offset must be [x, y, z] in metres');
  }

  let origin: Maybe<SceneVector> = null;
  let rounded: Maybe<SceneVector> = null;
  if (rawOffset && !problems.length) {
    rounded = roundVector(rawOffset);
    origin = roundVector([position[0] + rawOffset[0], position[1] + rawOffset[1], position[2] + rawOffset[2]]);
    if (origin.some((component) => Math.abs(component) > MAX_LOCATION_COORDINATE)) {
      problems.push(`the origin would be more than 1e15 m from the star`);
      origin = null;
      rounded = null;
    }
  }
  const distance = rawOffset ? length(rawOffset) : 0;
  return { origin, offset: rounded, range: distance - standoff, distance, problems, warnings };
}

/**
 * The unit direction from the celestial toward the origin; null for a zero or non-finite vector.
 */
function toDirection(direction: LocationDirection, position: SceneVector): Maybe<SceneVector> {
  let unit: Maybe<SceneVector> = null;
  if (direction === 'sun' || direction === 'away') {
    // The star itself (at the system origin): both mean the frame's forward axis.
    const sign = direction === 'sun' ? -1 : 1;
    unit = length(position) < 1 ? [0, 0, 1] : normalize(scale(position, sign));
  } else if (isFiniteVector(direction)) {
    unit = normalize(direction);
  }
  return unit;
}

function isPositive(value: Maybe<number>): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isFiniteVector(value: unknown): value is SceneVector {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === 'number' && Number.isFinite(component));
}

/**
 * |v|, as Math.sqrt of the sum of squares (not Math.hypot), so every caller computes the same last digits.
 */
function length(vector: SceneVector): number {
  return Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
}

function normalize(vector: SceneVector): Maybe<SceneVector> {
  const size = length(vector);
  return size > 0 && Number.isFinite(size) ? scale(vector, 1 / size) : null;
}

function scale(vector: SceneVector, factor: number): SceneVector {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function roundVector(vector: SceneVector): SceneVector {
  return [roundMillimetre(vector[0]), roundMillimetre(vector[1]), roundMillimetre(vector[2])];
}

/**
 * Rounds to the millimetre; `+ 0` turns -0 (a zero range along a negative axis) into 0, so documents read cleanly.
 */
function roundMillimetre(value: number): number {
  return Math.round(value * 1000) / 1000 + 0;
}
