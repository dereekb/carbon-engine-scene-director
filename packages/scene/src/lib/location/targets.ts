import type { Maybe } from '@dereekb/util';
import { MAX_SCENE_DISTANCE } from '../extent';
import type { SceneVector } from '../scene';
import type { CelestialKind } from './location';
import type { MapSystemAnswer } from './map';

/**
 * Celestial targets are named `celestial:<itemID>`. ":" is not in ID_PATTERN, so they never collide with a ship or
 * object id.
 */
export const CELESTIAL_TARGET_PREFIX = 'celestial:';

/**
 * The celestial kinds that become order targets: the ones ships fly to in EVE.
 */
export const CELESTIAL_TARGET_KINDS: readonly CelestialKind[] = ['station', 'stargate'];

/**
 * A station or stargate of the scene's location that ships can approach, keep at range on, orbit or warp to: the page
 * gives it a static Destiny ball, as it does a document object.
 */
export interface CelestialTarget {
  /**
   * `celestial:<id>`: what order_ship takes.
   */
  readonly target: string;
  readonly id: number;
  readonly kind: CelestialKind;
  readonly name: string;
  /**
   * Origin-relative scene metres.
   */
  readonly position: SceneVector;
  /**
   * The SDE radius, metres: the ball's radius.
   */
  readonly radius: number;
  /**
   * Metres from the scene origin to its centre.
   */
  readonly distance: number;
}

/**
 * One row of `get_state.location.targets`.
 */
export interface LocationTargetReport {
  readonly target: string;
  readonly id: number;
  readonly name: string;
  readonly kind: CelestialKind;
  readonly radius: number;
  readonly distance: number;
  /**
   * Metres from the scene origin to its surface (its radius off the centre distance).
   */
  readonly surfaceDistance: number;
}

/**
 * The order-target id of a celestial.
 *
 * @param id - The celestial's item id.
 * @returns `celestial:<id>`.
 */
export function celestialTargetId(id: number): string {
  return `${CELESTIAL_TARGET_PREFIX}${id}`;
}

/**
 * The celestial item id a target names.
 *
 * @param text - A target.
 * @returns The id, or null when it is not `celestial:<positive integer>`.
 */
export function readCelestialTargetId(text: string): Maybe<number> {
  const id = text.startsWith(CELESTIAL_TARGET_PREFIX) ? Number(text.slice(CELESTIAL_TARGET_PREFIX.length)) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The location's stations and stargates within the scene extent that have a radius, nearest first.
 *
 * @param answer - The location's `/map/system` answer (origin-relative).
 * @returns The targets.
 */
export function toCelestialTargets(answer: Pick<MapSystemAnswer, 'celestials'>): CelestialTarget[] {
  return answer.celestials
    .filter((celestial) => CELESTIAL_TARGET_KINDS.includes(celestial.kind) && (celestial.radius ?? 0) > 0 && celestial.distance <= MAX_SCENE_DISTANCE)
    .map((celestial) => ({ target: celestialTargetId(celestial.id), id: celestial.id, kind: celestial.kind, name: celestial.name, position: [...celestial.position] as SceneVector, radius: celestial.radius ?? 0, distance: celestial.distance }))
    .sort((a, b) => a.distance - b.distance || a.id - b.id);
}

/**
 * The get_state rows of the celestial targets, distances rounded to the metre.
 *
 * @param targets - The targets.
 * @returns The rows, in the targets' order.
 */
export function toLocationTargetReports(targets: readonly CelestialTarget[]): LocationTargetReport[] {
  return targets.map((target) => ({
    target: target.target,
    id: target.id,
    name: target.name,
    kind: target.kind,
    radius: Math.round(target.radius),
    distance: Math.round(target.distance),
    surfaceDistance: Math.round(target.distance - target.radius)
  }));
}
