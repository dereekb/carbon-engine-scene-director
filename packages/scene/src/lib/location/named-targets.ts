/**
 * Order targets by name: order_ship and order_fleet take an object's name or type, or a celestial's name, where they
 * take a target id. Resolved in the page (synchronously, against the document's objects and the location's
 * `/map/system` answer, both origin-relative), before the order is normalized.
 */

import type { Maybe } from '@dereekb/util';
import { formatSceneDistance, MAX_SCENE_DISTANCE } from '../extent';
import type { SceneObject } from '../objects/object';
import { MAX_ORDER_RANGE } from '../orders';
import type { SceneVector } from '../scene';
import type { CelestialKind } from './location';
import type { LocatedMapCelestial } from './map';
import { matchCelestialName, normalizeMapName } from './names';
import { celestialTargetId } from './targets';

/**
 * The celestial kinds ships only warp to: a warp lands off the surface on the line toward the ship.
 */
export const WARP_ONLY_CELESTIAL_KINDS: readonly CelestialKind[] = ['star', 'planet', 'moon', 'asteroidBelt'];

/**
 * How many candidates an ambiguous name lists.
 */
export const NAMED_TARGET_CANDIDATE_LIMIT = 10;

export type NamedOrderTargetKind = 'object' | CelestialKind;

export interface ResolveNamedOrderTargetInput {
  /**
   * The order's target text, which is not a ship, object or celestial target id.
   */
  readonly text: string;
  /**
   * The order's type: planets, moons, stars and belts take only a warp.
   */
  readonly type: string;
  /**
   * The order's range (metres; absent is 0). A warp to a body lands this far off its surface.
   */
  readonly range?: unknown;
  /**
   * Where the ordered ship is (a fleet order: its FC), scene metres: a warp to a body lands on the line toward it.
   */
  readonly from: SceneVector;
  readonly objects: readonly Pick<SceneObject, 'id' | 'name' | 'type'>[];
  /**
   * The location answer's celestials (origin-relative); empty without a location.
   */
  readonly celestials: readonly LocatedMapCelestial[];
  readonly systemName?: Maybe<string>;
  /**
   * The live celestial target ids (`celestial:<id>`): the stations and gates in the scene extent with a radius.
   */
  readonly targets: ReadonlySet<string>;
  /**
   * Message prefix, default `order`.
   */
  readonly where?: string;
}

/**
 * What a name resolved to: a target id (an object, or a station or gate's `celestial:<id>`), or for a warp to a body a
 * point already `range` off its surface (so the order's range becomes 0).
 */
export interface ResolvedNamedOrderTarget {
  readonly name: string;
  readonly kind: NamedOrderTargetKind;
  readonly target?: string;
  readonly point?: SceneVector;
  readonly range: number;
}

export type NamedOrderTargetResult = Maybe<{ readonly resolved: ResolvedNamedOrderTarget } | { readonly problem: string }>;

/**
 * Resolves an order target given by name. The first rule that matches wins: an object by its exact name
 * (case-insensitive), an object by its type when exactly one has it, then a celestial of the location by
 * matchCelestialName. A station or gate becomes its celestial target, refused when it is not one (beyond the scene
 * extent, or no radius). A planet, moon, star or asteroid belt takes only a warp, to the point `range` off its surface
 * (a belt's centre counts as its surface) on the line toward `from`, refused when that lands beyond MAX_SCENE_DISTANCE.
 *
 * @param input - The text, the order's type and range, where the ship is, and what the scene holds.
 * @returns The resolved target, a problem (ambiguous, refused), or null when nothing has the name.
 */
export function resolveNamedOrderTarget(input: ResolveNamedOrderTargetInput): NamedOrderTargetResult {
  const where = `${input.where ?? 'order'}.target "${input.text}"`;
  const wanted = normalizeMapName(input.text);
  const range = input.range ?? 0;
  const rangeValid = typeof range === 'number' && Number.isFinite(range) && range >= 0 && range <= MAX_ORDER_RANGE;
  const byName = input.objects.filter((object) => object.name != null && normalizeMapName(object.name) === wanted);
  const byType = input.objects.filter((object) => object.type != null && (typeof object.type === 'number' ? String(object.type) === wanted : normalizeMapName(object.type) === wanted));
  const objects = byName.length ? byName : byType;
  const match = objects.length || !wanted ? null : matchCelestialName({ celestials: input.celestials, text: input.text, systemName: input.systemName ?? '' });

  let result: NamedOrderTargetResult = null;
  if (objects.length > 1) result = { problem: `${where} matches ${objects.length} objects: ${List(objects.map((object) => object.id))}; give one's id` };
  else if (objects.length === 1) result = { resolved: { name: objects[0].name ?? String(objects[0].type), kind: 'object', target: objects[0].id, range: rangeValid ? range : 0 } };
  else if (match && 'candidates' in match) result = { problem: `${where} matches ${match.candidates.length} celestials: ${List(match.candidates.map((celestial) => celestial.name))}; give the full name` };
  else if (match) {
    const { celestial } = match;
    const distance = formatSceneDistance(celestial.distance);
    if (!WARP_ONLY_CELESTIAL_KINDS.includes(celestial.kind)) {
      const target = celestialTargetId(celestial.id);
      if (input.targets.has(target)) result = { resolved: { name: celestial.name, kind: celestial.kind, target, range: rangeValid ? range : 0 } };
      else if (celestial.distance > MAX_SCENE_DISTANCE) result = { problem: `${where} is ${celestial.name}, ${distance} from the scene origin: a scene spans at most ${formatSceneDistance(MAX_SCENE_DISTANCE)}, so it is not an order target; set_location there first` };
      else result = { problem: `${where} is ${celestial.name}, which has no radius in the static data, so it is not an order target` };
    } else if (input.type !== 'warp') {
      result = { problem: `${where} is ${celestial.name}, ${KindText(celestial.kind)}: ships only warp to planets, moons, stars and asteroid belts (a warp lands range metres off it), they cannot ${input.type} one` };
    } else if (!rangeValid) {
      result = { problem: `${input.where ?? 'order'}.range must be a number of metres in [0, ${MAX_ORDER_RANGE}]` };
    } else {
      const point = LandingOff({ centre: celestial.position, radius: celestial.kind === 'asteroidBelt' ? 0 : (celestial.radius ?? 0), range, from: input.from });
      const landing = Math.hypot(...point);
      if (landing > MAX_SCENE_DISTANCE) result = { problem: `${where} is ${celestial.name}: a warp to it lands ${formatSceneDistance(landing)} from the scene origin, and a scene spans at most ${formatSceneDistance(MAX_SCENE_DISTANCE)}; set_location there first` };
      else result = { resolved: { name: celestial.name, kind: celestial.kind, point, range: 0 } };
    }
  }
  return result;
}

/**
 * The point `range` off a body's surface on the line from its centre toward `from` (straight up the +Z axis when
 * `from` is its centre), to the centimetre.
 */
function LandingOff(input: { readonly centre: SceneVector; readonly radius: number; readonly range: number; readonly from: SceneVector }): SceneVector {
  const { centre, from } = input;
  const away = [from[0] - centre[0], from[1] - centre[1], from[2] - centre[2]];
  const length = Math.hypot(away[0], away[1], away[2]);
  const unit = length > 0 ? away.map((component) => component / length) : [0, 0, 1];
  const reach = input.radius + input.range;
  return [0, 1, 2].map((axis) => Math.round((centre[axis] + unit[axis] * reach) * 100) / 100) as SceneVector;
}

/**
 * Names, quoted, up to NAMED_TARGET_CANDIDATE_LIMIT.
 */
function List(names: readonly string[]): string {
  const shown = names
    .slice(0, NAMED_TARGET_CANDIDATE_LIMIT)
    .map((name) => JSON.stringify(name))
    .join(', ');
  return names.length > NAMED_TARGET_CANDIDATE_LIMIT ? `${shown}, …` : shown;
}

function KindText(kind: CelestialKind): string {
  return kind === 'asteroidBelt' ? 'an asteroid belt' : `a ${kind}`;
}
