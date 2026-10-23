/**
 * The scene-building tools (`add_ships`, `stage_engagement`), answered by the hub. The hub resolves every name first:
 * hull names to SOF DNA and the EVE radius, compositions by name, and (through ScenePlaces) celestials of the scene's
 * location to scene points and the EVE radii of the fleet a ship joins. Then it forwards one pure `add_ships` / `stage_engagement` patch
 * operation to the viewer (or applies it to a passed `scene` with no tab), and reports the ids it created. `warpIn`
 * (add_ships, and each engagement side) rides on the operation; the page's `arrivals` reports come back in the result.
 */

import type { Maybe } from '@dereekb/util';
import {
  DEFAULT_ENGAGEMENT_RANGE,
  DEFAULT_FORMATION_RADIUS,
  ENGAGEMENT_TEAMS,
  type FleetComposition,
  normalizeFleetComposition,
  normalizeHeading,
  readEftHeader,
  type SceneDocument,
  type SceneFleet,
  type SceneVector,
  type SquadRole,
  tangentHeading,
  toFleetAnchors,
  toIdSlug,
  toShipListComposition,
  shipLabel,
  type StagingShipLine
} from '@scene-director/scene';
import { type CompositionHullReport, type CompositionPropModReport, type FleetCompositions, requireFleetComposition, resolveCompositionHulls, resolveCompositionPropMods } from './fleet-compositions';
import type { MapDataApi } from './map-data';
import type { SavedScenesPage } from './saved-scenes';
import { HasWarpInFrom, IsRecord, ScenePlaces, ThrowProblems, Without } from './scene-places';
import type { ResolvedHull, ShipDataApi } from './ship-data';
import { ErrorMessage, type ToolArgs } from './tool-call';

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

const LINE_FIELDS = ['hull', 'dna', 'radius', 'name', 'role', 'propMod', 'fit'] as const;

export class Staging {
  private readonly shipData: ShipDataApi;
  private readonly compositions: Pick<FleetCompositions, 'get'>;
  private readonly places: ScenePlaces;

  constructor({ shipData, mapData, compositions, page }: StagingOptions) {
    this.shipData = shipData;
    this.compositions = compositions;
    this.places = new ScenePlaces({ shipData, mapData, page });
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
    const before = await this.places.Before(args);
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
      const place = args['near'] != null && args['position'] == null ? await this.places.ResolvePlace(args['near'], { before: before.scene, leadRadius: Number(line['radius'] ?? 0) }) : null;
      if (args['position'] != null) operation['position'] = args['position'];
      else if (place) operation['position'] = place.position;
      if (args['heading'] != null) operation['heading'] = args['heading'];
      else if (args['facing'] != null) operation['facing'] = await this.places.ResolveFacing(args['facing'], before.scene);
      else if (place?.heading != null && !HasWarpInFrom(args['warpIn'])) operation['heading'] = place.heading;
      if (args['near'] != null && args['position'] != null) operation['near'] = args['near'];
    }
    if (args['warpIn'] != null) operation['warpIn'] = joins ? args['warpIn'] : await this.places.ResolveWarpIn(args['warpIn'], before.scene);
    if (fleet) operation['fleet'] = FillSquadRole(fleet, { role: (line['role'] as Maybe<SquadRole>) ?? null, isNew });
    const radii = joins && typeof fleet?.['id'] === 'string' ? await this.places.ResolveRadii(FleetShipIds(before.scene, fleet['id']), before.scene) : null;
    if (radii) operation['radii'] = radii.radii;

    const applied = await this.places.Apply(before, [operation]);
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
    const before = await this.places.Before(args);
    const sides = Array.isArray(args['sides']) ? args['sides'] : null;
    const hulls: (CompositionHullReport | StagingHullReport)[] = [];
    const propMods: CompositionPropModReport[] = [];
    const warnings: string[] = [];
    const resolvedSides = sides ? await Promise.all(sides.map((side, index) => (IsRecord(side) ? this.ResolveSide(side, { index, hulls, propMods, warnings }) : side))) : args['sides'];

    const operation: Record<string, unknown> = { op: 'stage_engagement', sides: resolvedSides };
    for (const key of ['range', 'center', 'heading']) if (args[key] != null) operation[key] = args[key];
    let center: SceneVector = Array.isArray(args['center']) ? (args['center'] as SceneVector) : [0, 0, 0];
    if (args['near'] != null && args['center'] == null) {
      const place = await this.places.ResolvePlace(args['near'], { before: before.scene, leadRadius: 0 });
      center = place.position;
      operation['center'] = center;
      if (args['heading'] == null) operation['heading'] = tangentHeading(place.reference, center);
    } else if (args['near'] != null) {
      operation['near'] = args['near'];
    }

    const applied = await this.places.Apply(before, [operation]);
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
   * Fills each line's missing dna and radius (and role when needed) from the EVE data, one lookup per distinct hull.
   *
   * @param lines - The candidate lines.
   * @param options - Whether a missing role is inferred from the hull's EVE group.
   * @param options.roleNeeded - Infer it.
   * @returns The filled copies, a report per hull, problems and warnings.
   */
  private async ResolveLines(lines: readonly Record<string, unknown>[], options: { readonly roleNeeded: boolean }): Promise<ResolvedStagingLines> {
    const filled = lines.map((line): Record<string, unknown> => {
      const fitHull = line['hull'] == null && typeof line['fit'] === 'string' ? readEftHeader(line['fit'])?.hull : null;
      return { ...line, ...(fitHull ? { hull: fitHull } : {}) };
    });
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

function SofHull(dna: string): string {
  return dna.split(':')[0].toLowerCase();
}
