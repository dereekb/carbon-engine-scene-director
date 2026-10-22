/**
 * Places in a scene, for the hub's scene-building tools (`add_ships`, `stage_engagement`, `add_objects`): the
 * document to build on, one patch_scene for the result, `near` a ship, object or celestial of the scene's location
 * resolved to a scene point, `facing: { celestial }` resolved to a point, and the EVE radii of ships already in the
 * scene. Staging and the objects tools share it.
 */

import type { Maybe } from '@dereekb/util';
import {
  applySceneOperations,
  createEmptyScene,
  DEFAULT_FORMATION_RADIUS,
  defaultLocationRange,
  formatSceneDistance,
  type MapCelestial,
  MAX_SCENE_DISTANCE,
  type NearDirection,
  normalizeScene,
  readNearDirection,
  type SceneDocument,
  SceneError,
  type SceneLocation,
  type SceneVector,
  SHIP_RELATIVE_DIRECTIONS,
  toLocationPlacement,
  toNearShipPoint
} from '@scene-director/scene';
import { MatchCelestialName } from './locations';
import type { MapDataApi } from './map-data';
import type { SavedScenesPage } from './saved-scenes';
import type { ShipDataApi } from './ship-data';
import { ToolError, type ToolArgs } from './tool-call';

export interface ScenePlacesOptions {
  readonly shipData: ShipDataApi;
  readonly mapData: MapDataApi;
  readonly page: SavedScenesPage;
}

/**
 * The document a tool builds on, and whether a tab holds it.
 */
export interface SceneBefore {
  readonly scene: SceneDocument;
  readonly live: boolean;
}

/**
 * What one patch did: the resulting document, the operations' warnings and the rest of the patch result.
 */
export interface SceneApplied {
  readonly scene: Maybe<SceneDocument>;
  readonly warnings: string[];
  readonly rest: Record<string, unknown>;
}

/**
 * A resolved `near`: the lead's place, the heading it implies (a ship's or object's own) and the reference's scene
 * position.
 */
export interface ResolvedPlace {
  readonly position: SceneVector;
  readonly heading: Maybe<number>;
  readonly reference: SceneVector;
}

export class ScenePlaces {
  private readonly shipData: ShipDataApi;
  private readonly mapData: MapDataApi;
  private readonly page: SavedScenesPage;

  constructor({ shipData, mapData, page }: ScenePlacesOptions) {
    this.shipData = shipData;
    this.mapData = mapData;
    this.page = page;
  }

  /**
   * The document to build on: the passed `scene`, else the tab's (empty before any load).
   *
   * @param args - The tool's arguments.
   * @returns The normalized document and whether a tab holds it.
   */
  async Before(args: ToolArgs): Promise<SceneBefore> {
    let before: SceneBefore;
    if (args['scene'] != null) before = { scene: normalizeScene(args['scene']).scene, live: false };
    else if (this.page.Connected()) before = { scene: normalizeScene((await this.page.Call('get_scene')) ?? createEmptyScene()).scene, live: true };
    else throw new ToolError(`${this.page.NotConnected().message} Or pass "scene" to build a document without a tab.`);
    return before;
  }

  /**
   * Applies the operations to the passed scene, or forwards them to the tab as one patch_scene (atomic: any problem
   * fails them all).
   *
   * @param before - The document built on.
   * @param operations - The pure operations.
   * @returns The resulting document, the operations' warnings and the rest of the patch result.
   */
  async Apply(before: SceneBefore, operations: readonly Record<string, unknown>[]): Promise<SceneApplied> {
    let applied: SceneApplied;
    if (!before.live) {
      const { scene, warnings } = applySceneOperations(before.scene, [...operations]);
      applied = { scene, warnings, rest: { scene, loaded: false } };
    } else {
      const patched = (await this.page.Call('patch_scene', { operations })) as Record<string, unknown> & { readonly scene?: SceneDocument; readonly warnings?: string[] };
      applied = { scene: patched.scene ?? null, warnings: patched.warnings ?? [], rest: Without(patched, ['warnings']) };
    }
    return applied;
  }

  /**
   * The EVE radius of each ship, by distinct type or dna; a failed lookup leaves no radius and warns once.
   *
   * @param ids - The ships.
   * @param scene - The document holding them.
   * @returns The radii by ship id, and the warnings.
   */
  async ResolveRadii(ids: readonly string[], scene: SceneDocument): Promise<{ readonly radii: Record<string, number>; readonly warnings: string[] }> {
    const byKey = new Map<string, { readonly type: Maybe<string | number>; readonly dna: string; readonly ids: string[] }>();
    for (const id of ids) {
      const ship = scene.ships.find((candidate) => candidate.id === id);
      if (!ship) continue;
      const key = ship.type == null ? `dna:${ship.dna.toLowerCase()}` : `type:${String(ship.type).toLowerCase()}`;
      const entry = byKey.get(key) ?? { type: ship.type ?? null, dna: ship.dna, ids: [] };
      entry.ids.push(id);
      byKey.set(key, entry);
    }
    const radii: Record<string, number> = {};
    const failed: string[] = [];
    await Promise.all(
      [...byKey.values()].map(async (entry) => {
        const radius = await this.shipData.Hull({ type: entry.type, dna: entry.dna }).then(
          (hull) => hull.published.radius ?? null,
          () => null
        );
        if (radius != null && radius > 0) for (const id of entry.ids) radii[id] = radius;
        else failed.push(String(entry.type ?? entry.dna));
      })
    );
    const warnings = failed.length ? [`no EVE radius for ${failed.sort().join(', ')} through tools-core; those ships' formation slots assume ${DEFAULT_FORMATION_RADIUS} m`] : [];
    return { radii, warnings };
  }

  /**
   * Resolves `near: { ship | object | celestial, range?, direction? }` to the lead's scene position.
   *
   * @param near - The candidate.
   * @param context - The document and the lead's radius.
   * @param context.before - The document.
   * @param context.leadRadius - The lead's EVE radius (0 for an engagement centre).
   * @returns The place.
   */
  async ResolvePlace(near: unknown, context: { readonly before: SceneDocument; readonly leadRadius: number }): Promise<ResolvedPlace> {
    const { before, leadRadius } = context;
    if (!IsRecord(near)) throw new ToolError('near must be an object { ship | object | celestial, range?, direction? }');
    const problems: string[] = [];
    const direction = near['direction'] == null ? null : readNearDirection(near['direction'], 'near.direction', problems);
    const range = near['range'] == null ? null : Number(near['range']);
    if (range != null && !(Number.isFinite(range) && range >= 0)) problems.push('near.range must be a finite number of metres, 0 or more');
    ThrowProblems(problems);

    let place: ResolvedPlace;
    const given = (['ship', 'object', 'celestial'] as const).filter((key) => near[key] != null);
    if (given.length > 1) {
      throw new ToolError('near takes one of ship, object or celestial');
    } else if (near['ship'] != null) {
      const ship = before.ships.find((candidate) => candidate.id === near['ship']);
      if (!ship) throw new ToolError(`near.ship: no ship "${String(near['ship'])}" in the scene`);
      const { radii } = await this.ResolveRadii([ship.id], before);
      const placed = toNearShipPoint({ ship, shipRadius: radii[ship.id] ?? 0, leadRadius, range, direction, locationOrigin: before.location?.origin ?? null, where: 'near' });
      ThrowProblems(placed.problems);
      place = { position: placed.point as SceneVector, heading: placed.heading, reference: ship.position };
    } else if (near['object'] != null) {
      const object = (before.objects ?? []).find((candidate) => candidate.id === near['object']);
      if (!object) throw new ToolError(`near.object: no object "${String(near['object'])}" in the scene`);
      const placed = toNearShipPoint({ ship: object, shipRadius: object.radius ?? 0, leadRadius, range, direction, locationOrigin: before.location?.origin ?? null, where: 'near' });
      ThrowProblems(placed.problems);
      place = { position: placed.point as SceneVector, heading: placed.heading, reference: object.position };
    } else if (near['celestial'] != null) {
      place = await this.PlaceOffCelestial({ celestial: near['celestial'], range, direction, leadRadius, location: before.location ?? null });
    } else {
      throw new ToolError('near needs ship (a ship id), object (an object id) or celestial (a celestial of the scene location, by name or id)');
    }
    return place;
  }

  /**
   * `facing`: `{ celestial }` becomes its scene point; a point, a ship id or an object id passes through.
   *
   * @param facing - The candidate.
   * @param before - The document.
   * @returns The facing for the operation.
   */
  async ResolveFacing(facing: unknown, before: SceneDocument): Promise<unknown> {
    let resolved = facing;
    if (IsRecord(facing)) {
      if (facing['celestial'] == null) throw new ToolError('facing must be [x, y, z], a ship or object id, or { celestial }');
      if (!before.location) throw new ToolError('facing.celestial: the scene has no location; set_location first');
      resolved = ToScene((await this.ResolveCelestial(facing['celestial'], before.location)).position, before.location);
    }
    return resolved;
  }

  private async PlaceOffCelestial(input: { readonly celestial: unknown; readonly range: Maybe<number>; readonly direction: Maybe<NearDirection>; readonly leadRadius: number; readonly location: Maybe<SceneLocation> }): Promise<ResolvedPlace> {
    const { range, direction, leadRadius, location } = input;
    if (!location) throw new ToolError('near.celestial: the scene has no location; set_location first, or give position');
    if (typeof direction === 'string' && (SHIP_RELATIVE_DIRECTIONS as readonly string[]).includes(direction)) throw new ToolError(`near.direction "${direction}" follows a ship's heading; off a celestial use sun, away, origin or [x, y, z]`);
    const celestial = await this.ResolveCelestial(input.celestial, location);
    let toward: Maybe<'sun' | 'away' | SceneVector> = null;
    if (direction === 'origin') toward = [location.origin[0] - celestial.position[0], location.origin[1] - celestial.position[1], location.origin[2] - celestial.position[2]];
    else if (direction != null) toward = direction as 'sun' | 'away' | SceneVector;
    const placement = toLocationPlacement({ kind: celestial.kind, position: celestial.position, radius: celestial.radius, range: (range ?? defaultLocationRange({ kind: celestial.kind, radius: celestial.radius })) + leadRadius, direction: toward, name: celestial.name });
    ThrowProblems(placement.problems);
    const point = ToScene(placement.origin as SceneVector, location);
    const distance = Math.hypot(...point);
    if (distance > MAX_SCENE_DISTANCE) throw new ToolError(`${celestial.name} is ${formatSceneDistance(distance)} from the scene origin, outside the scene's ${formatSceneDistance(MAX_SCENE_DISTANCE)}; set_location there first`);
    return { position: point, heading: null, reference: ToScene(celestial.position, location) };
  }

  /**
   * A celestial of the scene location's system, by name (as set_location matches names in a system) or id.
   *
   * @param reference - The name or id.
   * @param location - The scene's location.
   * @returns The celestial.
   */
  private async ResolveCelestial(reference: unknown, location: SceneLocation): Promise<MapCelestial> {
    const celestials = await this.mapData.SystemCelestials(location.system);
    const systemName = location.name ?? (await this.mapData.System(location.system)).name;
    let celestial: Maybe<MapCelestial> = null;
    if (typeof reference === 'number') {
      celestial = celestials.find((candidate) => candidate.id === reference) ?? null;
      if (!celestial) {
        const found = await this.mapData.Celestial(reference);
        const elsewhere = await this.mapData.System(found.solarSystemID).then(
          (system) => system.name,
          () => `system ${found.solarSystemID}`
        );
        throw new ToolError(`celestial ${reference} (${found.name}) is in ${elsewhere}, not the scene's ${systemName}`);
      }
    } else if (typeof reference === 'string' && reference.trim()) {
      const match = MatchCelestialName({ celestials, text: reference, systemName });
      if (match && 'candidates' in match) throw new ToolError(`"${reference}" matches ${match.candidates.length} celestials in ${systemName}: ${match.candidates.map((candidate) => candidate.name).join('; ')}; use the full name or the id`);
      if (!match) throw new ToolError(`no celestial in ${systemName} matches "${reference}"; get_system lists them`);
      celestial = match.celestial;
    } else {
      throw new ToolError("celestial must be a celestial name or id of the scene location's system");
    }
    return celestial;
  }
}

/**
 * A system point in the scene: origin-relative, rounded to the metre.
 *
 * @param point - System metres.
 * @param location - The scene's location.
 * @returns Scene metres.
 */
export function ToScene(point: SceneVector, location: SceneLocation): SceneVector {
  return [Math.round(point[0] - location.origin[0]) || 0, Math.round(point[1] - location.origin[1]) || 0, Math.round(point[2] - location.origin[2]) || 0];
}

/**
 * Throws the problems as one SceneError, when there are any.
 *
 * @param problems - The problems.
 */
export function ThrowProblems(problems: readonly string[]): void {
  if (problems.length) throw new SceneError([...problems]);
}

export function IsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function Without(object: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}
