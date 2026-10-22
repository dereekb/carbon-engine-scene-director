/**
 * The scene-building tools (`add_ships`, `stage_engagement`), answered by the hub. The hub resolves every name first:
 * hull names to SOF DNA and the EVE radius, compositions by name, celestials of the scene's location to scene points,
 * and the EVE radii of the fleet a ship joins. Then it forwards one pure `add_ships` / `stage_engagement` patch
 * operation to the viewer (or applies it to a passed `scene` with no tab), and reports the ids it created.
 */

import type { Maybe } from '@dereekb/util';
import {
  applySceneOperations,
  createEmptyScene,
  DEFAULT_ENGAGEMENT_RANGE,
  DEFAULT_FORMATION_RADIUS,
  defaultLocationRange,
  ENGAGEMENT_TEAMS,
  type FleetComposition,
  type MapCelestial,
  normalizeFleetComposition,
  normalizeHeading,
  normalizeScene,
  type NearDirection,
  readNearDirection,
  type SceneDocument,
  SceneError,
  type SceneFleet,
  type SceneLocation,
  type SceneVector,
  SHIP_RELATIVE_DIRECTIONS,
  type SquadRole,
  tangentHeading,
  toFleetAnchors,
  toIdSlug,
  toLocationPlacement,
  toNearShipPoint,
  toShipListComposition,
  shipLabel,
  type StagingShipLine
} from '@scene-director/scene';
import { type CompositionHullReport, type CompositionPropModReport, type FleetCompositions, requireFleetComposition, resolveCompositionHulls, resolveCompositionPropMods } from './fleet-compositions';
import { MatchCelestialName } from './locations';
import type { MapDataApi } from './map-data';
import type { SavedScenesPage } from './saved-scenes';
import type { ResolvedHull, ShipDataApi } from './ship-data';
import { ErrorMessage, ToolError, type ToolArgs } from './tool-call';

/**
 * The squad role a hull's EVE group defaults to (lower-cased group names); every other group is dps.
 */
export const SQUAD_ROLE_BY_GROUP: Readonly<Record<string, SquadRole>> = {
  logistics: 'logi',
  'logistics frigate': 'logi',
  'force auxiliary': 'logi',
  interdictor: 'tackle',
  'heavy interdiction cruiser': 'tackle',
  interceptor: 'tackle',
  'electronic attack ship': 'ewar',
  'combat recon ship': 'ewar',
  'force recon ship': 'ewar',
  'command ship': 'boost',
  'command destroyer': 'boost',
  carrier: 'support',
  supercarrier: 'support'
};

/**
 * The squad role a hull's EVE group defaults to.
 *
 * @param group - The EVE group name, e.g. "Logistics".
 * @returns The role (dps for an unknown or missing group).
 */
export function DefaultSquadRole(group: Maybe<string>): SquadRole {
  return SQUAD_ROLE_BY_GROUP[(group ?? '').trim().toLowerCase()] ?? 'dps';
}

/**
 * Where one hull line's dna, radius and role came from.
 */
export interface StagingHullReport {
  readonly hull?: string | number;
  readonly typeID?: number;
  readonly name?: string;
  readonly group?: string;
  readonly dna: string;
  readonly radius: number;
  readonly dnaFrom: 'given' | 'sde';
  readonly radiusFrom: 'given' | 'sde' | 'default';
  readonly role?: SquadRole;
}

/**
 * Ship lines with their dna, radius, canonical hull name and role filled.
 */
export interface ResolvedStagingLines {
  readonly lines: Record<string, unknown>[];
  readonly hulls: StagingHullReport[];
  readonly problems: string[];
  readonly warnings: string[];
}

export interface StagingOptions {
  readonly shipData: ShipDataApi;
  readonly mapData: MapDataApi;
  /**
   * Saved and built-in fleet compositions by name.
   */
  readonly compositions: Pick<FleetCompositions, 'get'>;
  readonly page: SavedScenesPage;
}

/**
 * A resolved `near`: the lead's place, the heading it implies (a ship's own) and the reference's scene position.
 */
interface ResolvedPlace {
  readonly position: SceneVector;
  readonly heading: Maybe<number>;
  readonly reference: SceneVector;
}

interface StagingBefore {
  readonly scene: SceneDocument;
  readonly live: boolean;
}

interface Applied {
  readonly scene: Maybe<SceneDocument>;
  readonly warnings: string[];
  readonly rest: Record<string, unknown>;
}

const LINE_FIELDS = ['hull', 'dna', 'radius', 'name', 'role', 'propMod'] as const;

export class Staging {
  private readonly shipData: ShipDataApi;
  private readonly mapData: MapDataApi;
  private readonly compositions: Pick<FleetCompositions, 'get'>;
  private readonly page: SavedScenesPage;

  constructor({ shipData, mapData, compositions, page }: StagingOptions) {
    this.shipData = shipData;
    this.mapData = mapData;
    this.compositions = compositions;
    this.page = page;
  }

  /**
   * Runs one scene-building tool, or returns null for any other name.
   *
   * @param name - The tool name.
   * @param args - Its arguments.
   * @returns The tool's value.
   */
  Call(name: string, args: ToolArgs): Maybe<Promise<unknown>> {
    let result: Maybe<Promise<unknown>> = null;
    if (name === 'add_ships') result = this.AddShips(args);
    else if (name === 'stage_engagement') result = this.StageEngagement(args);
    return result;
  }

  async AddShips(args: ToolArgs): Promise<object> {
    const before = await this.Before(args);
    const fleet = IsRecord(args['fleet']) ? args['fleet'] : null;
    const squad = fleet && IsRecord(fleet['squad']) ? fleet['squad'] : null;
    const isNew = fleet?.['new'] === true;
    const joins = fleet != null && !isNew;
    const roleNeeded = (isNew && squad?.['role'] == null) || (squad != null && !isNew && squad['role'] == null);
    const resolved = await this.ResolveLines([PickLine(args)], { roleNeeded });
    ThrowProblems(resolved.problems);
    const line = resolved.lines[0];

    const operation: Record<string, unknown> = { op: 'add_ships', ...Without(line, ['role']) };
    for (const key of ['count', 'formation', 'spacing', 'team', 'prefix', 'stats', 'propMod']) if (args[key] != null) operation[key] = args[key];
    if (joins) {
      for (const key of ['position', 'near', 'heading', 'facing']) if (args[key] != null) operation[key] = args[key];
    } else {
      const place = args['near'] != null && args['position'] == null ? await this.ResolvePlace(args['near'], { before: before.scene, leadRadius: Number(line['radius'] ?? 0) }) : null;
      if (args['position'] != null) operation['position'] = args['position'];
      else if (place) operation['position'] = place.position;
      if (args['heading'] != null) operation['heading'] = args['heading'];
      else if (args['facing'] != null) operation['facing'] = await this.ResolveFacing(args['facing'], before.scene);
      else if (place?.heading != null) operation['heading'] = place.heading;
      if (args['near'] != null && args['position'] != null) operation['near'] = args['near'];
    }
    if (fleet) operation['fleet'] = FillSquadRole(fleet, { role: (line['role'] as Maybe<SquadRole>) ?? null, isNew });
    const radii = joins && typeof fleet?.['id'] === 'string' ? await this.ResolveRadii(FleetShipIds(before.scene, fleet['id']), before.scene) : null;
    if (radii) operation['radii'] = radii.radii;

    const applied = await this.Apply(before, operation);
    const added = AddedShips(before.scene, applied.scene);
    const first = added[0];
    const template = normalizeFleetComposition({ input: toShipListComposition({ id: toIdSlug(String(args['prefix'] ?? shipLabel(line as unknown as StagingShipLine))), lines: [{ ...(line as unknown as StagingShipLine), count: Number(args['count'] ?? 1) }] }) }).composition;
    return {
      added: {
        ships: added.map((ship) => ship.id),
        lead: first ? { id: first.id, position: first.position, heading: first.rotation[0] } : null,
        ...(fleet ? { fleet: AddedFleetReport({ before: before.scene, after: applied.scene, added: added.map((ship) => ship.id), fleet, isNew }) } : {})
      },
      hull: resolved.hulls[0],
      ...(template ? { template } : {}),
      ...applied.rest,
      warnings: [...resolved.warnings, ...(radii?.warnings ?? []), ...applied.warnings]
    };
  }

  async StageEngagement(args: ToolArgs): Promise<object> {
    const before = await this.Before(args);
    const sides = Array.isArray(args['sides']) ? args['sides'] : null;
    const hulls: (CompositionHullReport | StagingHullReport)[] = [];
    const propMods: CompositionPropModReport[] = [];
    const warnings: string[] = [];
    const resolvedSides = sides ? await Promise.all(sides.map((side, index) => (IsRecord(side) ? this.ResolveSide(side, { index, hulls, propMods, warnings }) : side))) : args['sides'];

    const operation: Record<string, unknown> = { op: 'stage_engagement', sides: resolvedSides };
    for (const key of ['range', 'center', 'heading']) if (args[key] != null) operation[key] = args[key];
    let center: SceneVector = Array.isArray(args['center']) ? (args['center'] as SceneVector) : [0, 0, 0];
    if (args['near'] != null && args['center'] == null) {
      const place = await this.ResolvePlace(args['near'], { before: before.scene, leadRadius: 0 });
      center = place.position;
      operation['center'] = center;
      if (args['heading'] == null) operation['heading'] = tangentHeading(place.reference, center);
    } else if (args['near'] != null) {
      operation['near'] = args['near'];
    }

    const applied = await this.Apply(before, operation);
    const added = AddedShips(before.scene, applied.scene);
    const newFleets = (applied.scene?.fleets ?? []).filter((fleet) => !(before.scene.fleets ?? []).some((old) => old.id === fleet.id));
    const teams = (sides ?? []).map((side, index) => (IsRecord(side) && typeof side['team'] === 'string' ? side['team'] : (ENGAGEMENT_TEAMS[index] ?? '')));
    return {
      engagement: {
        center,
        heading: normalizeHeading(Number(operation['heading'] ?? 0)),
        range: Number(args['range'] ?? DEFAULT_ENGAGEMENT_RANGE),
        sides: teams.map((team) => {
          const ships = added.filter((ship) => ship.team === team);
          const fleet = newFleets.find((candidate) => ships.some((ship) => ship.id === candidate.commander));
          const lead = ships.find((ship) => ship.id === fleet?.commander) ?? ships[0];
          return { team, ...(fleet ? { fleet: fleet.id, commander: fleet.commander } : {}), ships: ships.map((ship) => ship.id), lead: lead ? { id: lead.id, position: lead.position, heading: lead.rotation[0] } : null };
        })
      },
      hulls,
      ...(propMods.length ? { propMods } : {}),
      ...applied.rest,
      warnings: [...warnings, ...applied.warnings]
    };
  }

  /**
   * The document to build on: the passed `scene`, else the tab's (empty before any load).
   *
   * @param args - The tool's arguments.
   * @returns The normalized document and whether a tab holds it.
   */
  private async Before(args: ToolArgs): Promise<StagingBefore> {
    let before: StagingBefore;
    if (args['scene'] != null) before = { scene: normalizeScene(args['scene']).scene, live: false };
    else if (this.page.Connected()) before = { scene: normalizeScene((await this.page.Call('get_scene')) ?? createEmptyScene()).scene, live: true };
    else throw new ToolError(`${this.page.NotConnected().message} Or pass "scene" to build a document without a tab.`);
    return before;
  }

  /**
   * Applies the operation to the passed scene, or forwards it to the tab as one patch_scene.
   *
   * @param before - The document built on.
   * @param operation - The pure operation.
   * @returns The resulting document, the operation's warnings and the rest of the patch result.
   */
  private async Apply(before: StagingBefore, operation: Record<string, unknown>): Promise<Applied> {
    let applied: Applied;
    if (!before.live) {
      const { scene, warnings } = applySceneOperations(before.scene, [operation]);
      applied = { scene, warnings, rest: { scene, loaded: false } };
    } else {
      const patched = (await this.page.Call('patch_scene', { operations: [operation] })) as Record<string, unknown> & { readonly scene?: SceneDocument; readonly warnings?: string[] };
      applied = { scene: patched.scene ?? null, warnings: patched.warnings ?? [], rest: Without(patched, ['warnings']) };
    }
    return applied;
  }

  /**
   * Fills each line's missing dna and radius (and role when needed) from the EVE data, one lookup per distinct hull.
   *
   * @param lines - The candidate lines.
   * @param options - Whether a missing role is inferred from the hull's EVE group.
   * @param options.roleNeeded - Infer it.
   * @returns The filled copies, a report per hull, problems and warnings.
   */
  private async ResolveLines(lines: readonly Record<string, unknown>[], options: { readonly roleNeeded: boolean }): Promise<ResolvedStagingLines> {
    const filled = lines.map((line) => ({ ...line }));
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const line of filled) {
      const key = line['hull'] != null ? `hull:${String(line['hull']).toLowerCase()}` : `dna:${String(line['dna'] ?? '').toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    const resolved: ResolvedStagingLines = { lines: filled, hulls: [], problems: [], warnings: [] };
    await Promise.all(
      [...groups.values()].map(async (group) => {
        const [first] = group;
        const needed = group.some((line) => line['dna'] == null || line['radius'] == null || (options.roleNeeded && line['role'] == null) || (typeof line['hull'] === 'number' && line['name'] == null));
        const hullType = first['hull'] as Maybe<string | number>;
        const lookup = needed
          ? await this.shipData.Hull({ type: hullType ?? null, dna: (first['dna'] as Maybe<string>) ?? null }).then(
              (hull) => ({ hull }),
              (error: unknown) => ({ failure: ErrorMessage(error) })
            )
          : null;
        FillLineGroup(group, { lookup, roleNeeded: options.roleNeeded, resolved });
      })
    );
    return { ...resolved, warnings: [...new Set(resolved.warnings)] };
  }

  /**
   * The EVE radius of each ship, by distinct type or dna; a failed lookup leaves no radius and warns once.
   *
   * @param ids - The ships.
   * @param scene - The document holding them.
   * @returns The radii by ship id, and the warnings.
   */
  private async ResolveRadii(ids: readonly string[], scene: SceneDocument): Promise<{ readonly radii: Record<string, number>; readonly warnings: string[] }> {
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
   * Resolves `near: { ship | celestial, range?, direction? }` to the lead's scene position.
   *
   * @param near - The candidate.
   * @param context - The document and the lead's radius.
   * @param context.before - The document.
   * @param context.leadRadius - The lead's EVE radius (0 for an engagement centre).
   * @returns The place.
   */
  private async ResolvePlace(near: unknown, context: { readonly before: SceneDocument; readonly leadRadius: number }): Promise<ResolvedPlace> {
    const { before, leadRadius } = context;
    if (!IsRecord(near)) throw new ToolError('near must be an object { ship | celestial, range?, direction? }');
    const problems: string[] = [];
    const direction = near['direction'] == null ? null : readNearDirection(near['direction'], 'near.direction', problems);
    const range = near['range'] == null ? null : Number(near['range']);
    if (range != null && !(Number.isFinite(range) && range >= 0)) problems.push('near.range must be a finite number of metres, 0 or more');
    ThrowProblems(problems);

    let place: ResolvedPlace;
    if (near['ship'] != null && near['celestial'] != null) {
      throw new ToolError('near takes ship or celestial, not both');
    } else if (near['ship'] != null) {
      const ship = before.ships.find((candidate) => candidate.id === near['ship']);
      if (!ship) throw new ToolError(`near.ship: no ship "${String(near['ship'])}" in the scene`);
      const { radii } = await this.ResolveRadii([ship.id], before);
      const placed = toNearShipPoint({ ship, shipRadius: radii[ship.id] ?? 0, leadRadius, range, direction, locationOrigin: before.location?.origin ?? null, where: 'near' });
      ThrowProblems(placed.problems);
      place = { position: placed.point as SceneVector, heading: placed.heading, reference: ship.position };
    } else if (near['celestial'] != null) {
      place = await this.PlaceOffCelestial({ celestial: near['celestial'], range, direction, leadRadius, location: before.location ?? null });
    } else {
      throw new ToolError('near needs ship (a ship id) or celestial (a celestial of the scene location, by name or id)');
    }
    return place;
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
    const point = placement.origin as SceneVector;
    return { position: ToScene(point, location), heading: null, reference: ToScene(celestial.position, location) };
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

  /**
   * `facing`: `{ celestial }` becomes its scene point; a point or a ship id passes through.
   *
   * @param facing - The candidate.
   * @param before - The document.
   * @returns The facing for the operation.
   */
  private async ResolveFacing(facing: unknown, before: SceneDocument): Promise<unknown> {
    let resolved = facing;
    if (IsRecord(facing)) {
      if (facing['celestial'] == null) throw new ToolError('facing must be [x, y, z], a ship id or { celestial }');
      if (!before.location) throw new ToolError('facing.celestial: the scene has no location; set_location first');
      resolved = ToScene((await this.ResolveCelestial(facing['celestial'], before.location)).position, before.location);
    }
    return resolved;
  }

  /**
   * One engagement side with its composition or ship lines resolved.
   *
   * @param side - The side as given.
   * @param context - Its index and where reports go.
   * @returns The side for the operation.
   */
  private async ResolveSide(side: Record<string, unknown>, context: { readonly index: number; readonly hulls: (CompositionHullReport | StagingHullReport)[]; readonly propMods: CompositionPropModReport[]; readonly warnings: string[] }): Promise<Record<string, unknown>> {
    const { hulls, propMods, warnings } = context;
    const resolved: Record<string, unknown> = { ...side };
    if (side['composition'] != null && side['ships'] == null) {
      const composition = typeof side['composition'] === 'string' ? ((await this.compositions.get({ name: side['composition'] })) as { readonly composition: FleetComposition }).composition : requireFleetComposition(side['composition']);
      const [filled, mods] = await Promise.all([resolveCompositionHulls({ composition, shipData: this.shipData }), resolveCompositionPropMods({ composition, shipData: this.shipData })]);
      ThrowProblems(filled.problems);
      hulls.push(...filled.hulls);
      propMods.push(...mods.propMods);
      warnings.push(...filled.warnings, ...mods.warnings);
      resolved['composition'] = filled.composition;
    } else if (Array.isArray(side['ships']) && side['composition'] == null) {
      const lines = side['ships'].map((line) => (IsRecord(line) ? line : {}));
      const filled = await this.ResolveLines(lines, { roleNeeded: side['fleet'] !== false });
      ThrowProblems(filled.problems);
      hulls.push(...filled.hulls);
      warnings.push(...filled.warnings);
      resolved['ships'] = filled.lines;
    }
    return resolved;
  }
}

interface FillLineGroupContext {
  readonly lookup: Maybe<{ readonly hull: ResolvedHull } | { readonly failure: string }>;
  readonly roleNeeded: boolean;
  readonly resolved: ResolvedStagingLines;
}

/**
 * Fills one distinct hull's lines from its lookup and reports it.
 *
 * @param group - The lines of one hull.
 * @param context - The lookup, whether roles are inferred, and the result to fill.
 */
function FillLineGroup(group: Record<string, unknown>[], context: FillLineGroupContext): void {
  const { lookup, roleNeeded, resolved } = context;
  const [first] = group;
  const label = String(first['hull'] ?? first['dna'] ?? 'ship');
  const hull = lookup && 'hull' in lookup ? lookup.hull : null;
  const dnaMissing = group.some((line) => line['dna'] == null);
  let failure = lookup && 'failure' in lookup ? lookup.failure : null;
  if (hull && !hull.dna && dnaMissing) failure = `the EVE data has no DNA for type ${hull.typeID}`;
  if (failure && dnaMissing) {
    resolved.problems.push(`hull "${label}" has no dna and could not be resolved through tools-core: ${failure}`);
    return;
  }
  if (failure) resolved.warnings.push(`hull "${label}" could not be looked up through tools-core (${failure}); its radius defaults to ${DEFAULT_FORMATION_RADIUS} m`);
  const sdeRadius = hull?.published.radius ?? null;
  const radiusMissing = group.some((line) => line['radius'] == null);
  for (const line of group) {
    const dna = line['dna'];
    if (hull?.dna && typeof dna === 'string' && SofHull(dna) !== SofHull(hull.dna)) {
      resolved.warnings.push(`hull "${label}" is ${SofHull(hull.dna)} in the EVE data, but its line's dna is ${dna}; the ship looks like ${SofHull(dna)} and flies as ${label}`);
    }
    if (dna == null && hull?.dna) line['dna'] = hull.dna;
    if (line['radius'] == null && sdeRadius != null) line['radius'] = sdeRadius;
    if (hull && typeof line['hull'] === 'string') line['hull'] = hull.name;
    if (hull && typeof line['hull'] === 'number' && line['name'] == null) line['name'] = hull.name;
    if (roleNeeded && line['role'] == null && hull) line['role'] = DefaultSquadRole(hull.group);
  }
  resolved.hulls.push({
    ...(first['hull'] == null ? {} : { hull: first['hull'] as string | number }),
    ...(hull ? { typeID: hull.typeID, name: hull.name, ...(hull.group ? { group: hull.group } : {}) } : {}),
    dna: String(first['dna'] ?? ''),
    radius: Number(first['radius'] ?? DEFAULT_FORMATION_RADIUS),
    dnaFrom: dnaMissing ? 'sde' : 'given',
    radiusFrom: radiusMissing ? (sdeRadius == null ? 'default' : 'sde') : 'given',
    ...(typeof first['role'] === 'string' ? { role: first['role'] as SquadRole } : {})
  });
}

/**
 * The line fields of add_ships' arguments.
 *
 * @param args - The tool's arguments.
 * @returns The line.
 */
function PickLine(args: ToolArgs): Record<string, unknown> {
  const line: Record<string, unknown> = {};
  for (const key of LINE_FIELDS) if (key !== 'propMod' && key !== 'role' && args[key] != null) line[key] = args[key];
  return line;
}

/**
 * The fleet spec with the inferred squad role filled where it is missing: a new fleet's squad, or a new squad.
 *
 * @param fleet - The fleet spec as given.
 * @param context - The inferred role and whether the fleet is new.
 * @param context.role - The role the hull's EVE group gives.
 * @param context.isNew - A new fleet.
 * @returns The spec for the operation.
 */
function FillSquadRole(fleet: Record<string, unknown>, context: { readonly role: Maybe<SquadRole>; readonly isNew: boolean }): Record<string, unknown> {
  const { role, isNew } = context;
  const copy = structuredClone(fleet);
  const squad = copy['squad'];
  if (role && isNew && squad == null) copy['squad'] = { role };
  else if (role && IsRecord(squad) && squad['role'] == null) squad['role'] = role;
  return copy;
}

/**
 * Every ship holding a position in a fleet.
 *
 * @param scene - The document.
 * @param id - The fleet id.
 * @returns The ship ids (none for an unknown fleet).
 */
function FleetShipIds(scene: SceneDocument, id: string): string[] {
  const fleet = scene.fleets?.find((candidate) => candidate.id === id);
  return fleet ? [...toFleetAnchors(fleet).keys()] : [];
}

function AddedShips(before: SceneDocument, after: Maybe<SceneDocument>): SceneDocument['ships'] {
  const old = new Set(before.ships.map((ship) => ship.id));
  return (after?.ships ?? []).filter((ship) => !old.has(ship.id));
}

interface AddedFleetReportInput {
  readonly before: SceneDocument;
  readonly after: Maybe<SceneDocument>;
  readonly added: readonly string[];
  readonly fleet: Record<string, unknown>;
  readonly isNew: boolean;
}

/**
 * The fleet add_ships made or seated the ships in.
 *
 * @param input - The documents, the added ids and the fleet spec.
 * @returns The fleet, the squad, the commander and what was created.
 */
function AddedFleetReport(input: AddedFleetReportInput): Maybe<object> {
  const { before, after, added, fleet: spec, isNew } = input;
  const fleets = after?.fleets ?? [];
  let fleet: Maybe<SceneFleet> = null;
  if (isNew) fleet = fleets.find((candidate) => !(before.fleets ?? []).some((old) => old.id === candidate.id)) ?? null;
  else fleet = fleets.find((candidate) => candidate.id === spec['id']) ?? null;
  const squad = fleet?.wings.flatMap((wing) => wing.squads).find((candidate) => candidate.members.some((member) => added.includes(member)));
  let created: Maybe<'fleet' | 'squad'> = null;
  if (isNew) created = 'fleet';
  else if (IsRecord(spec['squad'])) created = 'squad';
  return fleet ? { id: fleet.id, squad: squad?.id ?? null, commander: fleet.commander, created } : null;
}

/**
 * A system point in scene metres: minus the location's origin, rounded to the metre.
 *
 * @param point - System metres.
 * @param location - The scene's location.
 * @returns Scene metres.
 */
function ToScene(point: SceneVector, location: SceneLocation): SceneVector {
  return [Math.round(point[0] - location.origin[0]) || 0, Math.round(point[1] - location.origin[1]) || 0, Math.round(point[2] - location.origin[2]) || 0];
}

function ThrowProblems(problems: readonly string[]): void {
  if (problems.length) throw new SceneError([...problems]);
}

function IsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function Without(object: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

function SofHull(dna: string): string {
  return dna.split(':')[0].toLowerCase();
}
