/**
 * What a scene location draws around the origin, the way the EVE client dresses a system: the region's nebula, the
 * star (light direction, sun disc, environment template, lens flare), the planets and moons big enough to see, and the
 * NPC stations and stargates near the origin. This file plans it from the hub's `/map/system` answer (origin-relative
 * metres, so float32 holds) and types the get_state report; the page draws the plan.
 *
 * The planet pass draws `EvePlanet`s at 1 / 1e6 scale between clip planes 0.01 and 1e5, so 1e4 m to 1e11 m in world
 * metres. Bodies beyond the knee are pulled in along their direction on a log curve, with the radius scaled to keep
 * their angular size, so the farthest star in a system still lands inside the far plane.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import type { LocatedMapCelestial, MapSystemAnswer } from './map';

/**
 * Metres: the planet pass's far plane in world metres (EvePlanet.scale 1e6 × the pass's far clip 1e5).
 */
export const PLANET_PASS_FAR_DISTANCE = 1e11;
/**
 * Metres: bodies nearer than this keep their true distance; farther ones are pulled in on a log curve.
 */
export const PLANET_PASS_KNEE_DISTANCE = 5e9;
/**
 * Radius / distance: planets and moons below it are not drawn (~3 px at 1920 px across a 45° view; EvePlanet hides
 * anything under 1-2 px anyway).
 */
export const MIN_DRESSED_BODY_SIZE = 5e-4;
/**
 * Radius / distance (SDE radius): stations and stargates below it are not built (~1 px at 1280 px across 45°).
 */
export const MIN_DRESSED_OBJECT_SIZE = 3e-4;
export const MAX_DRESSED_BODIES = 12;
export const MAX_DRESSED_OBJECTS = 8;
/**
 * The sun's core mesh (unitsphere_4k_01a.gr2) has radius 0.5, so its scaling is twice the drawn radius.
 */
export const SUN_MODEL_RADIUS = 0.5;
/**
 * planetsphere.gr2 has radius 1, so a planet's scaling is its drawn radius.
 */
export const BODY_MODEL_RADIUS = 1;
/**
 * The post process (environment template) without a star, or when the star's own is missing.
 */
export const DEFAULT_SUN_TEMPLATE = 'env_sun_yellow_01a';
/**
 * The lens flare without a star, or when the star's own is missing.
 */
export const DEFAULT_LENS_FLARE = 'yellow';

export const LOCATION_DRESSING_PARTS = ['nebula', 'sun', 'planets', 'objects'] as const;
export type LocationDressingPart = (typeof LOCATION_DRESSING_PARTS)[number];
export type LocationDressingParts = Readonly<Record<LocationDressingPart, boolean>>;
export const ALL_LOCATION_DRESSING_PARTS: LocationDressingParts = { nebula: true, sun: true, planets: true, objects: true };

export type DressedBodyKind = 'planet' | 'moon';
export type DressedObjectKind = 'station' | 'stargate';
export type DressedKind = DressedBodyKind | DressedObjectKind;
export const DRESSED_KINDS: readonly DressedKind[] = ['planet', 'moon', 'station', 'stargate'];

/**
 * An xyzw rotation.
 */
export type DressedQuaternion = [number, number, number, number];

export interface DressedSun {
  readonly id: number;
  readonly name: string;
  /**
   * The sun graphic's res path.
   */
  readonly graphic: string;
  /**
   * Environment template names to try in order (the last is DEFAULT_SUN_TEMPLATE).
   */
  readonly templates: readonly string[];
  /**
   * Lens flare names to try in order (the last is DEFAULT_LENS_FLARE).
   */
  readonly flares: readonly string[];
  /**
   * Origin-relative metres, true (the lens flare's curve, for Carbon's distance falloff).
   */
  readonly position: SceneVector;
  readonly distance: number;
  /**
   * True metres.
   */
  readonly radius: number;
  /**
   * Along position at toPlanetPassDistance(distance): the sun ball and the disc.
   */
  readonly drawnPosition: SceneVector;
  readonly drawnRadius: number;
  /**
   * drawnRadius / SUN_MODEL_RADIUS: the sun EvePlanet's scaling and radius.
   */
  readonly scale: number;
  /**
   * False when the origin is inside the star: the light direction only.
   */
  readonly disc: boolean;
}

export interface DressedBody {
  readonly id: number;
  readonly kind: DressedBodyKind;
  readonly name: string;
  /**
   * The planet file: the shader preset (the full template), else the bare res file.
   */
  readonly template: string;
  /**
   * heightMap1, bound where the template carries the client's bake placeholder.
   */
  readonly heightMap: Maybe<string>;
  readonly radius: number;
  readonly distance: number;
  /**
   * radius / distance.
   */
  readonly size: number;
  readonly drawnPosition: SceneVector;
  /**
   * The EvePlanet's scaling and radius (BODY_MODEL_RADIUS is 1).
   */
  readonly drawnRadius: number;
  /**
   * Pulled in toward the origin (beyond PLANET_PASS_KNEE_DISTANCE).
   */
  readonly scaled: boolean;
}

export interface DressedObject {
  readonly id: number;
  readonly kind: DressedObjectKind;
  readonly name: string;
  readonly dna: string;
  /**
   * Origin-relative metres, true.
   */
  readonly position: SceneVector;
  /**
   * Stargates: tools-core's (+Z faces the destination); stations: identity (tools-core serves none).
   */
  readonly rotation: DressedQuaternion;
  /**
   * The SDE radius.
   */
  readonly radius: number;
  readonly distance: number;
  readonly size: number;
}

export interface LocationDressingSkips {
  readonly tooSmall: number;
  readonly inside: number;
  readonly noGraphic: number;
  readonly overCap: number;
  readonly disabled: number;
}

export interface LocationDressingPlan {
  /**
   * `${system}@${origin}|${parts}`: equal plans have equal keys.
   */
  readonly key: string;
  readonly system: number;
  /**
   * The region's nebula; null when the part is off or the system has none.
   */
  readonly nebula: Maybe<string>;
  readonly sun: Maybe<DressedSun>;
  /**
   * Biggest first.
   */
  readonly bodies: readonly DressedBody[];
  /**
   * Biggest first.
   */
  readonly objects: readonly DressedObject[];
  readonly skipped: Readonly<Record<DressedKind, LocationDressingSkips>>;
  /**
   * Metres: the farthest object's distance plus two SDE radii (the camera's back clip covers it); 0 without objects.
   */
  readonly reach: number;
}

export interface SunDressingNames {
  /**
   * The sun graphic's base name (`sun_blue_sun_01a`), null when it is not a sun graphic.
   */
  readonly graphic: Maybe<string>;
  readonly templates: readonly string[];
  readonly flares: readonly string[];
}

/**
 * Where the planet pass draws a body at a distance: the true distance up to PLANET_PASS_KNEE_DISTANCE, then
 * `K · (1 + ln(d / K))`. Continuous with slope 1 at the knee, strictly increasing (depth order holds), never above the
 * true distance, and under 7e10 m for a body across the widest system.
 *
 * @param distance - Metres from the origin.
 * @returns Metres from the origin in the planet pass.
 */
export function toPlanetPassDistance(distance: number): number {
  const knee = PLANET_PASS_KNEE_DISTANCE;
  return distance <= knee ? distance : knee * (1 + Math.log(distance / knee));
}

const SUN_GRAPHIC_PATTERN = /\/(sun_[a-z0-9_]+)\.black$/u;
const SUN_VARIANT_PATTERN = /_0\d[a-z]$/u;
const TRIGLAVIAN_SUN_PATTERN = /^sun_(blue|yellow)_kspace_triglavian_0\d[a-z]$/u;

/**
 * The environment templates and lens flares to try for a sun graphic, in order: `env_<graphic>`, its `_01a` variant,
 * then the default template; the graphic minus `sun_` and its variant (the Triglavian suns have their own), then the
 * default flare.
 *
 * @param graphic - The star's sun graphic res path.
 * @returns The base name and the candidates.
 */
export function toSunDressingNames(graphic: Maybe<string>): SunDressingNames {
  const match = graphic ? SUN_GRAPHIC_PATTERN.exec(graphic.toLowerCase()) : null;
  let names: SunDressingNames = { graphic: null, templates: [DEFAULT_SUN_TEMPLATE], flares: [DEFAULT_LENS_FLARE] };
  if (match) {
    const base = match[1];
    const templates = unique([`env_${base}`, `env_${base.replace(SUN_VARIANT_PATTERN, '_01a')}`, DEFAULT_SUN_TEMPLATE]);
    const triglavian = TRIGLAVIAN_SUN_PATTERN.exec(base);
    let flare = base.replace(/^sun_/u, '').replace(SUN_VARIANT_PATTERN, '');
    if (triglavian) flare = triglavian[1] === 'blue' ? 'sun_kspace_triglavian_01a_fromblue' : 'sun_kspace_triglavian_01b_fromyellow';
    names = { graphic: base, templates, flares: unique([flare, DEFAULT_LENS_FLARE]) };
  }
  return names;
}

export interface ToLocationDressingPlanInput {
  /**
   * The location's /map/system answer (origin-relative).
   */
  readonly answer: MapSystemAnswer;
  readonly parts?: LocationDressingParts;
}

/**
 * Plans what a location draws: the nebula, the sun, the planets and moons big enough to see from the origin (pulled
 * into the planet pass when far), and the stations and stargates big enough to see. Asteroid belts are never dressed.
 *
 * @param input - The answer and the parts to dress.
 * @returns The plan.
 */
export function toLocationDressingPlan(input: ToLocationDressingPlanInput): LocationDressingPlan {
  const { answer, parts = ALL_LOCATION_DRESSING_PARTS } = input;
  const skips: Record<DressedKind, MutableSkips> = { planet: emptySkips(), moon: emptySkips(), station: emptySkips(), stargate: emptySkips() };
  const bodyCandidates: DressedBody[] = [];
  const objectCandidates: DressedObject[] = [];

  for (const celestial of answer.celestials) {
    const kind = celestial.kind;
    if (kind === 'planet' || kind === 'moon') {
      if (parts.planets) {
        const body = toDressedBody(celestial, kind, skips[kind]);
        if (body) bodyCandidates.push(body);
      } else skips[kind].disabled += 1;
    } else if (kind === 'station' || kind === 'stargate') {
      if (parts.objects) {
        const object = toDressedObject(celestial, kind, skips[kind]);
        if (object) objectCandidates.push(object);
      } else skips[kind].disabled += 1;
    }
  }

  const bodies = keepBiggest(bodyCandidates, MAX_DRESSED_BODIES, skips);
  const objects = keepBiggest(objectCandidates, MAX_DRESSED_OBJECTS, skips);
  const reach = objects.reduce((max, object) => Math.max(max, object.distance + 2 * object.radius), 0);
  const partsKey = LOCATION_DRESSING_PARTS.filter((part) => parts[part]).join(',') || 'none';

  return {
    key: `${answer.system.id}@${answer.origin.join(',')}|${partsKey}`,
    system: answer.system.id,
    nebula: parts.nebula ? (answer.system.nebula ?? null) : null,
    sun: parts.sun ? toDressedSun(answer) : null,
    bodies,
    objects,
    skipped: skips,
    reach
  };
}

type MutableSkips = { -readonly [K in keyof LocationDressingSkips]: number };

function emptySkips(): MutableSkips {
  return { tooSmall: 0, inside: 0, noGraphic: 0, overCap: 0, disabled: 0 };
}

function toDressedSun(answer: MapSystemAnswer): Maybe<DressedSun> {
  const celestial = answer.celestials.find((candidate) => candidate.kind === 'star');
  const star = answer.system.star;
  const graphic = star?.graphic ?? celestial?.graphics.resFilePath;
  const radius = star?.radius ?? celestial?.radius ?? 0;
  let sun: Maybe<DressedSun> = null;
  if (celestial && graphic && celestial.distance > 0) {
    const { distance, position } = celestial;
    const factor = toPlanetPassDistance(distance) / distance;
    const drawnRadius = radius * factor;
    const names = toSunDressingNames(graphic);
    sun = {
      id: celestial.id,
      name: star?.name ?? celestial.name,
      graphic,
      templates: names.templates,
      flares: names.flares,
      position: [position[0], position[1], position[2]],
      distance,
      radius,
      drawnPosition: scaleVector(position, factor),
      drawnRadius,
      scale: drawnRadius / SUN_MODEL_RADIUS,
      disc: distance > radius
    };
  }
  return sun;
}

function toDressedBody(celestial: LocatedMapCelestial, kind: DressedBodyKind, skips: MutableSkips): Maybe<DressedBody> {
  const { radius, distance, graphics } = celestial;
  const template = graphics.shaderPreset ?? graphics.resFilePath;
  let body: Maybe<DressedBody> = null;
  if (!template || typeof radius !== 'number' || radius <= 0) skips.noGraphic += 1;
  else if (distance <= radius) skips.inside += 1;
  else if (radius / distance < MIN_DRESSED_BODY_SIZE) skips.tooSmall += 1;
  else {
    const factor = toPlanetPassDistance(distance) / distance;
    body = {
      id: celestial.id,
      kind,
      name: celestial.name,
      template,
      heightMap: graphics.heightMap1 ?? null,
      radius,
      distance,
      size: radius / distance,
      drawnPosition: scaleVector(celestial.position, factor),
      drawnRadius: (radius * factor) / BODY_MODEL_RADIUS,
      scaled: distance > PLANET_PASS_KNEE_DISTANCE
    };
  }
  return body;
}

function toDressedObject(celestial: LocatedMapCelestial, kind: DressedObjectKind, skips: MutableSkips): Maybe<DressedObject> {
  const { distance, graphics, position } = celestial;
  const radius = typeof celestial.radius === 'number' && celestial.radius > 0 ? celestial.radius : 0;
  const size = distance > 0 ? radius / distance : radius > 0 ? Infinity : 0;
  let object: Maybe<DressedObject> = null;
  if (!graphics.sofDna) skips.noGraphic += 1;
  else if (size < MIN_DRESSED_OBJECT_SIZE) skips.tooSmall += 1;
  else {
    const rotation: DressedQuaternion = kind === 'stargate' && celestial.rotation ? [celestial.rotation[0], celestial.rotation[1], celestial.rotation[2], celestial.rotation[3]] : [0, 0, 0, 1];
    object = { id: celestial.id, kind, name: celestial.name, dna: graphics.sofDna, position: [position[0], position[1], position[2]], rotation, radius, distance, size };
  }
  return object;
}

function keepBiggest<T extends { readonly id: number; readonly kind: DressedKind; readonly size: number }>(candidates: T[], cap: number, skips: Record<DressedKind, MutableSkips>): T[] {
  const sorted = candidates.sort((a, b) => b.size - a.size || a.id - b.id);
  for (const dropped of sorted.slice(cap)) skips[dropped.kind].overCap += 1;
  return sorted.slice(0, cap);
}

function scaleVector(vector: SceneVector, factor: number): SceneVector {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * planned: nothing to load (the nebula without a renderer). validated: loaded as values without a renderer.
 */
export type DressedState = 'planned' | 'loading' | 'drawn' | 'validated' | 'failed';

export interface LocationDressingCounts {
  readonly drawn: number;
  readonly validated: number;
  readonly loading: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface LocationDressingObjectReport {
  readonly id: number;
  readonly kind: DressedKind;
  readonly name: string;
  readonly state: DressedState;
  /**
   * Metres, rounded.
   */
  readonly distance: number;
  readonly radius: number;
  /**
   * Planets and moons: the radius drawn in the planet pass.
   */
  readonly drawnRadius?: number;
  readonly scaled?: true;
  /**
   * Stations and stargates: the SOF bounding sphere.
   */
  readonly sofRadius?: number;
  readonly error?: string;
}

export interface LocationDressingNebulaReport {
  readonly path: string;
  readonly state: DressedState;
  readonly error?: string;
}

export interface LocationDressingSunReport {
  readonly id: number;
  readonly name: string;
  readonly graphic: string;
  readonly template?: string;
  readonly flare?: string;
  readonly distance: number;
  readonly drawnDistance: number;
  readonly state: DressedState;
  readonly error?: string;
}

export interface LocationDressingReport {
  /**
   * loading: an answer or a load is in flight. ready: everything planned is drawn (validated without a renderer).
   * partial: something failed. failed: the location could not be read. off: ?dress=off.
   */
  readonly state: 'loading' | 'ready' | 'partial' | 'failed' | 'off';
  readonly error?: string;
  readonly notes?: readonly string[];
  readonly parts: LocationDressingParts;
  readonly nebula?: LocationDressingNebulaReport;
  readonly sun?: LocationDressingSunReport;
  readonly counts: Readonly<Record<DressedKind, LocationDressingCounts>>;
  /**
   * The dressed planets, moons, stations and stargates in plan order (the sun is reported on its own).
   */
  readonly objects: readonly LocationDressingObjectReport[];
}
