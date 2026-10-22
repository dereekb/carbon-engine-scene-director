/**
 * The map data a scene location needs, as the hub hands it over: the `/map/system` answer the page fetches (one
 * system, positions relative to the scene origin, nearest first) and the get_state report built from it. The values
 * come from tools-core's map routes over CCP's static data; nothing here fetches.
 *
 * The hub subtracts the origin in float64, so the page only sees origin-relative metres and float32 holds.
 */

import type { Maybe } from '@dereekb/util';
import type { SceneVector } from '../scene';
import type { CelestialKind, SceneLocation } from './location';

/**
 * What tools-core's map search indexes. Moons and asteroid belts are not searchable by name.
 */
export const MAP_SEARCH_KINDS = ['region', 'constellation', 'system', 'star', 'planet', 'station', 'stargate'] as const;
export type MapSearchKind = (typeof MAP_SEARCH_KINDS)[number];

/**
 * How many celestials get_state's location lists.
 */
export const LOCATION_NEARBY_LIMIT = 10;

export interface MapStarLight {
  readonly color: SceneVector;
  readonly intensity: number;
}

export interface MapStar {
  readonly id: number;
  readonly name: string;
  readonly typeID: Maybe<number>;
  readonly radius: Maybe<number>;
  readonly spectralClass: Maybe<string>;
  readonly temperature: Maybe<number>;
  readonly luminosity: Maybe<number>;
  /**
   * tools-core's derived key light (blackbody colour, luminosity curve).
   */
  readonly light: Maybe<MapStarLight>;
  /**
   * The sun model's res path.
   */
  readonly graphic: Maybe<string>;
}

export interface MapNamedRecord {
  readonly id: number;
  readonly name: string;
}

export interface MapSystem {
  readonly id: number;
  readonly name: string;
  readonly securityStatus: Maybe<number>;
  readonly securityClass: Maybe<string>;
  readonly constellation: Maybe<MapNamedRecord>;
  readonly region: Maybe<MapNamedRecord>;
  /**
   * The region's nebula, an `environment.universe` path.
   */
  readonly nebula: Maybe<string>;
  readonly star: Maybe<MapStar>;
}

export interface MapCelestialGraphics {
  readonly sofDna?: string;
  readonly resFilePath?: string;
  readonly shaderPreset?: string;
  readonly heightMap1?: string;
  readonly heightMap2?: string;
}

export interface MapCelestialOrbit {
  readonly id: number;
  readonly kind: CelestialKind;
}

export interface MapCelestialDestination {
  readonly system: number;
  readonly stargate: number;
}

export interface MapCelestial {
  readonly id: number;
  readonly kind: CelestialKind;
  readonly name: string;
  readonly typeID: Maybe<number>;
  /**
   * Metres: the map row's radius, else the type's SDE radius (stations and stargates); null when neither has one.
   */
  readonly radius: Maybe<number>;
  readonly radiusFrom: Maybe<'map' | 'type'>;
  /**
   * Metres: system coordinates from the hub's MapData; relative to the origin inside a MapSystemAnswer.
   */
  readonly position: SceneVector;
  readonly orbit: Maybe<MapCelestialOrbit>;
  /**
   * Only the keys tools-core gave a value.
   */
  readonly graphics: MapCelestialGraphics;
  /**
   * Stargates: the xyzw rotation that faces the destination system.
   */
  readonly rotation?: [number, number, number, number];
  readonly destination?: MapCelestialDestination;
}

export interface LocatedMapCelestial extends MapCelestial {
  /**
   * Metres from the origin to the celestial's centre.
   */
  readonly distance: number;
}

/**
 * GET /map/system's answer: one system, positions relative to `origin`, nearest first.
 */
export interface MapSystemAnswer {
  readonly system: MapSystem;
  /**
   * The origin the positions are relative to, in system metres.
   */
  readonly origin: SceneVector;
  readonly celestials: LocatedMapCelestial[];
  readonly sdeBuild: string;
}

export interface ToMapSystemAnswerInput {
  readonly system: MapSystem;
  /**
   * System coordinates.
   */
  readonly celestials: readonly MapCelestial[];
  readonly origin: SceneVector;
  readonly sdeBuild: string;
}

/**
 * Re-bases a system's celestials on a scene origin (float64, unrounded) and sorts them nearest first, then by id.
 *
 * @param input - The system, its celestials in system metres, the origin and the SDE build.
 * @returns The answer GET /map/system sends.
 */
export function toMapSystemAnswer(input: ToMapSystemAnswerInput): MapSystemAnswer {
  const { system, origin, sdeBuild } = input;
  const celestials = input.celestials
    .map((celestial): LocatedMapCelestial => {
      const position: SceneVector = [celestial.position[0] - origin[0], celestial.position[1] - origin[1], celestial.position[2] - origin[2]];
      return { ...celestial, position, distance: vectorLength(position) };
    })
    .sort((a, b) => a.distance - b.distance || a.id - b.id);
  return { system, origin: [origin[0], origin[1], origin[2]], celestials, sdeBuild };
}

export type LocationStatus = 'loading' | 'ready' | 'failed';

export interface LocationCelestialReport {
  readonly id: number;
  readonly name: string;
  readonly kind: CelestialKind;
  readonly radius?: number;
  /**
   * Scene metres (relative to the origin), rounded to the metre.
   */
  readonly position: SceneVector;
  /**
   * Metres from the origin to its centre, rounded.
   */
  readonly distance: number;
  /**
   * Metres off its surface (distance − radius), rounded; absent for asteroid belts and unknown radii.
   */
  readonly surfaceDistance?: number;
}

/**
 * The document's anchor, before the system data is in or when the data does not have it.
 */
export interface LocationAnchorReference {
  readonly id: number;
  readonly name?: string;
  readonly kind?: CelestialKind;
  readonly note?: string;
}

export interface LocationStarReport {
  readonly id: number;
  readonly name: string;
  /**
   * Metres from the origin, rounded.
   */
  readonly distance: number;
  /**
   * The unit direction from the origin to the star, 4 decimals.
   */
  readonly direction: SceneVector;
}

export interface LocationSystemReport {
  readonly id: number;
  readonly name?: string;
  readonly region?: string;
  readonly securityStatus?: number;
}

export interface LocationReport {
  readonly system: LocationSystemReport;
  readonly origin: SceneVector;
  readonly status: LocationStatus;
  readonly error?: string;
  /**
   * From the answer when ready (actual distances); the document's id, name and kind before that, or when it is not in
   * the system (`note`).
   */
  readonly anchor?: LocationCelestialReport | LocationAnchorReference;
  /**
   * Where the star is.
   */
  readonly star?: LocationStarReport;
  /**
   * The celestials nearest the origin, nearest first.
   */
  readonly nearby: LocationCelestialReport[];
}

export interface ToLocationReportInput {
  readonly location: SceneLocation;
  /**
   * The /map/system answer for the location's system and origin, once it is in.
   */
  readonly answer: Maybe<MapSystemAnswer>;
  readonly status: LocationStatus;
  readonly error?: Maybe<string>;
  /**
   * How many nearby celestials to list; LOCATION_NEARBY_LIMIT by default.
   */
  readonly limit?: number;
}

/**
 * Get_state's location: the system, the origin, the fetch status, the anchor's actual distance, the star, and the
 * celestials nearest the origin. Metres, rounded to the metre.
 *
 * @param input - The document's location, the answer (when in) and the fetch status.
 * @returns The report.
 */
export function toLocationReport(input: ToLocationReportInput): LocationReport {
  const { location, status, error, limit = LOCATION_NEARBY_LIMIT } = input;
  const answer = status === 'ready' ? input.answer : null;
  const name = answer?.system.name ?? location.name;
  const region = answer?.system.region?.name ?? location.region;
  const securityStatus = answer?.system.securityStatus;
  const system: LocationSystemReport = { id: location.system, ...(name ? { name } : {}), ...(region ? { region } : {}), ...(securityStatus == null ? {} : { securityStatus }) };

  let anchor: Maybe<LocationCelestialReport | LocationAnchorReference> = null;
  if (location.anchor) {
    const { celestial, name: anchorName, kind } = location.anchor;
    const found = answer?.celestials.find((candidate) => candidate.id === celestial);
    if (found) anchor = toCelestialReport(found);
    else anchor = { id: celestial, ...(anchorName ? { name: anchorName } : {}), ...(kind ? { kind } : {}), ...(answer ? { note: `not among ${answer.system.name}'s celestials` } : {}) };
  }

  let star: Maybe<LocationStarReport> = null;
  const sun = answer?.celestials.find((candidate) => candidate.kind === 'star');
  if (sun) {
    const unit = sun.distance > 0 ? sun.position.map((component) => roundTo(component / sun.distance, 4)) : [0, 0, 0];
    star = { id: sun.id, name: sun.name, distance: Math.round(sun.distance), direction: unit as SceneVector };
  }

  return {
    system,
    origin: [location.origin[0], location.origin[1], location.origin[2]],
    status,
    ...(error ? { error } : {}),
    ...(anchor ? { anchor } : {}),
    ...(star ? { star } : {}),
    nearby: (answer?.celestials ?? []).slice(0, Math.max(0, limit)).map(toCelestialReport)
  };
}

function toCelestialReport(celestial: LocatedMapCelestial): LocationCelestialReport {
  const { id, name, kind, radius, position, distance } = celestial;
  const solid = kind !== 'asteroidBelt' && typeof radius === 'number' && radius > 0;
  return {
    id,
    name,
    kind,
    ...(typeof radius === 'number' ? { radius } : {}),
    position: [Math.round(position[0]), Math.round(position[1]), Math.round(position[2])],
    distance: Math.round(distance),
    ...(solid ? { surfaceDistance: Math.round(distance - radius) } : {})
  };
}

function vectorLength(vector: SceneVector): number {
  return Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2]);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
